/**
 * Two-message LLM mirroring on top of the rich draft (Bot API 10.2).
 *
 * Message 1 — the work log: a chronological log of narration, tool calls
 * (params collapsed, errors visible), user prompts, provider errors, and a
 * bottom line (working spinner / Completed ✔️ / ⚠ Error / none on manual
 * stop). Message 2 — the answer: a candidate slot that streams the assistant
 * text live; a tool call demotes the candidate into message 1 (the slot
 * clears, the draft id is kept), and the surviving candidate is persisted as
 * the final answer when the run confirms.
 *
 * Draft sending is paced and self-limiting (Bot API allows ~1 msg/s per chat
 * and a 429 must never cascade into a request flood):
 *  - at most ONE draft call in flight across BOTH drafts; later updates
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

/** Preview text for a tool call (the key argument shown on the block's first line). */
export function toolPreview(tool: string, args: unknown, maxChars: number): string {
  const a = args as Record<string, unknown> | undefined;
  if (tool === "bash" && typeof a?.command === "string") return a.command;
  if (tool === "read" && typeof a?.path === "string") return a.path;
  if (tool === "write" && typeof a?.path === "string") return a.path;
  if (tool === "edit" && typeof a?.path === "string") return a.path;
  if (typeof a?.file_path === "string") return a.file_path;
  if (typeof a?.path === "string") return a.path;
  if (typeof a?.url === "string") return a.url;
  if (typeof a?.query === "string") return a.query;
  const s = JSON.stringify(args ?? {});
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

// ─────────────────────────── Work log model (two-message mirror) ───────────────────────────

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
      keyArg: string;
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
  | { kind: "error" } // error end: ⚠ Error
  | { kind: "none" }; // manual stop: removed, no marker

/**
 * Render the work log: committed blocks + the in-flight demoted tail (if any)
 * + the bottom line, each separated by one blank line. The SAME builder
 * renders live drafts and persistent sends, so demotion, the ✔ flip and
 * finalization cannot drift apart.
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
  if (opts.tail && opts.tail.trim()) parts.push(opts.tail);
  const bottom = bottomLineText(opts.bottom);
  if (bottom) parts.push(bottom);
  return parts.join("\n\n");
}

export function bottomLineText(bottom: BottomLine): string {
  switch (bottom.kind) {
    case "thinking":
      return `<tg-thinking>${bottom.word}…</tg-thinking>`;
    case "done":
      return "Completed ✔️";
    case "error":
      return "⚠ Error";
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

/** Where the in-flight message's text currently renders. */
type TailMode = "none" | "candidate" | "demoted";

export class Mirror {
  private deps: MirrorDeps;
  // run identity & lifecycle
  private runSeq = 0;
  private phase: "work" | "finalized" = "finalized"; // one-way switch
  // work log (message 1)
  private log: LogBlock[] = [];
  private logId = 0; // draft id of the work log
  // answer slot (message 2) — one slot per run
  private slot: { draftId: number; created: boolean } = { draftId: 0, created: false };
  private tail: { mode: TailMode; text: string } = { mode: "none", text: "" };
  private finalText: string | undefined; // set when the answer is confirmed
  private endKind: "clean" | "stop" | "error" | undefined;
  private thinking: string[] = []; // current message's thinking stream (why extraction)
  // pacing — shared by BOTH drafts
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
    this.tail = { mode: "none", text: "" };
    this.slot = { draftId: 0, created: false };
    this.finalText = undefined;
    this.endKind = undefined;
    this.thinking = [];
    this.nextDraftAt = 0;
    this.forceNext = false;
    this.pending.clear(); // a stale in-flight update from a prior run may settle later; it is gen-guarded
    this.draftFailStreak = 0;
    this.draftLastFailNotifyAt = 0;
    this.phase = "work";
    if (this.deps.cfg.muted || this.deps.getChatId() === undefined) return;
    this.logId = ++this.draftSeq;
    this.requestLogUpdate();
    this.armHeartbeat();
  }

  // ─────────────────────────── message stream ───────────────────────────

  onAssistantStart(msg: MirrorMessage): void {
    if (msg.role !== "assistant" || this.phase !== "work") return;
    this.thinking = [];
    this.tail = { mode: "candidate", text: "" };
    // The first send of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    // A flag, not a nextDraftAt reset: a reset would be stomped by an
    // in-flight draft call completing in the same tick.
    this.forceNext = true;
  }

  onAssistantUpdate(msg: MirrorMessage): void {
    if (msg.role !== "assistant" || this.phase !== "work") return;
    const parts = partsOf(msg);
    this.thinking = parts.filter((p) => p.type === "thinking" && !p.redacted).map((p) => p.thinking ?? "");
    let demote = false;
    let text = "";
    for (const p of parts) {
      if (p.type === "toolCall") demote = true;
      else if (p.type === "text") text += p.text ?? "";
    }
    if (demote) {
      // Demotion: the candidate text becomes part of the work log (as the
      // tail, until message_end commits it to a block); the slot clears to
      // the spinner — content only, the draft id is kept.
      this.tail = { mode: "demoted", text };
      if (this.slot.created) this.requestSlotUpdate();
      this.requestLogUpdate();
    } else {
      this.tail = { mode: "candidate", text };
      if (text.trim()) this.wakeSlot(); // textless candidates never create the slot
    }
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
          keyArg: toolPreview(p.name ?? "", p.arguments, this.deps.cfg.toolPreviewChars),
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
      this.finalText = textAll;
      this.endKind = "clean";
      this.tail = { mode: "none", text: "" };
      this.thinking = [];
      await this.finalize();
      return;
    }
    flush();
    if (msg.errorMessage) this.log.push({ type: "agentError", text: `⚠️ error: ${escapeHtml(msg.errorMessage)}` });
    // Stop/error end states persist the PARTIAL CANDIDATE — whatever the slot
    // was showing when this message ended (empty = the slot sat at the
    // spinner, message 2 is skipped). The finalizing agent_end does the sends.
    const slotText = this.tail.mode === "candidate" ? this.tail.text : "";
    if (msg.stopReason === "aborted") {
      this.endKind = "stop";
      this.finalText = slotText; // the partial candidate as-is
    } else if (msg.stopReason === "error" || msg.errorMessage) {
      this.endKind = "error";
      if (msg.stopReason === "error") this.finalText = slotText; // the ⚠ incomplete trailer is added at finalization
    }
    // Fast messages demote only at end: if a tool-carrying message never
    // demoted mid-stream, a slot still showing its text must clear now.
    if (toolCount > 0 && this.slot.created && this.tail.mode === "candidate" && textAll.trim()) {
      this.tail = { mode: "demoted", text: textAll };
      this.requestSlotUpdate();
    }
    this.tail = { mode: "none", text: "" };
    this.thinking = [];
    this.requestLogUpdate();
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
    if (changed) this.requestLogUpdate();
  }

  onUiPromptStart(title?: string): void {
    if (this.phase !== "work") return;
    this.log.push({ type: "prompt", text: `⚠️ terminal prompt${title ? `: ${escapeHtml(title)}` : ""} — answer there` });
    this.requestLogUpdate();
  }

  // ───────────────────────────── end of run ─────────────────────────────

  async onAgentEnd(_messages: MirrorMessage[]): Promise<void> {
    if (this.phase !== "work") return; // already finalized — one-way switch
    if (this.endKind === undefined) this.endKind = "stop"; // e.g. the run produced no assistant message
    await this.finalize();
  }

  /**
   * Finalize the run (one-way): flip the live log draft to the end marker,
   * then persist the pair — the full work log (m1), then the answer (m2) —
   * each with chunking, the rich → HTML → plain fallback, and 3 attempts
   * with backoff. The persistent m1 send kills the ephemeral drafts.
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
    if (this.log.length > 0) {
      // The flip: the live log draft visibly becomes the end marker before
      // the persistent send freezes it. Best-effort (its failure must not
      // block persistence) and throttle-bypassed — the run is over.
      await this.deps.out.sendDraft(chatId, this.logId, this.logContent(bottom), false, true).catch(() => {});
      await this.sendPersistent(chatId, this.logMd(bottom)); // full log — chunked, never tailView-capped
    }
    if (this.finalText && this.finalText.trim()) {
      const m2 = this.endKind === "error" ? `${this.finalText.trimEnd()}\n\n⚠ incomplete` : this.finalText;
      await this.sendPersistent(chatId, m2);
    }
  }

  /**
   * One persistent send: fold long fences, chunk at the rich cap (block
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

  /** The full work log (committed blocks + in-flight demoted tail + bottom line) — for persistent sends. */
  private logMd(bottom?: BottomLine): string {
    return blocksToMd(this.log, {
      tail: this.tail.mode === "demoted" ? this.tail.text : undefined,
      bottom: bottom ?? { kind: "thinking", word: this.thinkingWordNow() },
    });
  }

  /** The work log capped for the ephemeral draft (the draft has a hard size limit). */
  private logContent(bottom?: BottomLine): string {
    return tailView(this.logMd(bottom), RICH_CAP);
  }

  private slotContent(): string {
    if (this.tail.mode === "candidate" && this.tail.text.trim()) return this.tail.text;
    return bottomLineText({ kind: "thinking", word: this.thinkingWordNow() });
  }

  private requestLogUpdate(): void {
    if (!this.logId) return;
    this.requestDraftUpdate(this.logId, this.logContent(), true);
  }

  private requestSlotUpdate(): void {
    if (!this.slot.created) return;
    this.requestDraftUpdate(this.slot.draftId, this.slotContent(), true);
  }

  private wakeSlot(): void {
    if (!this.slot.created) this.slot = { draftId: ++this.draftSeq, created: true };
    this.requestSlotUpdate();
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

  private async runDraftOnce(draftId: number, content: string, canStop: boolean): Promise<void> {
    const { cfg, out } = this.deps;
    if (this.phase !== "work") return;
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
      this.requestLogUpdate(); // keeps the ~30 s draft window alive (word may have rotated)
      this.requestSlotUpdate();
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
