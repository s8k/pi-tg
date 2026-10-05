import type { TgAction } from "./router.ts";

const PLAIN = new Set(["start", "help", "new", "sessions", "modelList", "thinkingList", "status", "stop", "level_mute", "level_minimal", "level_full", "compact", "reload", "killAsk"]);
const INDEX = new Set(["sessionActivate", "modelSet", "thinkingSet"]);

/**
 * Encode a TgAction as the argument string for a `/tg internal …` command.
 * Format: `internal <kind> <chatId> [arg]` where arg is a raw int (pair: fromId,
 * index kinds), 0/1 (kill/clear), or a JSON string (nameSet/prompt).
 * Returns null for actions that must not be dispatched as commands.
 */
export function encodeInternal(action: TgAction): string | null {
  switch (action.kind) {
    case "ignore":
    case "notAuthorized":
    case "unknown":
      return null;
    case "pair":
      return `internal pair ${action.chatId} ${action.fromId}`;
    case "nameSet":
      return `internal nameSet ${action.chatId} ${JSON.stringify(action.name)}`;
    case "prompt":
      return `internal prompt ${action.chatId} ${JSON.stringify(action.text)}`;
    case "kill":
      return `internal kill ${action.chatId} ${action.yes ? 1 : 0}${action.nonce ? ` ${action.nonce}` : ""}`;
    case "clear":
      return `internal clear ${action.chatId} ${action.doIt ? 1 : 0}${action.nonce ? ` ${action.nonce}` : ""}`;
    case "dialogAnswer":
      return `internal dialogAnswer ${action.chatId} ${action.dialogId} ${action.index}`;
    case "dialogCancel":
      return `internal dialogCancel ${action.chatId} ${action.dialogId}`;
    case "dialogText":
      return `internal dialogText ${action.chatId} ${JSON.stringify({ r: action.replyToMessageId, t: action.text })}`;
    case "dialogPlain":
      return `internal dialogPlain ${action.chatId} ${JSON.stringify({ d: action.dialogId, t: action.text })}`;
    default: {
      const a = action as { kind: string; chatId: number; index?: number };
      return `internal ${a.kind} ${a.chatId}${INDEX.has(a.kind) ? ` ${a.index}` : ""}`;
    }
  }
}

/** Parse a `/tg` command handler arg string → TgAction. null if not a valid internal command. */
export function parseInternal(args: string): TgAction | null {
  const parts = args.trim().split(/\s+/);
  if (parts[0] !== "internal" || parts.length < 3) return null;
  const kind = parts[1];
  const chatId = Number(parts[2]);
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const rest = parts.slice(3).join(" ");
  if (PLAIN.has(kind)) return { kind: kind as TgAction["kind"], chatId } as TgAction;
  if (INDEX.has(kind)) {
    const i = Number(rest);
    if (!Number.isInteger(i) || i < 0) return null;
    return { kind: kind as TgAction["kind"], chatId, index: i } as TgAction;
  }
  switch (kind) {
    case "pair": {
      const fromId = Number(rest);
      if (!Number.isInteger(fromId) || fromId <= 0) return null;
      return { kind: "pair", chatId, fromId };
    }
    case "kill": {
      const partsRest = rest.split(/\s+/);
      if (partsRest.length > 2 || (partsRest[0] !== "0" && partsRest[0] !== "1")) return null;
      return { kind: "kill", chatId, yes: partsRest[0] === "1", ...(partsRest[1] ? { nonce: partsRest[1] } : {}) };
    }
    case "clear": {
      const partsRest = rest.split(/\s+/);
      if (partsRest.length > 2 || (partsRest[0] !== "0" && partsRest[0] !== "1")) return null;
      return { kind: "clear", chatId, doIt: partsRest[0] === "1", ...(partsRest[1] ? { nonce: partsRest[1] } : {}) };
    }
    case "dialogAnswer": {
      const partsRest = rest.split(/\s+/);
      if (partsRest.length !== 2) return null;
      const dialogId = Number(partsRest[0]);
      const index = Number(partsRest[1]);
      if (!Number.isInteger(dialogId) || dialogId <= 0 || !Number.isInteger(index) || index < 0) return null;
      return { kind: "dialogAnswer", chatId, dialogId, index };
    }
    case "dialogCancel": {
      const dialogId = Number(rest);
      if (!Number.isInteger(dialogId) || dialogId <= 0) return null;
      return { kind: "dialogCancel", chatId, dialogId };
    }
    case "dialogText": {
      try {
        const v: unknown = JSON.parse(rest);
        if (!v || typeof v !== "object") return null;
        const o = v as { r?: unknown; t?: unknown };
        if (typeof o.r !== "number" || !Number.isInteger(o.r) || o.r <= 0 || typeof o.t !== "string") return null;
        return { kind: "dialogText", chatId, replyToMessageId: o.r, text: o.t };
      } catch {
        return null;
      }
    }
    case "dialogPlain": {
      try {
        const v: unknown = JSON.parse(rest);
        if (!v || typeof v !== "object") return null;
        const o = v as { d?: unknown; t?: unknown };
        if (typeof o.d !== "number" || !Number.isInteger(o.d) || o.d <= 0 || typeof o.t !== "string") return null;
        return { kind: "dialogPlain", chatId, dialogId: o.d, text: o.t };
      } catch {
        return null;
      }
    }
    case "nameSet":
    case "prompt": {
      try {
        const v: unknown = JSON.parse(rest);
        if (typeof v !== "string") return null;
        return kind === "nameSet" ? { kind, chatId, name: v } : { kind, chatId, text: v };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
