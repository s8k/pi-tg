/**
 * Single-draft LLM mirroring on top of the rich draft (Bot API 10.2).
 *
 * One richMessageDraft carries the whole run: a chronological work log
 * (narration, tool calls with params collapsed and errors visible, user
 * prompts, provider errors), the in-flight message text (the tail), and a
 * bottom line. While working the <tg-thinking> spinner sits below the tail.
 * The clean end is a three-step split: the draft gets the COMPLETED STATE
 * (spinner out, `Completed ✔️` at the end of the work, NO divider, then the
 * answer — the final composed message is visible in the draft), then
 * message 1 persists as the work log + `Completed ✔️` (the answer is CUT —
 * this send also finalizes the draft: per the Bot API any message sent to the
 * chat instantly clears the ephemeral draft, and sendRichMessage has no
 * draft_id), and the answer is sent as message 2 — its own regular
 * richMessage. End state: the tool log is the previous message, the answer
 * the new one. Error ends stay single messages (the `⚠️ error: …` block at
 * the end of the work, the partial answer + `⚠ incomplete` — no `⚠ Error`
 * marker, no divider). An error end does NOT finalize at agent_end: pi
 * auto-retries retryable provider errors (429/5xx/…) after 2 s/4 s/8 s
 * backoffs, and recovery compactions can run — all inside the prompt's
 * continuation loop, all BEFORE agent_settled (verified in pi 0.84.4/0.85.0
 * dist: settled fires in the finally of _runAgentPrompt, after the whole
 * loop). While the stream is open the draft stays alive (heartbeat) with
 * the ⚠️ line, a full-width `---` divider, and the <tg-thinking> spinner
 * below it (pi is still working). When agent_settled arrives with the run
 * still a live error end, the error log is persisted immediately — the
 * stream cannot continue anymore. If a retry's agent_start comes first, it
 * CARRIES OVER the un-persisted work log (the user's successful tool calls
 * are not wiped from the draft; the continued run's final message carries
 * the whole story). The grace timer (cfg `errorSettleMs`, 5 s default) is
 * the backstop only: it persists the log if agent_settled is lost. Each
 * error end re-arms it.
 *
 * (2026-09-04 regression fix: a 502 mid-run used to wipe the live draft —
 * onAgentStart cleared the log unconditionally, so the retried run's first
 * (re-executed, failing) call became the only visible block.)
 *
 * A tool-carrying message commits its text to the log at message_end (the
 * tail clears — the text keeps its place); a stop/length message with no tool
 * calls confirms the run (the tail becomes the answer under the marker).
 * (2026-09-03 flow revision: the old two-draft log/slot design collapsed
 * into one message.)
 *
 * Draft sending is paced and self-limiting (Bot API allows ~1 msg/s per chat
 * and a 429 must never cascade into a request flood):
 *  - at most ONE draft call in flight; later updates
 *    coalesce into a single follow-up with the latest content;
 *  - the success cooldown (streamEditMs) is shared by all senders (stream
 *    updates, tool events, heartbeat) — no bursts in the same second;
 *  - failure cooldown honors the 429 retry_after (streamEditMs otherwise;
 *    a long quiet window for 400s, which cannot heal without new content);
 *  - notifications are state-change only: first failure, one re-note per 5
 *    min while failing, one recovery note.
 *
 * Mute level = fully silent: no drafts, no final messages.
 * Minimal = visible text only: the draft streams narration + answer (no tool
 * or thinking lines), and a clean end finalizes as ONE persistent message
 * instead of the m1/m2 split (see finalize).
 */
import type { Out } from "./session-bridge.ts";
import type { TelegramState } from "./state.ts";
import type { OutputLevel, TelegramConfig } from "./config.ts";
import { RICH_CAP, escapeHtml, renderToolBlock, toolArgsJson, extractWhy, chunkText, type ToolState } from "./markdown.ts";
import { mdToBlocks, foldBlocks, tailBlocks, chunkBlocks, blocksToPlainText, blocksLen, blockCount, type TgBlock } from "./rich-blocks.ts";
import { TgError } from "./telegram-client.ts";

export interface MirrorMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  /** The message's token usage (pi's Usage, projected — input/output only). */
  usage?: { input?: number; output?: number };
}


// ─────────────────────────── Work log model (single draft) ───────────────────────────

/**
 * One committed, chronological block of the work log (message 1). Each block
 * renders on its own lines; `blocksToMd` separates blocks with one blank line.
 */
export type LogBlock =
  | { type: "narration"; text: string } // a demoted message's visible text, verbatim markdown
  | {
      type: "tool";
      id: string; // toolCallId — tool_execution_* events stamp these by id
      name: string;
      argsJson: string;
      why?: string;
      state: ToolState;
      errorText?: string;
    }
  | { type: "prompt"; text: string } // user follow-ups while running (ui_prompt)
  | { type: "agentError"; text: string }; // provider/API failures, in the order they happened

/** The bottom line of the mirror message (its LAST block). */
export type BottomLine =
  | { kind: "thinking"; word: string } // working: <tg-thinking>word…</tg-thinking>
  | { kind: "compact"; status: string } // auto-compact in flight (lane 2): <tg-thinking>status</tg-thinking>
  | { kind: "done" } // clean end: Completed ✔️
  | { kind: "error"; text: string; thinking?: boolean; word?: string } // error end: ⚠️ error: <text> (text pre-escaped; "" → no line); thinking → stream still open (pi may retry): `---` divider + spinner below the ⚠️ line
  | { kind: "aborted" } // stop end: ⚠️ Request was aborted
  | { kind: "paused" }; // dialog segment (pauseForDialog): '⏸️ Paused — answer the dialog below'

/**
 * Render the single mirror message: committed blocks + the in-flight tail
 * (the current message's text) + the bottom line, each separated by one
 * blank line. Layout by bottom kind:
 *  - thinking / compact (while working): [blocks] [tail] [blank line]
 *    <tg-thinking>… ↑<in> ↓<out></tg-thinking> — the spinner (or the
 *    auto-compact status) stays LAST, below the; the run's token usage sits
 *    INSIDE the tag (the rich renderer treats the tag as its own line —
 *    text after the closing tag wraps to the next line, observed live — so
 *    inside is the only same-line placement), below
 *    streaming text; whenever there is any text above it (blocks and/or the
 *    tail), an extra blank line (an NBSP paragraph — a bare `---` right
 *    above the spinner was tried and rejected: it collides with the
 *    <details> handle under tool blocks; the error-end divider below works
 *    because the ⚠️ line sits between the blocks and the line) separates
 *    the two (nothing above the spinner → no blank line).
 *  - error with thinking (error end, stream still open — pi may auto-retry):
 *    [blocks] [tail] [⚠️ line] [---] <tg-thinking>…</tg-thinking> — the
 *    full-width `---` divider separates the ⚠️ line from the spinner (pi is
 *    still working). LIVE-DRAFT ONLY: the finalized message drops the
 *    divider and the spinner (see the error bullet below). (No ⚠️ line — no
 *    errorMessage — → the classic NBSP gap like plain thinking.)
 *  - done (clean end, finalized): [blocks] [Completed ✔️] [tail]
 *    — the marker sits at the end of the work (after the tool blocks), then
 *    the answer. NO divider: the answer is split into its own message anyway,
 *    so the log part needs no horizontal line.
 *  - error / aborted (finalized end states, D3/D4): [blocks]
 *    [tail (+ ⚠ incomplete)] [⚠️ line] — the ⚠️ line is the BOTTOM line
 *    (LAST), never a log-area block: `⚠️ error: <msg>` for error ends,
 *    `⚠️ Request was aborted` for stop ends. The PERSISTENT error message
 *    ends with a `---` when it has content beyond the bare ⚠️ line (the
 *    aborted bottom never gets one). (On a pi retry the carried error
 *    becomes a log block — see Mirror.onAgentStart — and it keeps a `---`
 *    AFTER it whenever content follows, so the retry-window divider does
 *    not vanish when the retry's first block lands.)
 * The SAME builder renders live drafts and the final persistent send, so
 * the finalize transition cannot drift from what the draft showed.
 */
/**
 * Human-readable token count for the usage display: raw below 1k, one-decimal
 * k/m above (trailing .0 dropped) — `567`, `12.5k`, `1.5m`.
 */
export function fmtTokens(n: number): string {
  const f = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (n < 1_000) return String(n);
  if (n < 999_500) return `${f(Math.round((n / 1_000) * 10) / 10)}k`;
  return `${f(Math.round((n / 1_000_000) * 10) / 10)}m`;
}

/**
 * The detail of a compact success string, shared by the manual and auto
 * lanes: `105,414 → 32,876 tokens` (before + after) or `105,414 tokens`
 * (before only — the auto lane falls back to this when the post-compact
 * count cannot be derived). `undefined` = no usable before count → the
 * string carries no detail at all.
 */
export function compactTokenDetail(before?: number, after?: number): string | undefined {
  if (typeof before !== "number" || !Number.isFinite(before)) return undefined;
  const b = before.toLocaleString("en-US");
  return typeof after === "number" && Number.isFinite(after)
    ? `${b} → ${after.toLocaleString("en-US")} tokens`
    : `${b} tokens`;
}

/** The run's usage suffix for a bottom line — ` ↑<in> ↓<out>` — or "" until the first usage arrives. */
function tokensSuffix(t?: { input: number; output: number }): string {
  const i = t?.input ?? 0;
  const o = t?.output ?? 0;
  return i > 0 || o > 0 ? ` ↑${fmtTokens(i)} ↓${fmtTokens(o)}` : "";
}

export function blocksToMd(log: LogBlock[], opts: { tail?: string; bottom: BottomLine; tokens?: { input: number; output: number } }): string {
  const suffix = tokensSuffix(opts.tokens);
  const tail = opts.tail && opts.tail.trim() ? opts.tail : undefined;
  const bottomText = bottomLineText(opts.bottom);
  const parts: string[] = [];
  log.forEach((b, i) => {
    parts.push(b.type === "tool" ? renderToolBlock(b) : b.text);
    // A carried-over ⚠️ error entry (Mirror.onAgentStart moves the failed
    // run's bottom line into the log on a pi retry) keeps the full-width
    // divider AFTER it whenever content follows — new tool blocks, the
    // answer, the spinner, or a bottom line. Without this, the divider the
    // retry window showed (⚠️ → --- → spinner) would vanish the moment the
    // retry's first block lands. The last entry only gets one when something
    // actually renders after it.
    if (b.type === "agentError" && (i < log.length - 1 || Boolean(tail) || bottomText !== "")) parts.push("---");
  });
  if (opts.bottom.kind === "done") {
    parts.push(`Completed ✔️${suffix}`);
    if (tail) parts.push(tail); // no divider — the answer is its own message
    return parts.join("\n\n");
  }
  if (tail) parts.push(tail);
  if (opts.bottom.kind === "error" && opts.bottom.thinking) {
    // Error end, stream still open (pi may auto-retry): the ⚠️ line, then a
    // full-width horizontal line, then the spinner.
    const err = bottomLineText(opts.bottom);
    if (err) parts.push(err);
    if (parts.length > 0) parts.push(err ? "---" : "\u00a0"); // divider after the ⚠️ line; classic gap without one
    parts.push(`<tg-thinking>${opts.bottom.word ?? "Working"}…${suffix}</tg-thinking>`);
    return parts.join("\n\n");
  }
  if (opts.bottom.kind === "thinking" || opts.bottom.kind === "compact") {
    // text above the spinner → an extra blank line (skipped after a divider —
    // the --- already separates, so the spinner sits directly under it, the
    // same layout as the retry window)
    if (parts.length > 0 && parts[parts.length - 1] !== "---") parts.push("\u00a0");
    // The run's tokens go INSIDE the tag (same line — the renderer wraps
    // trailing text below the tag); the label's shimmer covers the numbers
    // too, which is fine: they're live telemetry, not body text.
    const label = opts.bottom.kind === "thinking" ? `${opts.bottom.word}…` : opts.bottom.status;
    parts.push(`<tg-thinking>${label}${suffix}</tg-thinking>`);
    return parts.join("\n\n");
  }
  const bottom = bottomLineText(opts.bottom);
  if (bottom) parts.push(bottom);
  // The PERSISTENT error message ends with a full-width divider — but only
  // when the message has content beyond the bare ⚠️ line (user request: a
  // tool log / partial answer above the error gets closed off from whatever
  // follows in the chat; a bare error stays bare). The ⚠️-aborted bottom
  // never gets one, and a divider without the ⚠️ line would be a stray rule.
  if (opts.bottom.kind === "error" && bottom && parts.length > 1) parts.push("---");
  return parts.join("\n\n");
}

/** One tool log block → blocks: [💭 why] + details(⚙ name state → pre json) [+ pre error]. */
function toolBlocks(b: Extract<LogBlock, { type: "tool" }>): TgBlock[] {
  const out: TgBlock[] = [];
  if (b.why) out.push({ type: "paragraph", text: [`💭 `, { type: "italic", text: `"${b.why}"` }] });
  out.push({
    type: "details",
    summary: `⚙ ${b.name} ${b.state}`,
    blocks: [{ type: "pre", text: b.argsJson, language: "json" }],
    is_open: false,
  });
  if (b.state === "✖" && b.errorText) out.push({ type: "pre", text: b.errorText });
  return out;
}

/**
 * The blocks-tier mirror builder (the TgBlock[] replacement for blocksToMd):
 * committed log blocks + the in-flight tail + the bottom line, in the SAME
 * layout blocksToMd documents. The SAME array feeds live drafts (the
 * `thinking` block stays — it is draft-only) and persistent sends (the
 * caller strips `thinking` + the NBSP gap before sending).
 */
export function mirrorBlocks(log: LogBlock[], opts: { tail?: string; bottom: BottomLine; tokens?: { input: number; output: number } }): TgBlock[] {
  const suffix = tokensSuffix(opts.tokens);
  const tail = opts.tail && opts.tail.trim() ? mdToBlocks(opts.tail) : [];
  const bottom = opts.bottom;
  const parts: TgBlock[] = [];
  const bottomText = bottomLineText(bottom);
  log.forEach((b, i) => {
    if (b.type === "tool") parts.push(...toolBlocks(b));
    else parts.push({ type: "paragraph", text: b.type === "agentError" ? `⚠️ error: ${b.text}` : b.text });
    if (b.type === "agentError" && (i < log.length - 1 || tail.length > 0 || bottomText !== "")) parts.push({ type: "divider" });
  });
  const para = (text: string): TgBlock => ({ type: "paragraph", text });
  if (bottom.kind === "done") {
    parts.push(para(`Completed ✔️${suffix}`));
    parts.push(...tail);
    return parts;
  }
  parts.push(...tail);
  if (bottom.kind === "error" && bottom.thinking) {
    if (bottomText) parts.push(para(bottomText));
    if (parts.length > 0) parts.push(bottomText ? { type: "divider" } : para("\u00a0"));
    parts.push({ type: "thinking", text: `${bottom.word ?? "Working"}…${suffix}` });
    return parts;
  }
  if (bottom.kind === "thinking" || bottom.kind === "compact") {
    if (parts.length > 0 && parts[parts.length - 1]?.type !== "divider") parts.push(para("\u00a0"));
    const label = bottom.kind === "thinking" ? `${bottom.word}…` : bottom.status;
    parts.push({ type: "thinking", text: `${label}${suffix}` });
    return parts;
  }
  if (bottomText) parts.push(para(bottomText));
  if (bottom.kind === "error" && bottomText && parts.length > 1) parts.push({ type: "divider" });
  return parts;
}

export function bottomLineText(bottom: BottomLine): string {
  switch (bottom.kind) {
    case "thinking":
      return `<tg-thinking>${bottom.word}…</tg-thinking>`;
    case "compact":
      return `<tg-thinking>${bottom.status}</tg-thinking>`;
    case "done":
      return "Completed ✔️";
    case "error":
      return bottom.text ? `⚠️ error: ${bottom.text}` : ""; // no message → no line
    case "aborted":
      return "⚠️ Request was aborted";
    case "paused":
      return "⏸️ Paused — answer the dialog below"; // the dialog-segment's bottom line (the dialog message follows)
  }
}

/**
 * The level's render filter over the work log: `full` → all blocks (the SAME
 * array — no copy); `minimal` → visible text only (narration blocks, the TUI
 * white text; tool / prompt / agentError lines are dropped); `mute` → nothing
 * (the pipeline is gated before rendering — this is the defensive total).
 */
export function blocksForLevel(level: OutputLevel, blocks: LogBlock[]): LogBlock[] {
  if (level === "full") return blocks;
  if (level === "minimal") return blocks.filter((b) => b.type === "narration");
  return [];
}

/**
 * Display text of a `tool_execution_end` result: a string passes through,
 * an `AgentToolResult` contributes its text parts (images skipped), anything
 * else is empty (the ✖ block then shows just the ✖ stamp).
 */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const c = (result as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(c))
    return c
      .filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("\n");
  return "";
}

export function assistantText(msg: MirrorMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("");
  return "";
}

/** Random verbs for the working spinner — a new one at most every
 *  THINKING_WORD_MIN_INTERVAL_MS, so the label doesn't flicker. */
export const THINKING_WORDS = [
  "Pondering",
  "Deliberating",
  "Contemplating",
  "Ruminating",
  "Unraveling",
  "Discerning",
  "Envisioning",
  "Navigating",
  "Exploring",
  "Distilling",
  "Synthesizing",
  "Weaving",
  "Sculpting",
  "Harmonizing",
  "Connecting",
  "Awakening",
  "Unfolding",
  "Manifesting",
  "Bridging",
  "Illuminating",
  "Aligning",
  "Gathering",
  "Tracing",
  "Adapting",
  "Focusing",
  "Absorbing",
  "Evolving",
  "Translating",
  "Shaping",
];

/** The thinking word changes at most once per this many ms (no label flicker). */
export const THINKING_WORD_MIN_INTERVAL_MS = 5000;
/** The live draft's bottom line while a pi auto-compact is in flight (C1). */
export const AUTO_COMPACT_STATUS = "🗜 Auto-compacting…";
/** The stamped log line a successful auto-compact appends (C2, without the detail). */
export const AUTO_COMPACT_DONE_TEXT = "🗜 Context auto-compacted ✔️";

/** A 400 means this content is unparseable — quiet long cooldown; the same content cannot heal. */
const DRAFT_400_COOLDOWN_MS = 60_000;
/** While a draft keeps failing, re-notify at most this often (dead channel ≠ silent one). */
const DRAFT_FAIL_RENOTIFY_MS = 300_000;
/** A ✖ block's error text is capped this long AFTER HTML escaping (the <pre> stays readable). */
const TOOL_ERROR_TEXT_CAP = 400;
/** Persistent sends (the final m1/m2) retry up to 3 times with this backoff. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const PERSIST_ATTEMPTS = 3;

/** Cap a raw error text so its HTML-escaped rendering stays within `cap` chars (+1 for the "…"). */
function capText(raw: string, cap: number): string {
  // the blocks tier renders pre text verbatim — the cap is a plain length cap
  // (the HTML-rung escape-budget loop retired with the markdown/html tiers)
  return raw.length <= cap ? raw : raw.slice(0, cap) + "…";
}

export interface MirrorDeps {
  out: Out;
  state: TelegramState;
  cfg: TelegramConfig;
  getChatId(): number | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * Surfaced on draft failure state changes only: first failure (error), a
   * periodic "still failing" note while it persists, and recovery (info).
   */
  notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}

/** A content part of an assistant message (text | thinking | toolCall). */
interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function partsOf(msg: MirrorMessage): ContentPart[] {
  const c = msg.content;
  if (typeof c === "string") return c ? [{ type: "text", text: c }] : [];
  if (Array.isArray(c)) return c as ContentPart[];
  return [];
}

export class Mirror {
  private deps: MirrorDeps;
  // run identity & lifecycle
  private runSeq = 0;
  private phase: "work" | "finalized" = "finalized"; // one-way switch
  // the single draft's content: work log + in-flight tail + bottom line
  private log: LogBlock[] = [];
  private draftId = 0; // the run's single draft id
  /** The in-flight message's text — rendered between the log and the spinner. */
  private tail = "";
  private endKind: "clean" | "stop" | "error" | undefined;
  /**
   * The HTML-escaped errorMessage of the run's error end — its bottom line
   * (D3). NOT a log block: on a pi retry (onAgentStart carryover) it moves
   * into the log as an agentError block, so the retried run's final message
   * carries the whole story.
   */
  private endError: string | undefined;
  /** Lane-2 auto-compact in flight (C1): the bottom line is the status. */
  private autoCompacting = false;
  // Token usage of the CURRENT run (the user's "request"): the committed
  // messages' usage (doneUsage) plus the in-flight message's latest usage
  // (liveUsage). Rendered on the bottom line as ` ↑<in> ↓<out>` (spinner and
  // `Completed ✔️`). Accumulates across pi's auto-retries (a retry carries
  // the run over); reset when a NEW run starts.
  private doneUsage = { input: 0, output: 0 };
  private liveUsage = { input: 0, output: 0 };

  private resetRunUsage(): void {
    this.doneUsage = { input: 0, output: 0 };
    this.liveUsage = { input: 0, output: 0 };
  }

  /** The run's total usage so far (committed + in-flight). */
  private runTokens(): { input: number; output: number } {
    return {
      input: this.doneUsage.input + this.liveUsage.input,
      output: this.doneUsage.output + this.liveUsage.output,
    };
  }
  // pacing
  private nextDraftAt = 0; // earliest time a new draft attempt is allowed (throttle + failure cooldown)
  private forceNext = false; // one-shot: the first send of a new message breaks through the window
  private pending = new Map<number, { content: TgBlock[]; canStop: boolean; run: number }>();
  private inflight: Promise<void> | undefined;
  private drainTimer: unknown;
  // heartbeat
  private hbTimer: unknown;
  // error settle: an error-ended run's log is NOT persisted immediately — pi's
  // auto-retry (2 s backoff) may still be in flight and will CARRY OVER the
  // log (see onAgentStart). This timer is the fallback: if no continuation
  // starts within cfg.errorSettleMs, the log is persisted as the "⚠️ error"
  // message. Armed at every error end, cancelled on carryover / finalization.
  private errorSettleTimer: unknown;
  // thinking word rotation
  private thinkingWord = THINKING_WORDS[0];
  private thinkingWordAt = 0;
  // failure notifications (state-change only)
  private draftFailStreak = 0;
  private draftLastFailNotifyAt = 0;
  // settlement: resolves when the current run's finalization (all persistent
  // sends) has fully completed — or when a NEW run starts (a waiter on the
  // old promise must never hang the bridge behind a stale run)
  private settledPromise: Promise<void> | undefined;
  private settledResolve: (() => void) | undefined;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  /**
   * Resolves once the current run has fully settled: its finalization has
   * run to completion, i.e. every persistent send of the finalized message
   * has been delivered (mute level / no chat / already finalized → immediately).
   * Needed because pi's extension runner does NOT await this mirror's
   * fire-and-forget handlers, so `ctx.waitForIdle()` alone resolves before
   * the finalized message has reached Telegram (a /compact draft sent in
   * between would be cleared by it, breaking the abort-error-before-draft
   * ordering).
   */
  whenSettled(): Promise<void> {
    return this.settledPromise ?? Promise.resolve();
  }

  private markSettled(): void {
    this.settledResolve?.();
    this.settledResolve = undefined;
  }

  // ───────────────────────────── run lifecycle ─────────────────────────────

  onAgentStart(): void {
    this.runSeq++;
    // Retry carryover: pi auto-retries retryable provider errors (429/5xx/…) —
    // the continuation's agent_start arrives while the failed run's log is
    // still live (never persisted: error ends skip finalization). CARRY the
    // log over instead of wiping it: the user has been watching those tool
    // calls in the draft, and the continued run's final message must carry
    // the whole story (old blocks → ⚠️ error → retried blocks → marker).
    // The grace timer (armed at the error end) is cancelled — nothing is
    // persisted separately.
    const carryOver = this.phase === "work" && this.endKind === "error";
    this.clearErrorSettle();
    if (carryOver) {
      // The failed run's bottom-line error becomes a LOG block: the retried
      // run's final message must carry the whole story
      // (old blocks → ⚠️ error → new blocks → marker).
      if (this.endError) this.log.push({ type: "agentError", text: `⚠️ error: ${this.endError}` });
    } else if (this.phase !== "work" || this.draftId === 0) {
      // Stale state (a finalized run keeps its old log around) must not leak
      // into the new run. The ONE exception: the live EARLY DRAFT (T6,
      // onPromptAccepted) — no run has ended yet (endKind undefined) and its
      // log holds the auto-compact narration of THIS pending run, already
      // visible in the draft the user has been watching.
      this.log = [];
      this.resetRunUsage();
    }
    this.tail = "";
    this.endKind = undefined;
    this.endError = undefined;
    this.autoCompacting = false;
    this.nextDraftAt = 0;
    this.forceNext = false;
    this.pending.clear(); // a stale in-flight update from a prior run may settle later; it is gen-guarded
    this.draftFailStreak = 0;
    this.draftLastFailNotifyAt = 0;
    // A new run starts: release any waiter left on the previous run's promise
    // (its finalization, if still in flight, can no longer guarantee the
    // ordering the waiter cares about — a new run already intervened).
    this.markSettled();
    this.settledPromise = new Promise<void>((resolve) => {
      this.settledResolve = resolve;
    });
    this.phase = "work";
    this.startRunDraft();
  }

  /**
   * Spawn the run's draft (spinner) — or no-op when there is nothing to
   * spawn: mute level / not paired yet / a draft is ALREADY live. That last case
   * is the early draft (onPromptAccepted) being taken over by agent_start
   * (same draft id, no second spawn) — or the retry continuation taking over
   * the live error-end draft.
   */
  private startRunDraft(): void {
    if (this.draftId !== 0) return; // a draft is already live (takeover: early draft / retry continuation) — no second send
    if (!this.ensureDraft()) return;
    this.requestUpdate();
  }

  /**
   * Ensure the run's draft exists, spawning it when missing. false = nothing
   * to spawn (no live run / mute level / chat not paired yet). STABLE draft
   * id (always 1): one draft stream per chat. Telegram clients follow a
   * single draft per chat and do not reliably pick up a NEW draft id from a
   * later run (live-verified: a per-run id 1..7 was invisible while a probe
   * on a different id rendered). Reusing id 1 re-creates the draft — clients
   * re-follow it (verified with a re-sent probe). Also the post-dialog
   * re-spawn path: pauseForDialog retires the draft, and the next content
   * event's requestUpdate re-spawns it — the fresh draft lands BELOW the
   * stamped dialog (live-verified on PC + Android, probe 2026-09-27).
   */
  private ensureDraft(): boolean {
    if (this.draftId !== 0) return true; // a draft is already live for this run — reuse it
    if (this.phase !== "work") return false;
    if (this.deps.cfg.level === "mute" || this.deps.getChatId() === undefined) return false;
    this.draftId = 1;
    this.armHeartbeat();
    return true;
  }

  /**
   * The owner chat just became known mid-run (index.ts learn path — e.g. a
   * fresh generation after /reload started a run from a TUI prompt before any
   * owner Telegram message arrived). If the run is live but its draft was
   * never spawned (startRunDraft early-returned on the unknown chat), spawn
   * it NOW with the content accumulated so far. No-op otherwise: no live run,
   * a draft already exists, or the chat is still unknown.
   */
  onChatLearned(): void {
    if (this.phase !== "work") return;
    this.startRunDraft();
  }

  /**
   * The owner's prompt was accepted and dispatched (bridge, BEFORE pi's
   * agent_start): the run's draft (spinner) goes out immediately — the user
   * sees "working" without waiting for the model's first event. A steer into
   * a live run (phase work) is a no-op: that run already owns its draft.
   */
  onPromptAccepted(): void {
    if (this.phase === "work") return; // steer: the live run already owns its draft
    this.log = [];
    this.resetRunUsage();
    this.tail = "";
    this.endKind = undefined;
    this.endError = undefined;
    this.autoCompacting = false;
    this.nextDraftAt = 0;
    this.forceNext = false;
    this.pending.clear();
    this.clearErrorSettle();
    this.draftFailStreak = 0;
    this.draftLastFailNotifyAt = 0;
    // A new run is coming: release waiters left on the previous promise and
    // arm a fresh settlement promise (same contract as onAgentStart).
    this.markSettled();
    this.settledPromise = new Promise<void>((resolve) => {
      this.settledResolve = resolve;
    });
    this.phase = "work";
    this.draftId = 0; // force startRunDraft to spawn a fresh draft id
    this.startRunDraft();
  }

  // ─────────────────────────── message stream ───────────────────────────

  onAssistantStart(msg: MirrorMessage): void {
    if (msg.role !== "assistant" || this.phase !== "work") return;
    this.tail = ""; // a new message's text accumulates from its parts
    this.liveUsage = { input: 0, output: 0 }; // a new message's usage starts over
    // The first send of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    // A flag, not a nextDraftAt reset: a reset would be stomped by an
    // in-flight draft call completing in the same tick.
    this.forceNext = true;
    // Post-dialog re-spawn: pauseForDialog retired the draft — bring it back
    // NOW, at the moment the model starts a new message, with the spinner.
    // Waiting for the first visible text delta would leave the phone blind on
    // thinking-only / tool-only openings (the user asked: the spinner should
    // appear as soon as the model starts outputting).
    if (this.draftId === 0) this.requestUpdate();
  }

  onAssistantUpdate(msg: MirrorMessage): void {
    if (msg.role !== "assistant" || this.phase !== "work") return;
    const parts = partsOf(msg);
    let text = "";
    for (const p of parts) {
      if (p.type === "text") text += p.text ?? "";
    }
    // toolCall parts are ignored here: they carry no visible text, and the
    // commit at message_end is what moves the text into the log — a toolCall
    // chunk mid-stream must NOT wipe the tail (that was the old flicker).
    this.tail = text;
    // The in-flight message's usage (grows with the stream): the bottom
    // line's ` ↑<in> ↓<out>` refreshes on every change — INCLUDING textless
    // updates (pure thinking streams report tokens without visible text).
    let usageChanged = false;
    const u = msg.usage;
    if (u && (u.input !== this.liveUsage.input || u.output !== this.liveUsage.output)) {
      this.liveUsage = { input: u.input ?? 0, output: u.output ?? 0 };
      usageChanged = true;
    }
    if (text.trim() || usageChanged) this.requestUpdate();
  }

  /**
   * Commits the message to the work log (narration, tool blocks, error block)
   * and — when the message is the final answer — confirms it. The commit
   * runs synchronously (no awaits), so it completes before any
   * tool_execution_* handler of this message can start.
   */
  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant" || this.phase !== "work") return;
    // Commit this message's FINAL usage to the run's total (the in-flight
    // counter restarts with the next message). A message that died mid-stream
    // contributes its partial usage — the best number we have.
    const u = msg.usage;
    if (u) {
      this.doneUsage = { input: this.doneUsage.input + (u.input ?? 0), output: this.doneUsage.output + (u.output ?? 0) };
      this.liveUsage = { input: 0, output: 0 };
    }
    const parts = partsOf(msg);
    let thinkingSoFar: string[] = [];
    let narration: string[] = [];
    const flush = (): void => {
      const t = narration.join("");
      if (t.trim()) this.log.push({ type: "narration", text: t });
      narration = [];
    };
    let toolCount = 0;
    for (const p of parts) {
      if (p.type === "thinking") {
        if (!p.redacted) thinkingSoFar.push(p.thinking ?? "");
      } else if (p.type === "text") {
        narration.push(p.text ?? "");
      } else if (p.type === "toolCall") {
        toolCount++;
        flush(); // the text before a tool call is its narration
        this.log.push({
          type: "tool",
          id: p.id ?? `t${toolCount}`,
          name: p.name ?? "tool",
          argsJson: toolArgsJson(p.arguments),
          why: extractWhy(thinkingSoFar),
          state: "…",
        });
      }
    }
    const textAll = narration.join("");
    // Confirm = the run's answer is this message: stopReason stop/length AND
    // no tool calls. A "length" stop WITH tool calls does NOT confirm — pi
    // fails those calls ("arguments may be truncated") and the loop
    // continues, so the answer is whatever confirms later.
    if ((msg.stopReason === "stop" || msg.stopReason === "length") && toolCount === 0) {
      this.tail = textAll; // the confirmed answer — under the marker at finalization
      this.endKind = "clean";
      await this.finalize();
      return;
    }
    const endKind =
      msg.stopReason === "aborted"
        ? ("stop" as const)
        : msg.stopReason === "error" || msg.errorMessage
          ? ("error" as const)
          : undefined;
    if (endKind && toolCount === 0) {
      // The run ends with a toolless message: its text is the PARTIAL ANSWER
      // — it stays as the tail (rendered above the end's bottom line at
      // finalization), not a log block, so it is not duplicated. The
      // errorMessage is the bottom line (D3) — never a log block.
      if (msg.errorMessage) this.endError = escapeHtml(msg.errorMessage);
      this.endKind = endKind;
      this.tail = textAll;
    } else {
      // Tool-carrying (any stop reason) or mid-run (toolUse, deferred, …):
      // the text becomes a log block — the tail clears, the text keeps its
      // place at the end of the log. A tool-carrying error end's message is
      // likewise the bottom line, not a log block.
      flush();
      if (msg.errorMessage) this.endError = escapeHtml(msg.errorMessage);
      if (endKind) this.endKind = endKind;
      this.tail = "";
    }
    this.requestUpdate();
  }

  // ───────────────────────────── tool events ─────────────────────────────

  onToolStart(_toolCallId: string, _tool: string, _args: unknown): void {
    // The block was committed (state "…") at message_end; the start event
    // only guards ordering — no visible change, no draft update.
  }

  onToolEnd(toolCallId: string, isError: boolean, result: unknown): void {
    if (this.phase !== "work") return;
    let changed = false;
    for (const b of this.log) {
      if (b.type !== "tool" || b.id !== toolCallId) continue;
      b.state = isError ? "✖" : "✔";
      if (isError) {
        const t = toolResultText(result);
        b.errorText = t ? capText(t, TOOL_ERROR_TEXT_CAP) : undefined;
      }
      changed = true;
      break;
    }
    if (changed) this.requestUpdate();
  }

  onUiPromptStart(title?: string): void {
    if (this.phase !== "work") return;
    this.log.push({ type: "prompt", text: `⚠️ terminal prompt${title ? `: ${escapeHtml(title)}` : ""} — answer there` });
    this.requestUpdate();
  }

  // ─────────────────────── lane-2 auto-compact (C1/C2/C3) ───────────────────────

  /**
   * Lane selection (index.ts, session_before_compact auto): does this mirror
   * currently own a LIVE draft? true → the auto-compact renders INSIDE the
   * run's draft (lane 2); false → the bridge posts a standalone draft
   * (lane 1).
   */
  hasLiveDraft(): boolean {
    return this.phase === "work" && this.draftId !== 0;
  }

  /**
   * pi auto-compaction STARTED (session_before_compact, auto) while the
   * draft is live: the bottom line swaps to the C1 status and the error
   * grace is SUSPENDED — the draft must not persist mid-compact (the
   * overflow-with-retry continuation is still coming). No-op when there is
   * no live draft (lane 1 owns the messaging).
   */
  onAutoCompactStart(): void {
    if (!this.hasLiveDraft()) return;
    this.clearErrorSettle();
    this.autoCompacting = true;
    this.requestUpdate();
  }

  /**
   * pi auto-compaction SUCCEEDED (session_compact, auto): the stamped line
   * joins the work log (the (retried) run's final message carries it), the
   * spinner returns, and the error grace is re-armed if the run is still an
   * error end. No-op when lane 1 owns the messaging.
   */
  onAutoCompactDone(detail?: string): void {
    if (!this.autoCompacting) return;
    this.autoCompacting = false;
    this.log.push({ type: "narration", text: detail ? `${AUTO_COMPACT_DONE_TEXT} ${detail}` : AUTO_COMPACT_DONE_TEXT });
    if (this.endKind === "error") this.armErrorSettle();
    this.requestUpdate();
  }

  /**
   * A LANE-1 auto-compaction ended (index.ts, session_compact /
   * session_compact_failed, bridge lane — no live draft when it started):
   * the bridge owns the compact's messaging (standalone draft + persistent
   * stamp), but if the run is live and its draft is dead (retired by a
   * dialog segment), respawn the spinner NOW — otherwise the phone sits
   * blind from compact-end until the model's next message_start (prefill
   * takes seconds on a local LLM — live report 2026-09-27; the post-dialog
   * respawn is the contract). No log line: the bridge's persistent stamp is
   * the record (no duplication). Must be called AFTER the bridge's
   * persistent send — any message sent to the chat clears the ephemeral
   * draft, so a spinner sent first would be wiped.
   */
  onLane1CompactDone(): void {
    if (this.phase !== "work" || this.draftId !== 0) return;
    this.requestUpdate(); // ensureDraft spawns the spinner draft
  }

  /**
   * pi auto-compaction FAILED (session_compact_failed, auto): the draft
   * reverts to its prior state (spinner / error line). The ⚠️ notification
   * is the caller's job (index.ts — the live draft carries on, C3). The
   * error grace is re-armed if the run is still an error end.
   */
  onAutoCompactFailed(): void {
    if (!this.autoCompacting) return;
    this.autoCompacting = false;
    if (this.endKind === "error") this.armErrorSettle();
    this.requestUpdate();
  }

  // ───────────────────────────── end of run ─────────────────────────────

  async onAgentEnd(_messages: MirrorMessage[]): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    // A run that ended in an error is NOT the end of the STREAM: pi
    // auto-retries retryable provider errors (429/5xx/…) after a backoff and
    // recovery compactions can run — all before agent_settled (which marks
    // the end of the whole stream). Do NOT finalize here: no persistent
    // error message, the draft stays alive (heartbeat) showing ⚠️ line →
    // `---` divider → spinner. Final persistence happens at agent_settled
    // (onAgentSettled); the grace timer (armErrorSettle) is the backstop if
    // settled is lost. An auto-retry that arrives first carries the log
    // over (onAgentStart).
    if (this.endKind === "error") {
      this.armErrorSettle();
      return;
    }
    if (this.endKind === undefined) this.endKind = "stop"; // e.g. the run produced no assistant message
    await this.finalize();
  }

  /**
   * The end of the STREAM (pi's `agent_settled`): the whole prompt stream is
   * over — every auto-retry (including its backoff delays), recovery
   * compaction and queued continuation has completed (verified in pi
   * 0.84.4/0.85.0: it fires in the finally of _runAgentPrompt, after the
   * continuation loop). Clean/stop ends are already finalized (at the
   * confirming message_end / agent_end) — this is a no-op for them. A live
   * error end finalizes NOW: the stream cannot continue anymore, so the
   * error log is the final word (a retry that came first already carried
   * the log over and finalized as its own run — no double-post). The grace
   * timer remains the backstop only: it fires if agent_settled is lost (a
   * pi flush threw before the finally emitted it).
   */
  async onAgentSettled(): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    if (this.endKind === undefined) this.endKind = "stop"; // e.g. the run produced no assistant message
    await this.finalize();
  }

  /**
   * Finalize the run (one-way). The clean end is a three-step split:
   *  1) the draft gets the COMPLETED STATE — [log] Completed ✔️ --- [answer]:
   *     the final composed message is visible in the draft (the spinner is
   *     replaced by the marker + divider, the answer stays where it was
   *     streaming);
   *  2) message 1 — the work log + Completed ✔️ as a regular richMessage; the
   *     answer is CUT from it. This send also finalizes the draft: per the
   *     Bot API any message sent to the chat instantly clears the ephemeral
   *     draft (sendRichMessage has no draft_id — no in-place promotion);
   *  3) message 2 — the final answer, as its own regular richMessage.
   * End state: the tool log is the previous message, the answer is the new
   * one. Stop/error ends stay a single message. Every persistent send gets
   * chunking, the rich → HTML → plain fallback, and 3 attempts with backoff.
   * Levels: mute = fully silent (nothing at all); minimal = the 3-step split
   * never runs — ONE persistent message (filtered blocks + tail + bottom
   * line), same notification rules; full = the 3-step split above.
   */
  private async finalize(): Promise<void> {
    if (this.phase === "finalized") return;
    this.phase = "finalized";
    this.stopHeartbeat();
    this.clearErrorSettle(); // a finalization supersedes the pending error persistence
    this.pending.clear(); // no further draft updates follow the run
    // THIS run's resolver, captured: if a new run starts while our finalization
    // is still in flight, onAgentStart swaps the promise — our late `finally`
    // must release only our own waiters, not the new run's.
    const settle = this.settledResolve;
    try {
      if (this.deps.cfg.level === "mute") return;
      const chatId = this.deps.getChatId();
      if (chatId === undefined) return;
      const bottom: BottomLine =
        this.endKind === "clean"
          ? { kind: "done" }
          : this.endKind === "error"
            ? { kind: "error", text: this.endError ?? "" }
            : { kind: "aborted" };
      if (this.endKind === "clean" && this.tail.trim() && this.deps.cfg.level === "full") {
        // step 1 — the completed state in the draft. Awaited so the client sees
        // it before step 2 replaces the draft. Best effort: runDraftOnce
        // swallows failures (429/400) — the persistent messages still go out.
        if (this.draftId)
          await this.runDraftOnce(this.draftId, this.draftContent(bottom), false /* no Stop button — the run is over */);
        // step 2 — m1: the work log + the Completed marker (the answer is cut).
        // SILENT: the notification belongs to the final answer (m2) only.
        await this.sendPersistent(chatId, mirrorBlocks(this.log, { bottom, tokens: this.runTokens() }), { disableNotification: true });
        // step 3 — m2: the final answer, its own message — the only send that notifies.
        await this.sendPersistent(chatId, mdToBlocks(this.tail));
        return;
      }
      // minimal (or a clean end with no answer) = ONE persistent message:
      // filtered blocks + tail + the end's bottom line. Same mechanics and
      // notification rules as full — only the block filter changes by level.
      const log = blocksForLevel(this.deps.cfg.level, this.log);
      const tail = this.endKind === "error" && this.tail.trim() ? `${this.tail.trimEnd()}\n\n⚠ incomplete` : this.tail;
      const blocks = mirrorBlocks(log, { tail, bottom, tokens: this.runTokens() }); // full content — chunked, never tail-capped
      if (blocks.length > 0)
        // D4: a stop end's message is SILENT (no notification) — an error end
        // notifies (the error is the final word the user must see).
        await this.sendPersistent(chatId, blocks, { disableNotification: this.endKind === "stop" });
    } finally {
      // Every exit path (mute level, no chat, sends done, sends threw after all
      // retries) releases the settlement waiters — a hung promise would hang
      // the bridge's poll loop forever.
      settle?.();
      this.draftId = 0; // no live draft anymore — the next run gets a fresh id
    }
  }

  /**
   * One persistent send: fold long fences, chunk at the cap (the single
   * finalized message can exceed the cap; the draft is capped, the final
   * message is not), send as blocks-tier rich messages. On a 400 (the server
   * rejected the blocks — the same content cannot heal), the UNDELIVERED tail
   * (the chunk that 400'd and everything after it) is re-sent as plain text —
   * chunks that already landed are never re-sent (duplication). A 400 that
   * survives the plain rung rethrows without retrying. The `thinking` block is
   * draft-only and never reaches this path (finalization builds with a
   * non-thinking bottom).
   */
  private async deliverOnce(chatId: number, blocks: TgBlock[], opts?: { disableNotification?: boolean }): Promise<void> {
    // the silence flag survives the rich → plain fallback chain
    const silence = opts?.disableNotification ? { disableNotification: true } : undefined;
    const { out } = this.deps;
    const folded = foldBlocks(blocks, this.deps.cfg.codeFoldLines);
    const pieces = blocksLen(folded) <= RICH_CAP && blockCount(folded) <= 480 ? [folded] : chunkBlocks(folded);
    let i = 0;
    try {
      for (; i < pieces.length; i++) await out.sendRich(chatId, pieces[i]!, silence);
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    // chunks 0..i-1 already landed — re-send ONLY i..end as plain text
    for (const chunk of chunkText(blocksToPlainText(pieces.slice(i).flat()))) await out.send(chatId, chunk, { parseMode: null, ...silence });
  }

  /** Up to PERSIST_ATTEMPTS with 1s/2s/4s backoff, honoring a 429's retry_after. */
  private async sendPersistent(chatId: number, blocks: TgBlock[], opts?: { disableNotification?: boolean }): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const retryAfter = lastErr instanceof TgError ? lastErr.retryAfter : undefined;
        const delay = Math.max(RETRY_BACKOFF_MS[attempt - 2], retryAfter != null ? retryAfter * 1000 : 0);
        await this.sleep(delay);
      }
      try {
        await this.deliverOnce(chatId, blocks, opts);
        return;
      } catch (err) {
        lastErr = err;
        if (err instanceof TgError && err.code === 400) throw err; // all levels failed to parse — retrying is pointless
      }
    }
    throw lastErr;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimer(() => resolve(), ms));
  }

  // ─────────────────────────── content builders ───────────────────────────

  /** The single draft's full content: [log] [tail] [bottom line] — the log filtered by the level. */
  private content(bottom?: BottomLine): TgBlock[] {
    const log = blocksForLevel(this.deps.cfg.level, this.log);
    return mirrorBlocks(log, {
      tail: this.tail,
      bottom: bottom ?? this.currentBottom(),
      tokens: this.runTokens(),
    });
  }

  /**
   * The live draft's bottom line: while working → the thinking spinner
   * (auto-compact in flight → its C1 status — it also takes precedence over
   * a live error end: the overflow-recovery compact runs while the error
   * end is open, and the draft must show the compact, not the error line);
   * after a run end → that end's bottom line: an error end still shows the
   * ⚠️ line + divider + spinner (the stream may continue — pi auto-retry;
   * agent_settled is what finalizes it), a stop end the final aborted line.
   */
  private currentBottom(): BottomLine {
    if (this.endKind === "clean") return { kind: "done" };
    if (this.autoCompacting) return { kind: "compact", status: AUTO_COMPACT_STATUS };
    if (this.endKind === "error")
      return { kind: "error", text: this.endError ?? "", thinking: true, word: this.thinkingWordNow() };
    if (this.endKind === "stop") return { kind: "aborted" };
    return { kind: "thinking", word: this.thinkingWordNow() };
  }

  /** The draft's content: fold long fences, then cap for the ephemeral window (the draft has a hard size limit). */
  private draftContent(bottom?: BottomLine): TgBlock[] {
    return tailBlocks(foldBlocks(this.content(bottom), this.deps.cfg.codeFoldLines), RICH_CAP, 480);
  }

  /** Request a single-draft update (latest wins; paced by the shared window). Re-spawns the run's draft when it was retired (dialog pause). */
  private requestUpdate(): void {
    if (!this.ensureDraft()) return;
    this.requestDraftUpdate(this.draftId, this.draftContent(), true);
  }

  /**
   * A mirrored TUI dialog is about to be shown (ui-dialogs' show, BEFORE the
   * dialog message is sent): the live WORKING draft is finalized as a silent
   * persistent segment (blocks + tail, no bottom line), the log is
   * SEGMENTED, and the draft is retired. Why: a draft that predates the
   * dialog keeps its original position while it keeps streaming (above the
   * dialog on PC, below on Android — client-controlled, no Bot API lever:
   * there is no position parameter and no stop-draft method). The segment
   * send clears the ephemeral draft (any message sent to the chat clears it —
   * live-verified), so the dialog message lands right after the segment, and
   * the post-answer continuation streams in the re-spawned draft (same
   * stable id 1) BELOW the stamped dialog. The segment is the pre-dialog
   * part of the run's story; the continuation's final message carries only
   * the post-dialog content (no duplication). Only a purely working draft is
   * segmented (endKind undefined) — an error-end draft has retry-carryover
   * semantics that must not be touched.
   */
  async pauseForDialog(): Promise<void> {
    if (!this.hasLiveDraft() || this.endKind !== undefined) return;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const segment = this.content({ kind: "paused" }); // blocks + tail, no bottom line
    this.log = [];
    this.tail = "";
    this.draftId = 0; // retire — the next content event re-spawns via requestUpdate
    this.pending.clear();
    this.forceNext = true; // the first post-dialog draft send breaks through the stream window
    this.stopHeartbeat();
    this.clearErrorSettle();
    // Settle the draft pipeline BEFORE the segment: a draft update still in
    // flight (or waiting on the drain timer) that would land AFTER the segment
    // revives the draft (same stable id) in its ORIGINAL position — above the
    // dialog that follows (live bug, 2026-09-27). The agent is blocked on the
    // dialog, so no new mirror events can start another draft send meanwhile.
    if (this.drainTimer !== undefined) {
      this.deps.clearTimer(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (this.inflight) await this.inflight;
    if (segment.length > 0) {
      try {
        await this.sendPersistent(chatId, segment, { disableNotification: true }); // this send also clears the draft
      } catch {
        // best effort — the dialog and the continuation work regardless
      }
    }
  }

  // ─────────────────── pacing (shared by both drafts) ───────────────────

  /**
   * Entry point for every draft sender (stream updates, demotions, tool
   * events, heartbeat). Pacing lives here:
   *  - nothing before `nextDraftAt` (stream throttle / failure cooldown) —
      the update is queued and a drain timer fires the pump when the window
      opens;
   *  - at most one call in flight; later requests only replace the queued
   *    content of the same draft (latest wins, no concurrent retry chains).
   */
  private requestDraftUpdate(draftId: number, content: TgBlock[], canStop: boolean): void {
    if (this.deps.cfg.level === "mute" || this.phase !== "work") return;
    if (this.deps.getChatId() === undefined) return;
    this.pending.set(draftId, { content, canStop, run: this.runSeq });
    if (this.deps.now() < this.nextDraftAt && !this.forceNext) {
      this.armDrain();
      return;
    }
    void this.pump();
  }

  private armDrain(): void {
    if (this.drainTimer !== undefined) return;
    const delay = Math.max(0, this.nextDraftAt - this.deps.now());
    this.drainTimer = this.deps.setTimer(() => {
      this.drainTimer = undefined;
      void this.pump();
    }, delay);
  }

  private pump(): Promise<void> {
    if (this.inflight) return this.inflight;
    let self: Promise<void> | undefined;
    const run = (async (): Promise<void> => {
      try {
        for (;;) {
          if (this.deps.now() < this.nextDraftAt && !this.forceNext) {
            this.armDrain(); // the window is closed — the timer resumes the pump
            return;
          }
          for (const [id, e] of [...this.pending.entries()]) {
            if (e.run !== this.runSeq) this.pending.delete(id); // a new run owns the drafts now
          }
          const next = this.pending.entries().next().value as [number, { content: TgBlock[]; canStop: boolean; run: number }] | undefined;
          if (next === undefined) return; // nothing to send — forceNext stays for the real send
          const [draftId, upd] = next;
          this.pending.delete(draftId);
          this.forceNext = false; // consumed by this send
          await this.runDraftOnce(draftId, upd.content, upd.canStop);
        }
      } finally {
        // The body can finish synchronously (the gate branch above has no
        // await) — a direct `this.inflight = undefined` would then run BEFORE
        // the `this.inflight = run` assignment below, and the assignment
        // would leave a settled promise behind: forever truthy, so every later
        // pump() early-returns and the draft pipeline is dead until the run
        // ends. Deferring the clear one microtask fixes the ordering for both
        // the sync and the normal (awaited) completions.
        await Promise.resolve();
        if (self !== undefined && this.inflight === self) this.inflight = undefined;
      }
    })();
    self = run;
    this.inflight = run;
    return run;
  }

  /**
   * One draft send attempt (no phase guard — the pump path is gated by
   * requestDraftUpdate + the pending map, and finalization calls this
   * directly for the completed-state preview, after the one-way switch).
   */
  private async runDraftOnce(draftId: number, content: TgBlock[], canStop: boolean): Promise<void> {
    const { cfg, out } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    try {
      await out.sendDraft(chatId, draftId, content, canStop, true /* keepOnStop: keep the draft when Stop is pressed */);
      this.nextDraftAt = this.deps.now() + cfg.streamEditMs;
      if (this.draftFailStreak > 0) {
        this.deps.notify?.(`draft updates recovered after ${this.draftFailStreak} failure(s)`, "info");
        this.draftFailStreak = 0;
      }
    } catch (err) {
      this.draftFailStreak++;
      if (err instanceof TgError && err.code === 400) {
        // Same content will 400 identically: long quiet cooldown (a content change / next turn re-triggers).
        this.nextDraftAt = this.deps.now() + DRAFT_400_COOLDOWN_MS;
      } else {
        // Honor the 429 retry_after the API told us to wait; never retry sooner than the stream throttle.
        const retryAfter = err instanceof TgError ? err.retryAfter : undefined;
        const cooldown = retryAfter != null ? Math.max(retryAfter * 1000, cfg.streamEditMs) : cfg.streamEditMs;
        this.nextDraftAt = this.deps.now() + cooldown;
      }
      const first = this.draftFailStreak === 1;
      const due = this.deps.now() - this.draftLastFailNotifyAt >= DRAFT_FAIL_RENOTIFY_MS;
      if (first || due) {
        this.deps.notify?.(
          first
            ? `draft updates failing: ${String(err)} — retrying`
            : `draft updates still failing (${this.draftFailStreak}×, last: ${String(err)})`,
          "error",
        );
        this.draftLastFailNotifyAt = this.deps.now();
      }
    }
  }

  // ─────────────────────────── heartbeat & spinner ───────────────────────────

  /**
   * Arm the error-settle grace — the BACKSTOP for a lost agent_settled:
   * if the run is still a live error end after cfg.errorSettleMs, persist
   * the error log. (The primary finalize trigger is agent_settled — it
   * arrives ms after agent_end when no retry comes, and after the last
   * retry's attempt when retries did; this timer covers a missing settled.)
   * Idempotent — one timer at a time.
   */
  private armErrorSettle(): void {
    if (this.errorSettleTimer !== undefined) return;
    this.errorSettleTimer = this.deps.setTimer(() => {
      this.errorSettleTimer = undefined;
      if (this.phase === "work" && this.endKind === "error") void this.finalize();
    }, this.deps.cfg.errorSettleMs);
  }

  private clearErrorSettle(): void {
    if (this.errorSettleTimer !== undefined) {
      this.deps.clearTimer(this.errorSettleTimer);
      this.errorSettleTimer = undefined;
    }
  }

  private armHeartbeat(): void {
    if (this.hbTimer !== undefined) return;
    this.hbTimer = this.deps.setTimer(() => {
      this.hbTimer = undefined;
      if (this.phase !== "work") return;
      this.requestUpdate(); // keeps the ~30 s draft window alive (word may have rotated)
      this.armHeartbeat();
    }, this.deps.cfg.draftHeartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer !== undefined) this.deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
  }

  /** Current spinner word — re-rolls at most every THINKING_WORD_MIN_INTERVAL_MS. */
  private thinkingWordNow(): string {
    const now = this.deps.now();
    if (now - this.thinkingWordAt >= THINKING_WORD_MIN_INTERVAL_MS) {
      this.thinkingWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
      this.thinkingWordAt = now;
    }
    return this.thinkingWord;
  }
}
