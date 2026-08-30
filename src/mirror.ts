import type { Out } from "./session-bridge.ts";
import type { TelegaState } from "./state.ts";
import type { TelegaConfig } from "./config.ts";
import { CB } from "./router.ts";
import { chunkMarkdown, markdownToHtml, TG_MAX_LEN } from "./markdown.ts";

/** Structural (pi-free) view of pi messages. */
export interface MirrorContent {
  type: string;
  text?: string;
}
export interface MirrorMessage {
  role: string;
  content: MirrorContent[];
  stopReason?: string;
  error?: { message?: string };
}

export function assistantText(m: MirrorMessage): string {
  return m.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

const PREVIEW_DEFAULT = 80;
const ARG_KEYS: Record<string, string> = {
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
  grep: "pattern",
  glob: "pattern",
  ls: "path",
  find: "pattern",
};

/** One-line argument preview for tool status lines. */
export function toolPreview(toolName: string, args: unknown, maxChars = PREVIEW_DEFAULT): string {
  let s: string;
  if (typeof args === "string") s = args;
  else if (args && typeof args === "object") {
    const key = ARG_KEYS[toolName];
    const v = key ? (args as Record<string, unknown>)[key] : undefined;
    s = v != null && typeof v === "string" ? v : JSON.stringify(args);
  } else {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

export interface MirrorDeps {
  out: Out;
  state: TelegaState;
  cfg: TelegaConfig;
  getChatId(): number | undefined;
  now(): number; // injectable clock (stream throttling)
}

export class Mirror {
  private deps: MirrorDeps;
  private toolLines = new Map<string, string>();

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  /** agent_start: post the “working” message with [⏹ Stop]. */
  async onAgentStart(): Promise<void> {
    const { out, state } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const id = await out.send(chatId, "🤖 Working…", {
      replyMarkup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: CB.STOP }]] },
    });
    if (id !== undefined) state.setWorking(id);
  }

  /** tool_execution_start: post a status line (plain text). */
  async onToolStart(toolCallId: string, toolName: string, args: unknown): Promise<void> {
    const { out, state, cfg } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const line = `⚙ ${toolName}: ${toolPreview(toolName, args, cfg.toolPreviewChars)} …`;
    const id = await out.send(chatId, line, { parseMode: null });
    if (id !== undefined) {
      state.setToolMsg(toolCallId, id);
      this.toolLines.set(toolCallId, line);
    }
  }

  /** tool_execution_end: mark the status line done. */
  async onToolEnd(toolCallId: string, isError: boolean): Promise<void> {
    const { out, state } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const id = state.getToolMsg(toolCallId);
    const line = this.toolLines.get(toolCallId);
    this.toolLines.delete(toolCallId);
    if (id === undefined || line === undefined) return;
    await out.edit(chatId, id, `${line} ${isError ? "✖" : "✔"}`, { parseMode: null });
  }
}
