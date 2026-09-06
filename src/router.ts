import type { TgUpdate } from "./telegram-client.ts";

/** Compact callback_data builders — every value ≤ 64 bytes (Telegram limit). */
export const CB = {
  STOP: "stop",
  session: (i: number) => `s:${i}`,
  model: (i: number) => `m:${i}`,
  thinking: (i: number) => `t:${i}`,
  kill: (yes: boolean) => (yes ? "k:1" : "k:0"),
  clear: (doIt: boolean) => (doIt ? "c:1" : "c:0"),
} as const;

export type TgAction =
  | { kind: "ignore" }
  | { kind: "notAuthorized"; chatId: number; fromId: number }
  | { kind: "pair"; chatId: number; fromId: number }
  | { kind: "start"; chatId: number }
  | { kind: "help"; chatId: number }
  | { kind: "new"; chatId: number }
  | { kind: "sessions"; chatId: number }
  | { kind: "sessionActivate"; chatId: number; index: number }
  | { kind: "modelList"; chatId: number }
  | { kind: "modelSet"; chatId: number; index: number }
  | { kind: "thinkingList"; chatId: number }
  | { kind: "thinkingSet"; chatId: number; index: number }
  | { kind: "status"; chatId: number }
  | { kind: "stop"; chatId: number }
  | { kind: "level_mute"; chatId: number }
  | { kind: "level_minimal"; chatId: number }
  | { kind: "level_full"; chatId: number }
  | { kind: "compact"; chatId: number }
  | { kind: "reload"; chatId: number }
  | { kind: "nameSet"; chatId: number; name: string }
  | { kind: "killAsk"; chatId: number }
  | { kind: "kill"; chatId: number; yes: boolean }
  | { kind: "clear"; chatId: number; doIt: boolean }
  | { kind: "prompt"; chatId: number; text: string }
  | { kind: "unknown"; chatId: number; text: string };

const CMD_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*(.*)$/;

/**
 * Pure: one Telegram update + pairing state → one typed action.
 * - unpaired: only /start gets through (auto-pairs the first account)
 * - paired: only ownerId; bots, edits, non-text → ignore
 * - unknown command names and stale buttons → ignore/unknown (never crash)
 */
export function route(update: TgUpdate, ownerId: number | undefined): TgAction {
  // The rich draft's native Stop button (Bot API 10.2). Reuses the existing
  // `stop` action: the bridge aborts the turn and mirrors a ⏹️ message.
  const stopped = update.stopped_message_generation;
  if (stopped) return { kind: "stop", chatId: stopped.chat.id };

  const cb = update.callback_query;
  if (cb) {
    const chatId = cb.message?.chat.id ?? -1;
    if (ownerId === undefined || cb.from.id !== ownerId) {
      return { kind: "notAuthorized", chatId, fromId: cb.from.id };
    }
    const d = cb.data ?? "";
    if (d === CB.STOP) return { kind: "stop", chatId };
    if (d.startsWith("s:")) return { kind: "sessionActivate", chatId, index: Number(d.slice(2)) };
    if (d.startsWith("m:")) return { kind: "modelSet", chatId, index: Number(d.slice(2)) };
    if (d.startsWith("t:")) return { kind: "thinkingSet", chatId, index: Number(d.slice(2)) };
    if (d === "k:1" || d === "k:0") return { kind: "kill", chatId, yes: d === "k:1" };
    if (d === "c:1" || d === "c:0") return { kind: "clear", chatId, doIt: d === "c:1" };
    return { kind: "ignore" };
  }

  const msg = update.message;
  if (!msg || !msg.text) return { kind: "ignore" }; // edited_message, non-text, empty
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? -1;
  if (msg.from?.is_bot) return { kind: "ignore" };

  if (ownerId === undefined) {
    const t = msg.text.trim();
    if (t === "/start" || t.startsWith("/start@")) return { kind: "pair", chatId, fromId };
    return { kind: "notAuthorized", chatId, fromId };
  }
  if (fromId !== ownerId) return { kind: "notAuthorized", chatId, fromId };

  const text = msg.text.trim();
  const cmd = CMD_RE.exec(text);
  if (cmd) {
    const rest = cmd[2].trim();
    switch (cmd[1]) {
      case "start": return { kind: "start", chatId };
      case "help": return { kind: "help", chatId };
      case "new": return { kind: "new", chatId };
      case "sessions": return { kind: "sessions", chatId };
      case "models": return { kind: "modelList", chatId };
      case "thinking": return { kind: "thinkingList", chatId };
      case "status": return { kind: "status", chatId };
      case "stop": return { kind: "stop", chatId };
      case "level_mute": return { kind: "level_mute", chatId };
      case "level_minimal": return { kind: "level_minimal", chatId };
      case "level_full": return { kind: "level_full", chatId };
      case "compact": return { kind: "compact", chatId };
      case "reload": return { kind: "reload", chatId };
      case "name": return { kind: "nameSet", chatId, name: rest };
      case "kill": return { kind: "killAsk", chatId };
      default: return { kind: "unknown", chatId, text };
    }
  }
  return { kind: "prompt", chatId, text };
}
