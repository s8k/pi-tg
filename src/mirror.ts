/**
 * Per-turn agent-event mirroring on top of the rich draft (Bot API 10.2).
 *
 * One ephemeral rich draft per agent turn: same draft_id re-sent on every
 * content update plus a heartbeat (keeps the ~30 s window alive). Content =
 * latest assistant markdown (long fences folded, tail-viewed at RICH_CAP)
 * + a tool-status footer. Finalization = sendRichMessage → legacy HTML
 * chunk → plain text. Mute = fully silent.
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

const THINKING = "<tg-thinking>working…</tg-thinking>";

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
  /** Surfaced when a draft update fails (the next update retries; no machinery). */
  notify?: (msg: string) => void;
}

export class Mirror {
  private deps: MirrorDeps;
  private draftSeq = 0;
  private draftId = 0;
  private draftActive = false;
  private answerText = ""; // latest assistant markdown (the draft body)
  private lastDraftSend = 0;
  private hbTimer: unknown;
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
    this.lastDraftSend = 0;
    this.toolLines = [];
    this.inflight.clear();
    this.uiPromptLine = undefined;
    this.draftActive = true;
    await this.sendDraft(true);
    this.armHeartbeat();
  }

  private armHeartbeat(): void {
    const { deps } = this;
    deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
    if (deps.cfg.muted || !this.draftActive) return;
    this.hbTimer = deps.setTimer(() => {
      this.hbTimer = undefined;
      void this.sendDraft(true);
      this.armHeartbeat();
    }, deps.cfg.draftHeartbeatMs);
  }

  private stopHeartbeat(): void {
    this.deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
  }

  private async sendDraft(canStop: boolean): Promise<void> {
    const { cfg, out } = this.deps;
    if (cfg.muted || !this.draftActive) return;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    try {
      await out.sendDraft(chatId, this.draftId, this.draftContent(), canStop);
      this.lastDraftSend = this.deps.now();
    } catch (err) {
      this.deps.notify?.(`draft update failed: ${String(err)}`);
    }
  }

  private draftContent(): string {
    const { cfg } = this.deps;
    const body = tailView(foldLongFences(this.answerText, cfg.codeFoldLines), RICH_CAP);
    const footer = this.footerLines();
    if (footer.length > 0) return body.length > 0 ? `${body}\n\n${footer.join("\n")}` : footer.join("\n");
    return body.length > 0 ? body : THINKING;
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
    await this.sendDraft(true);
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
    await this.sendDraft(true);
  }

  async onAssistantStart(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = "";
    // First update of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    this.lastDraftSend = this.deps.now() - this.deps.cfg.streamEditMs;
  }

  async onAssistantUpdate(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = assistantText(msg);
    if (this.deps.now() - this.lastDraftSend < this.deps.cfg.streamEditMs) return;
    await this.sendDraft(true);
  }

  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    if (!this.draftActive) return;
    await this.sendDraft(true); // unthrottled: show the complete message before the next one/turn
  }

  async onUiPromptStart(title?: string): Promise<void> {
    if (!this.draftActive) return;
    this.uiPromptLine = `⚠️ terminal prompt${title ? `: ${title}` : ""} — answer there`;
    await this.sendDraft(true);
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
