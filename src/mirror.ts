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
 * marker, no divider) and finalize only at agent_settled (the end of the
 * stream): pi auto-retries retryable provider errors, so an agent_end after
 * an error does NOT finalize — the draft stays alive until the retried run
 * starts or the stream settles.
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

/** The bottom line of message 1 (the draft's last block). */
export type BottomLine =
  | { kind: "thinking"; word: string } // working: <tg-thinking>word…</tg-thinking>
  | { kind: "done" } // clean end: Completed ✔️
  | { kind: "error" } // error end: no marker (the ⚠️ error: log block says it)
  | { kind: "none" }; // manual stop: removed, no marker

/**
 * Render the single mirror message: committed blocks + the in-flight tail
 * (the current message's text) + the bottom line, each separated by one
 * blank line. Layout by bottom kind:
 *  - thinking (while working): [blocks] [tail] --- <tg-thinking>…</tg-thinking>
 *    — the spinner stays LAST, below the streaming text; whenever there is
 *    any text above it (blocks and/or the tail), a horizontal line
 *    separates the two (nothing above the spinner → no line).
 *  - done / error (finalized): [blocks] [Completed ✔️] [tail]
 *    — the marker sits at the end of the work (after the tool blocks), then
 *    the answer. NO divider: the answer is split into its own message anyway,
 *    so the log part needs no horizontal line. Error ends have no marker at
 *    all — the `⚠️ error: …` log block already carries the signal.
 *  - none (stopped):           [blocks] [tail]
 * The SAME builder renders live drafts and the final persistent send, so
 * the finalize transition cannot drift from what the draft showed.
 */
export function blocksToMd(log: LogBlock[], opts: { tail?: string; bottom: BottomLine }): string {
  const parts = log.map((b) => {
    switch (b.type) {
      case "tool":
        return renderToolBlock(b);
      default:
        return b.text;
    }
  });
  const tail = opts.tail && opts.tail.trim() ? opts.tail : undefined;
  if (opts.bottom.kind === "done" || opts.bottom.kind === "error") {
    const marker = bottomLineText(opts.bottom); // done: "Completed ✔️", error: ""
    if (marker) parts.push(marker);
    if (tail) parts.push(tail); // no divider — the answer is its own message
    return parts.join("\n\n");
  }
  if (tail) parts.push(tail);
  const bottom = bottomLineText(opts.bottom);
  if (bottom) {
    if (parts.length > 0) parts.push("---"); // text above the spinner → a line between
    parts.push(bottom);
  }
  return parts.join("\n\n");
}

export function bottomLineText(bottom: BottomLine): string {
  switch (bottom.kind) {
    case "thinking":
      return `<tg-thinking>${bottom.word}…</tg-thinking>`;
    case "done":
      return "Completed ✔️";
    case "error":
      return ""; // no second error line — the `⚠️ error: …` block in the log is the signal
    case "none":
      return "";
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
  // pacing
  private nextDraftAt = 0; // earliest time a new draft attempt is allowed (throttle + failure cooldown)
  private forceNext = false; // one-shot: the first send of a new message breaks through the window
  private draftSeq = 0;
  private pending = new Map<number, { content: string; canStop: boolean; run: number }>();
  private inflight: Promise<void> | undefined;
  private drainTimer: unknown;
  // heartbeat
  private hbTimer: unknown;
  // thinking word rotation
  private thinkingWord = THINKING_WORDS[0];
  private thinkingWordAt = 0;
  // failure notifications (state-change only)
  private draftFailStreak = 0;
  private draftLastFailNotifyAt = 0;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  // ───────────────────────────── run lifecycle ─────────────────────────────

  onAgentStart(): void {
    this.runSeq++;
    this.log = [];
    this.tail = "";
    this.endKind = undefined;
    this.nextDraftAt = 0;
    this.forceNext = false;
    this.pending.clear(); // a stale in-flight update from a prior run may settle later; it is gen-guarded
    this.draftFailStreak = 0;
    this.draftLastFailNotifyAt = 0;
    this.phase = "work";
    if (this.deps.cfg.muted || this.deps.getChatId() === undefined) return;
    this.draftId = ++this.draftSeq;
    this.requestUpdate();
    this.armHeartbeat();
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
      // — it stays as the tail (rendered under the end marker at
      // finalization), not a log block, so it is not duplicated.
      if (msg.errorMessage) this.log.push({ type: "agentError", text: `⚠️ error: ${escapeHtml(msg.errorMessage)}` });
      this.endKind = endKind;
      this.tail = textAll;
    } else {
      // Tool-carrying (any stop reason) or mid-run (toolUse, deferred, …):
      // the text becomes a log block — the tail clears, the text keeps its
      // place at the end of the log.
      flush();
      if (msg.errorMessage) this.log.push({ type: "agentError", text: `⚠️ error: ${escapeHtml(msg.errorMessage)}` });
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

  // ───────────────────────────── end of run ─────────────────────────────

  async onAgentEnd(_messages: MirrorMessage[]): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    // A run that ended in an error is NOT the end of the stream: pi
    // auto-retries retryable provider errors (429/5xx/…) — a new agent_start
    // comes after the backoff. Do NOT finalize here: no persistent error
    // message, the draft stays alive (heartbeat) showing the error state.
    // Finalization for error ends waits for onAgentSettled (the stream is
    // really over: not retryable, or retries exhausted).
    if (this.endKind === "error") return;
    if (this.endKind === undefined) this.endKind = "stop"; // e.g. the run produced no assistant message
    await this.finalize();
  }

  /**
   * The end of the STREAM (pi's `agent_settled`): the run has fully settled
   * and no automatic retry, compaction, or queued continuation will run.
   * This is where error ends finalize; everything else is already done
   * (clean ends finalize at the confirming message_end, stops at agent_end).
   */
  async onAgentSettled(): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    if (this.endKind === undefined) this.endKind = "stop";
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
    this.pending.clear(); // no further draft updates follow the run
    if (this.deps.cfg.muted) return;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const bottom: BottomLine =
      this.endKind === "clean" ? { kind: "done" } : this.endKind === "error" ? { kind: "error" } : { kind: "none" };
    if (this.endKind === "clean" && this.tail.trim()) {
      // step 1 — the completed state in the draft. Awaited so the client sees
      // it before step 2 replaces the draft. Best effort: runDraftOnce
      // swallows failures (429/400) — the persistent messages still go out.
      if (this.draftId)
        await this.runDraftOnce(this.draftId, this.draftContent(bottom), false /* no Stop button — the run is over */);
      // step 2 — m1: the work log + the Completed marker (the answer is cut).
      await this.sendPersistent(chatId, blocksToMd(this.log, { bottom }));
      // step 3 — m2: the final answer, its own message.
      await this.sendPersistent(chatId, this.tail);
      return;
    }
    const tail = this.endKind === "error" && this.tail.trim() ? `${this.tail.trimEnd()}\n\n⚠ incomplete` : this.tail;
    const md = blocksToMd(this.log, { tail, bottom }); // full content — chunked, never tailView-capped
    if (md.trim()) await this.sendPersistent(chatId, md);
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
  private async deliverOnce(chatId: number, md: string): Promise<void> {
    const { out } = this.deps;
    const folded = foldLongFences(md, this.deps.cfg.codeFoldLines);
    const pieces = folded.length <= RICH_CAP ? [folded] : chunkRich(folded);
    try {
      for (const p of pieces) await out.sendRich(chatId, p);
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    try {
      for (const chunk of chunkMarkdown(md)) await out.send(chatId, chunk, { parseMode: "HTML" });
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    for (const chunk of chunkText(toPlainText(md))) await out.send(chatId, chunk, { parseMode: null });
  }

  /** Up to PERSIST_ATTEMPTS with 1s/2s/4s backoff, honoring a 429's retry_after. */
  private async sendPersistent(chatId: number, md: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const retryAfter = lastErr instanceof TgError ? lastErr.retryAfter : undefined;
        const delay = Math.max(RETRY_BACKOFF_MS[attempt - 2], retryAfter != null ? retryAfter * 1000 : 0);
        await this.sleep(delay);
      }
      try {
        await this.deliverOnce(chatId, md);
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
      bottom: bottom ?? { kind: "thinking", word: this.thinkingWordNow() },
    });
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
