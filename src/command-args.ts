import type { TgAction } from "./router.ts";

const PLAIN = new Set(["start", "help", "new", "sessions", "modelList", "thinkingList", "status", "stop", "mute", "unmute", "compact", "killAsk"]);
const INDEX = new Set(["sessionActivate", "switchOk", "modelSet", "thinkingSet"]);

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
      return `internal kill ${action.chatId} ${action.yes ? 1 : 0}`;
    case "clear":
      return `internal clear ${action.chatId} ${action.doIt ? 1 : 0}`;
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
    case "kill":
      if (rest !== "0" && rest !== "1") return null;
      return { kind: "kill", chatId, yes: rest === "1" };
    case "clear":
      if (rest !== "0" && rest !== "1") return null;
      return { kind: "clear", chatId, doIt: rest === "1" };
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
