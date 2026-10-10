import type { TgAction } from "./router.ts";

const PLAIN = new Set(["start", "help", "new", "sessions", "modelList", "thinkingList", "status", "stop", "level_mute", "level_minimal", "level_full", "reload", "killAsk"]);
/** Single-token kinds (inline picker): the token is validated on parse. */
const TOKEN = new Set(["cmdTerminal"]);
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
    case "cmdRun":
      return `internal cmdRun ${action.chatId} ${action.nonce}${action.inlineMessageId ? ` ${action.inlineMessageId}` : ""}`;
    case "cmdSend":
      return `internal cmdSend ${action.chatId} ${JSON.stringify({ name: action.name, args: action.args })}`;
    case "importSet":
      return `internal importSet ${action.chatId} ${JSON.stringify(action.path)}`;
    case "cmdTerminal":
      return `internal cmdTerminal ${action.chatId} ${action.name}`;
    case "compact":
      return action.instructions !== undefined
        ? `internal compact ${action.chatId} ${JSON.stringify(action.instructions)}`
        : `internal compact ${action.chatId}`;
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
  if (TOKEN.has(kind)) {
    // One bare token (nonce / command name) — no spaces.
    if (!rest || /\s/.test(rest)) return null;
    return { kind: kind as "cmdRun" | "cmdTerminal", chatId, ...(kind === "cmdRun" ? { nonce: rest } : { name: rest }) } as TgAction;
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
    case "compact": {
      // Bare (legacy/plain) or a JSON string of custom instructions.
      if (!rest) return { kind: "compact", chatId };
      try {
        const v: unknown = JSON.parse(rest);
        if (typeof v !== "string") return null;
        return { kind: "compact", chatId, instructions: v };
      } catch {
        return null;
      }
    }
    case "importSet": {
      try {
        const v: unknown = JSON.parse(rest);
        if (typeof v !== "string" || !v) return null;
        return { kind: "importSet", chatId, path: v };
      } catch {
        return null;
      }
    }
    case "cmdRun": {
      // nonce [+ optional inline_message_id of the auto-sent card]
      const partsRest = rest.split(/\s+/);
      if (partsRest.length < 1 || partsRest.length > 2 || !partsRest[0]) return null;
      return { kind: "cmdRun", chatId, nonce: partsRest[0], ...(partsRest[1] ? { inlineMessageId: partsRest[1] } : {}) };
    }
    case "cmdSend": {
      try {
        const v: unknown = JSON.parse(rest);
        if (!v || typeof v !== "object") return null;
        const o = v as { name?: unknown; args?: unknown };
        if (typeof o.name !== "string" || !o.name || typeof o.args !== "string") return null;
        return { kind: "cmdSend", chatId, name: o.name, args: o.args };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
