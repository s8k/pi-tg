/**
 * Per-turn agent-event mirroring on top of the rich draft (Bot API 10.2).
 *
 * One ephemeral rich draft per agent turn: same draft_id re-sent on content
 * updates plus a heartbeat (keeps the ~30 s window alive). Content = latest
 * assistant markdown (long fences folded, tail-viewed at RICH_CAP) + a
 * tool-status footer. Finalization = sendRichMessage → legacy HTML chunk →
 * plain text. Mute = fully silent.
 *
 * Draft sending is paced and self-limiting (Bot API allows ~1 msg/s per chat
 * and a 429 must never cascade into a request flood):
 *  - at most ONE draft call in flight; later updates coalesce into a single
 *    follow-up with the latest content (no concurrent 429-retry chains);
 *  - the success cooldown (streamEditMs) applies to ALL senders (stream
 *    updates, tool events, heartbeat) — no bursts in the same second;
 *  - failure cooldown honors the 429 retry_after (streamEditMs otherwise;
 *    a long quiet window for 400s, which cannot heal without new content);
 *  - notifications are state-change only: first failure, one re-note per 5
 *    min while failing, one recovery note.
 */
import type { Out } from "./session-bridge.ts";
import type { TelegaState } from "./state.ts";
import type { TelegaConfig } from "./config.ts";
import { RICH_CAP, foldLongFences, tailView, chunkRich, chunkMarkdown, chunkText, toPlainText } from "./markdown.ts";
import { TgError } from "./telegram-client.ts";

export interface MirrorMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/** Preview text for a tool call (kept inside the draft footer). */
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

export function assistantText(msg: MirrorMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("");
  return "";
}

/** Random verbs for the empty-draft label — a new one per draft content pass, so
 *  each turn (and heartbeat) shows a different word. */
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

export const thinkingPlaceholder = (): string =>
  `<tg-thinking>${THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]}…</tg-thinking>`;

/** The thinking word changes at most once per this many ms (no label flicker). */
export const THINKING_WORD_MIN_INTERVAL_MS = 5000;

/** A 400 means this content is unparseable — quiet long cooldown; the same content cannot heal. */
const DRAFT_400_COOLDOWN_MS = 60_000;
/** While a draft keeps failing, re-notify at most this often (dead channel ≠ silent one). */
const DRAFT_FAIL_RENOTIFY_MS = 300_000;

interface ToolLine {
  text: string;
  done: boolean;
  isError: boolean;
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

export class Mirror {
  private deps: MirrorDeps;
  private draftSeq = 0;
  private draftId = 0;
  private draftActive = false;
  private answerText = ""; // latest assistant markdown (the draft body)
  private nextDraftAt = 0; // earliest time a new draft attempt is allowed (throttle + failure cooldown)
  private draftInflight: Promise<void> | undefined;
  private draftDirty = false; // content changed while a draft call was in flight
  private draftFailStreak = 0;
  private draftLastFailNotifyAt = 0;
  private hbTimer: unknown;
  private thinkingLabel = "";
  private thinkingLabelAt = 0;
  private toolLines: ToolLine[] = [];
  private inflight = new Map<string, number>();
  private uiPromptLine: string | undefined;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  async onAgentStart(): Promise<void> {
    const { cfg } = this.deps;
    if (cfg.muted) return; // fully silent: no draft at all
    if (this.deps.getChatId() === undefined) return;
    this.draftSeq += 1;
    this.draftId = this.draftSeq;
    this.answerText = "";
    this.nextDraftAt = 0;
    this.draftDirty = false;
    this.draftFailStreak = 0;
    this.draftLastFailNotifyAt = 0;
    this.draftInflight = undefined; // a stale call from the prior turn may settle later; its finally is gen-guarded
    this.toolLines = [];
    this.inflight.clear();
    this.uiPromptLine = undefined;
    this.draftActive = true;
    this.requestDraft(true);
    this.armHeartbeat();
  }

  private armHeartbeat(): void {
    const { deps } = this;
    deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
    if (deps.cfg.muted || !this.draftActive) return;
    this.hbTimer = deps.setTimer(() => {
      this.hbTimer = undefined;
      this.requestDraft(true);
      this.armHeartbeat();
    }, deps.cfg.draftHeartbeatMs);
  }

  private stopHeartbeat(): void {
    this.deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
  }

  /**
   * Entry point for every draft sender (stream updates, tool events,
   * assistant end, heartbeat). Pacing lives here:
   *  - nothing before `nextDraftAt` (stream throttle / failure cooldown);
   *  - at most one call in flight; a request while in flight only marks
   *    `draftDirty` — the follow-up after completion carries the latest
   *    content (no concurrent 429-retry chains, no stale overwrites).
   */
  private requestDraft(canStop: boolean): void {
    const { cfg } = this.deps;
    if (cfg.muted || !this.draftActive) return;
    if (this.deps.getChatId() === undefined) return;
    if (this.deps.now() < this.nextDraftAt) return;
    if (this.draftInflight) {
      this.draftDirty = true;
      return;
    }
    this.draftInflight = this.runDraft(canStop, this.draftSeq);
  }

  private async runDraft(canStop: boolean, gen: number): Promise<void> {
    const { cfg, out } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined || cfg.muted || !this.draftActive) {
      this.draftInflight = undefined;
      return;
    }
    try {
      await out.sendDraft(chatId, this.draftId, this.draftContent(), canStop);
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
    } finally {
      if (gen !== this.draftSeq) return; // a new turn owns the draft now
      this.draftInflight = undefined;
      if (this.draftDirty) {
        this.draftDirty = false;
        this.requestDraft(canStop); // one follow-up with the latest content
      }
    }
  }

  private draftContent(): string {
    const { cfg } = this.deps;
    const body = tailView(foldLongFences(this.answerText, cfg.codeFoldLines), RICH_CAP);
    const footer = this.footerLines();
    if (footer.length > 0) return body.length > 0 ? `${body}\n\n${footer.join("\n")}` : footer.join("\n");
    return body.length > 0 ? body : this.thinkingLabelNow();
  }

  /** Current thinking label — re-rolls the random word at most every
   *  THINKING_WORD_MIN_INTERVAL_MS (per mirror instance, across turns). */
  private thinkingLabelNow(): string {
    const now = this.deps.now();
    if (this.thinkingLabel === "" || now - this.thinkingLabelAt >= THINKING_WORD_MIN_INTERVAL_MS) {
      this.thinkingLabel = thinkingPlaceholder();
      this.thinkingLabelAt = now;
    }
    return this.thinkingLabel;
  }

  private footerLines(): string[] {
    const lines = this.toolLines.filter((l) => !l.done).map((l) => l.text);
    for (const l of this.toolLines.filter((l) => l.done).slice(-3)) lines.push(l.text);
    if (this.uiPromptLine !== undefined) lines.push(this.uiPromptLine);
    return lines;
  }

  async onToolStart(toolCallId: string, tool: string, args: unknown): Promise<void> {
    if (!this.draftActive) return;
    const line = `⚙ ${tool}: ${toolPreview(tool, args, this.deps.cfg.toolPreviewChars)} …`;
    this.inflight.set(toolCallId, this.toolLines.length);
    this.toolLines.push({ text: line, done: false, isError: false });
    this.requestDraft(true);
  }

  async onToolEnd(toolCallId: string, isError: boolean): Promise<void> {
    if (!this.draftActive) return;
    const idx = this.inflight.get(toolCallId);
    this.inflight.delete(toolCallId);
    if (idx === undefined) return;
    const l = this.toolLines[idx];
    l.done = true;
    l.isError = isError;
    l.text = l.text.replace(/…$/, "").trimEnd() + (isError ? " ✖" : " ✔"); // single space before the mark
    this.requestDraft(true);
  }

  async onAssistantStart(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = "";
    // First update of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    this.nextDraftAt = 0;
  }

  async onAssistantUpdate(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = assistantText(msg);
    this.requestDraft(true); // pacing (throttle + failure cooldown) lives inside
  }

  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    if (!this.draftActive) return;
    // Paced like any other sender: if the last success was < streamEditMs ago
    // the complete text already (mostly) shows; the next message's first
    // update is forced through via onAssistantStart either way.
    this.requestDraft(true);
  }

  async onUiPromptStart(title?: string): Promise<void> {
    if (!this.draftActive) return;
    this.uiPromptLine = `⚠️ terminal prompt${title ? `: ${title}` : ""} — answer there`;
    this.requestDraft(true);
  }

  async onAgentEnd(messages: MirrorMessage[]): Promise<void> {
    this.stopHeartbeat();
    this.draftActive = false;
    let finalText = "";
    let stopReason: string | undefined;
    let errMsg: string | undefined;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const t = assistantText(msg);
      if (t.trim()) finalText = t;
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errMsg = msg.errorMessage;
    }
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const { out } = this.deps;

    if (stopReason === "error" || errMsg) {
      await out.send(chatId, `⚠️ error: ${errMsg ?? stopReason ?? "unknown"}`, { parseMode: null });
      return;
    }
    if (stopReason === "aborted") {
      await out.send(chatId, "⏹  interrupted", { parseMode: null });
      if (!this.deps.cfg.muted && finalText) await this.sendAnswer(chatId, finalText);
      return;
    }
    if (this.deps.cfg.muted) return; // fully silent
    if (finalText) await this.sendAnswer(chatId, finalText);
    else await out.send(chatId, "✅ Done (no reply text)", { parseMode: null });
  }

  /**
   * Finalize an answer: fold long fences, chunk at RICH_CAP (block boundaries),
   * send as rich messages. On a 400 (rich parse failed) the WHOLE answer is
   * re-sent through the legacy HTML path; on a 400 there, plain text. (The
   * 400-after-some-chunks-already-sent edge duplicates content — accepted,
   * same policy as the design doc: per-send fallback for the whole answer.)
   */
  private async sendAnswer(chatId: number, md: string): Promise<void> {
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
}
