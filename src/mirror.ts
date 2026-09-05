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
 * marker, no divider) and are persisted by a settle grace timer (cfg
 * `errorSettleMs`, 5 s default) — never at agent_end, never at
 * agent_settled: pi auto-retries retryable provider errors and emits
 * agent_settled right BEFORE the retry's agent_start (same stream), so an
 * error end does NOT finalize — the draft stays alive, and the retry's run
 * CARRIES OVER the un-persisted work log (the user's successful tool calls
 * are not wiped from the draft; the continued run's final message carries
 * the whole story). Only if no continuation arrives within the grace window
 * is the error log persisted on its own. Each error end re-arms the timer.
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
 * Mute = fully silent: no drafts, no final messages.
 */
import type { Out } from "./session-bridge.ts";
import type { TelegaState } from "./state.ts";
import type { TelegaConfig } from "./config.ts";
import { RICH_CAP, tailView, escapeHtml, renderToolBlock, toolArgsJson, extractWhy, foldLongFences, chunkRich, chunkMarkdown, chunkText, toPlainText, type ToolState } from "./markdown.ts";
import { TgError } from "./telegram-client.ts";

export interface MirrorMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
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
  | { kind: "error"; text: string } // error end: ⚠️ error: <text> (text pre-escaped; "" → no line)
  | { kind: "aborted" }; // stop end: ⚠️ Request was aborted

/**
 * Render the single mirror message: committed blocks + the in-flight tail
 * (the current message's text) + the bottom line, each separated by one
 * blank line. Layout by bottom kind:
 *  - thinking / compact (while working): [blocks] [tail] [blank line] <tg-thinking>…</tg-thinking>
 *    — the spinner (or the auto-compact status) stays LAST, below the
 *    streaming text; whenever there is any text above it (blocks and/or the
 *    tail), an extra blank line (an NBSP paragraph — a horizontal line was
 *    tried and rejected: it collides with the <details> handle under tool
 *    blocks) separates the two (nothing above the spinner → no blank line).
 *  - done (clean end, finalized): [blocks] [Completed ✔️] [tail]
 *    — the marker sits at the end of the work (after the tool blocks), then
 *    the answer. NO divider: the answer is split into its own message anyway,
 *    so the log part needs no horizontal line.
 *  - error / aborted (end states, D3/D4): [blocks] [tail (+ ⚠ incomplete)]
 *    [⚠️ line] — the ⚠️ line is the BOTTOM line (LAST), never a log-area
 *    block: `⚠️ error: <msg>` for error ends, `⚠️ Request was aborted` for
 *    stop ends. (On a pi retry the carried error becomes a log block — see
 *    Mirror.onAgentStart.)
 * The SAME builder renders live drafts and the final persistent send, so
 * the finalize transition cannot drift from what the draft showed.
 */
export function blocksToMd(log: LogBlock[], opts: { tail?: string; bottom: BottomLine }): string {
  const parts = log.map((b) => (b.type === "tool" ? renderToolBlock(b) : b.text));
  const tail = opts.tail && opts.tail.trim() ? opts.tail : undefined;
  if (opts.bottom.kind === "done") {
    parts.push("Completed ✔️");
    if (tail) parts.push(tail); // no divider — the answer is its own message
    return parts.join("\n\n");
  }
  if (tail) parts.push(tail);
  const bottom = bottomLineText(opts.bottom);
  if (bottom) {
    if (parts.length > 0 && (opts.bottom.kind === "thinking" || opts.bottom.kind === "compact")) parts.push("\u00a0"); // text above the spinner → an extra blank line
    parts.push(bottom);
  }
  return parts.join("\n\n");
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
  }
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
function capEscaped(raw: string, cap: number): string {
  let cut = raw;
  let esc = escapeHtml(raw);
  if (esc.length <= cap) return raw;
  while (esc.length > cap) {
    cut = cut.slice(0, Math.max(1, Math.floor((cut.length * cap) / esc.length)));
    esc = escapeHtml(cut);
  }
  return cut + "…";
}

export interface MirrorDeps {
  out: Out;
  state: TelegaState;
  cfg: TelegaConfig;
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
  // pacing
  private nextDraftAt = 0; // earliest time a new draft attempt is allowed (throttle + failure cooldown)
  private forceNext = false; // one-shot: the first send of a new message breaks through the window
  private draftSeq = 0;
  private pending = new Map<number, { content: string; canStop: boolean; run: number }>();
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
   * has been delivered (muted / no chat / already finalized → immediately).
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
   * spawn: muted / not paired yet / a draft is ALREADY live. That last case
   * is the early draft (onPromptAccepted) being taken over by agent_start
   * (same draft id, no second spawn) — or the retry continuation taking over
   * the live error-end draft.
   */
  private startRunDraft(): void {
    if (this.deps.cfg.muted || this.deps.getChatId() === undefined) return;
    if (this.draftId !== 0) return; // a draft is already live for this run — reuse it
    this.draftId = ++this.draftSeq;
    this.requestUpdate();
    this.armHeartbeat();
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
    // The first send of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    // A flag, not a nextDraftAt reset: a reset would be stomped by an
    // in-flight draft call completing in the same tick.
    this.forceNext = true;
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
    if (text.trim()) this.requestUpdate(); // textless candidates never trigger an update
  }

  /**
   * Commits the message to the work log (narration, tool blocks, error block)
   * and — when the message is the final answer — confirms it. The commit
   * runs synchronously (no awaits), so it completes before any
   * tool_execution_* handler of this message can start.
   */
  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant" || this.phase !== "work") return;
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
        b.errorText = t ? capEscaped(t, TOOL_ERROR_TEXT_CAP) : undefined;
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
    this.log.push({ type: "narration", text: detail ? `${AUTO_COMPACT_DONE_TEXT} — ${detail}` : AUTO_COMPACT_DONE_TEXT });
    if (this.endKind === "error") this.armErrorSettle();
    this.requestUpdate();
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
    // A run that ended in an error is NOT the end of the stream: pi
    // auto-retries retryable provider errors (429/5xx/…) — a new agent_start
    // comes after the backoff. Do NOT finalize here: no persistent error
    // message, the draft stays alive (heartbeat) showing the error state.
    // Finalization for error ends is deferred to the grace timer (see
    // onAgentSettled / armErrorSettle): not retryable, or retries exhausted
    // → the timer persists the log; an auto-retry arrives first → it carries
    // the log over.
    if (this.endKind === "error") {
      this.armErrorSettle();
      return;
    }
    if (this.endKind === undefined) this.endKind = "stop"; // e.g. the run produced no assistant message
    await this.finalize();
  }

  /**
   * The end of the STREAM (pi's `agent_settled`): the run has fully settled
   * and no automatic retry, compaction, or queued continuation will run.
   * Clean/stop ends are already finalized (at the confirming message_end /
   * agent_end). Error ends are NOT finalized here: pi emits agent_settled
   * right BEFORE the retry's agent_start (same stream), so persisting now
   * would double-post the blocks the retry carries over — the grace timer
   * (armed at the error end) persists the log if no continuation arrives
   * within cfg.errorSettleMs.
   */
  async onAgentSettled(): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    if (this.endKind === "error") {
      this.armErrorSettle(); // idempotent — the error end already armed it
      return;
    }
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
   * Mute = fully silent: nothing at all.
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
      if (this.deps.cfg.muted) return;
      const chatId = this.deps.getChatId();
      if (chatId === undefined) return;
      const bottom: BottomLine =
        this.endKind === "clean"
          ? { kind: "done" }
          : this.endKind === "error"
            ? { kind: "error", text: this.endError ?? "" }
            : { kind: "aborted" };
      if (this.endKind === "clean" && this.tail.trim()) {
        // step 1 — the completed state in the draft. Awaited so the client sees
        // it before step 2 replaces the draft. Best effort: runDraftOnce
        // swallows failures (429/400) — the persistent messages still go out.
        if (this.draftId)
          await this.runDraftOnce(this.draftId, this.draftContent(bottom), false /* no Stop button — the run is over */);
        // step 2 — m1: the work log + the Completed marker (the answer is cut).
        // SILENT: the notification belongs to the final answer (m2) only.
        await this.sendPersistent(chatId, blocksToMd(this.log, { bottom }), { disableNotification: true });
        // step 3 — m2: the final answer, its own message — the only send that notifies.
        await this.sendPersistent(chatId, this.tail);
        return;
      }
      const tail = this.endKind === "error" && this.tail.trim() ? `${this.tail.trimEnd()}\n\n⚠ incomplete` : this.tail;
      const md = blocksToMd(this.log, { tail, bottom }); // full content — chunked, never tailView-capped
      if (md.trim())
        // D4: a stop end's message is SILENT (no notification) — an error end
        // notifies (the error is the final word the user must see).
        await this.sendPersistent(chatId, md, { disableNotification: this.endKind === "stop" });
    } finally {
      // Every exit path (muted, no chat, sends done, sends threw after all
      // retries) releases the settlement waiters — a hung promise would hang
      // the bridge's poll loop forever.
      settle?.();
      this.draftId = 0; // no live draft anymore — the next run gets a fresh id
    }
  }

  /**
   * One persistent send: fold long fences, chunk at the rich cap (block — the
   * single finalized message can exceed the cap; the draft is capped, the
   * final message is not.
   * boundaries), send as rich messages. On a 400 (parse failure — the same
   * content cannot heal) the WHOLE message is re-sent through the legacy
   * HTML path; on a 400 there, plain text. A 400 that survives all three
   * levels rethrows without retrying.
   */
  private async deliverOnce(chatId: number, md: string, opts?: { disableNotification?: boolean }): Promise<void> {
    // the silence flag survives the rich → HTML → plain fallback chain
    const silence = opts?.disableNotification ? { disableNotification: true } : undefined;
    const { out } = this.deps;
    const folded = foldLongFences(md, this.deps.cfg.codeFoldLines);
    const pieces = folded.length <= RICH_CAP ? [folded] : chunkRich(folded);
    try {
      for (const p of pieces) await out.sendRich(chatId, p, silence);
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    try {
      for (const chunk of chunkMarkdown(md)) await out.send(chatId, chunk, { parseMode: "HTML", ...silence });
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    for (const chunk of chunkText(toPlainText(md))) await out.send(chatId, chunk, { parseMode: null, ...silence });
  }

  /** Up to PERSIST_ATTEMPTS with 1s/2s/4s backoff, honoring a 429's retry_after. */
  private async sendPersistent(chatId: number, md: string, opts?: { disableNotification?: boolean }): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const retryAfter = lastErr instanceof TgError ? lastErr.retryAfter : undefined;
        const delay = Math.max(RETRY_BACKOFF_MS[attempt - 2], retryAfter != null ? retryAfter * 1000 : 0);
        await this.sleep(delay);
      }
      try {
        await this.deliverOnce(chatId, md, opts);
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

  /** The single draft's full content: [log] [tail] [bottom line]. */
  private content(bottom?: BottomLine): string {
    return blocksToMd(this.log, {
      tail: this.tail,
      bottom: bottom ?? this.currentBottom(),
    });
  }

  /**
   * The live draft's bottom line: while working → the thinking spinner
   * (auto-compact in flight → its C1 status); after a run end → that end's
   * bottom line (the ⚠️ line, or the aborted line) — no spinner once the run
   * has ended (the grace window, the stop, …).
   */
  private currentBottom(): BottomLine {
    if (this.endKind === "clean") return { kind: "done" };
    if (this.endKind === "error") return { kind: "error", text: this.endError ?? "" };
    if (this.endKind === "stop") return { kind: "aborted" };
    if (this.autoCompacting) return { kind: "compact", status: AUTO_COMPACT_STATUS };
    return { kind: "thinking", word: this.thinkingWordNow() };
  }

  /** The draft's content capped for the ephemeral window (the draft has a hard size limit). */
  private draftContent(bottom?: BottomLine): string {
    return tailView(this.content(bottom), RICH_CAP);
  }

  /** Request a single-draft update (latest wins; paced by the shared window). */
  private requestUpdate(): void {
    if (!this.draftId) return;
    this.requestDraftUpdate(this.draftId, this.draftContent(), true);
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
  private requestDraftUpdate(draftId: number, content: string, canStop: boolean): void {
    if (this.deps.cfg.muted || this.phase !== "work") return;
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
          const next = this.pending.entries().next().value as [number, { content: string; canStop: boolean; run: number }] | undefined;
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
  private async runDraftOnce(draftId: number, content: string, canStop: boolean): Promise<void> {
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
   * Arm the error-settle grace: if no continuation starts within
   * cfg.errorSettleMs and the run is still a live error end, persist the
   * error log. Idempotent — one timer at a time.
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
