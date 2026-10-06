import type { TgUpdate } from "./telegram-client.ts";
import { blocksToPlainText } from "./rich-blocks.ts";

/** Compact callback_data builders — every value ≤ 64 bytes (Telegram limit). */
export const CB = {
  STOP: "stop",
  session: (i: number) => `s:${i}`,
  model: (i: number) => `m:${i}`,
  thinking: (i: number) => `t:${i}`,
  /** One-shot confirmations: an optional nonce ties the tap to its exact
    * question (the bridge stamps + disables it; repeat/foreign taps die). */
  kill: (yes: boolean, nonce?: string) => (yes ? "k:1" : "k:0") + (nonce ? `:${nonce}` : ""),
  clear: (doIt: boolean, nonce?: string) => (doIt ? "c:1" : "c:0") + (nonce ? `:${nonce}` : ""),
  /** Mirrored TUI dialogs: da:<dialogId>:<optionIndex> / dc:<dialogId> — always ≤ 64 bytes. */
  dialogAnswer: (d: number, i: number) => `da:${d}:${i}`,
  dialogCancel: (d: number) => `dc:${d}`,
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
  | { kind: "kill"; chatId: number; yes: boolean; nonce?: string }
  | { kind: "clear"; chatId: number; doIt: boolean; nonce?: string }
  | { kind: "prompt"; chatId: number; text: string }
  | { kind: "dialogAnswer"; chatId: number; dialogId: number; index: number }
  | { kind: "dialogCancel"; chatId: number; dialogId: number }
  | { kind: "dialogText"; chatId: number; replyToMessageId: number; text: string }
  | { kind: "dialogPlain"; chatId: number; dialogId: number; text: string }
  | { kind: "unknown"; chatId: number; text: string };

const CMD_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*(.*)$/;

/**
 * Pure: one Telegram update + pairing state → one typed action.
 * - unpaired: only /start gets through (auto-pairs the first account)
 * - paired: only ownerId; bots, edits, non-text → ignore
 * - unknown command names and stale buttons → ignore/unknown (never crash)
 */
export function route(
  update: TgUpdate,
  ownerId: number | undefined,
  opts?: {
    isDialogMessage?: (messageId: number) => boolean;
    /** Plain-message fallback: returns a dialog id when `text` is a valid plain answer for a pending text-answer dialog (numbered select / input / editor). */
    plainAnswer?: (text: string) => number | undefined;
  },
): TgAction {
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
    const killM = /^k:([01])(?::(\w+))?$/.exec(d);
    if (killM) return { kind: "kill", chatId, yes: killM[1] === "1", ...(killM[2] ? { nonce: killM[2] } : {}) };
    const clearM = /^c:([01])(?::(\w+))?$/.exec(d);
    if (clearM) return { kind: "clear", chatId, doIt: clearM[1] === "1", ...(clearM[2] ? { nonce: clearM[2] } : {}) };
    if (d.startsWith("da:")) {
      const [ds, is] = d.slice(3).split(":");
      const dialogId = Number(ds);
      const index = Number(is);
      if (Number.isInteger(dialogId) && dialogId > 0 && Number.isInteger(index) && index >= 0)
        return { kind: "dialogAnswer", chatId, dialogId, index };
      return { kind: "ignore" };
    }
    if (d.startsWith("dc:")) {
      const dialogId = Number(d.slice(3));
      if (Number.isInteger(dialogId) && dialogId > 0) return { kind: "dialogCancel", chatId, dialogId };
      return { kind: "ignore" };
    }
    return { kind: "ignore" };
  }

  const msg = update.message;
  if (!msg) return { kind: "ignore" }; // edited_message, etc.
  // R9 (live 2026-10-08): an incoming rich message (e.g. forwarded) carries
  // `rich_message` blocks and NO `text` — project to plain text so it routes
  // like text instead of being silently ignored. `text` wins if both present.
  const rawText = msg.text ?? (msg.rich_message ? blocksToPlainText(msg.rich_message.blocks) : undefined);
  if (!rawText) return { kind: "ignore" }; // non-text (photo, …), empty
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? -1;
  if (msg.from?.is_bot) return { kind: "ignore" };

  if (ownerId === undefined) {
    const t = rawText.trim();
    if (t === "/start" || t.startsWith("/start@")) return { kind: "pair", chatId, fromId };
    return { kind: "notAuthorized", chatId, fromId };
  }
  if (fromId !== ownerId) return { kind: "notAuthorized", chatId, fromId };

  const text = rawText.trim();
  // A reply to a pending dialog message is the dialog's text answer — even when
  // it looks like a command (the owner is answering, not commanding).
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo !== undefined && opts?.isDialogMessage?.(replyTo))
    return { kind: "dialogText", chatId, replyToMessageId: replyTo, text };
  // Plain-message fallback (no reply-to): a plain message while a text-answer
  // dialog is active answers that dialog — the owner may have skipped the
  // reply gesture or replied to the pause segment above the dialog
  // (live bug, 2026-09-27).
  const plainDlg = opts?.plainAnswer?.(text);
  if (plainDlg !== undefined) return { kind: "dialogPlain", chatId, dialogId: plainDlg, text };
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
