import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PendingAction =
  | {
      type: "new";
      chatId: number;
      /**
       * The id of the "🔄 Creating new session…" ack message (A7): the
       * replacement instance edit-stamps it with ✔️ before posting the new
       * session's card.
       */
      ackMsgId?: number;
    }
  | { type: "activate"; chatId: number; path: string }
  | { type: "reload"; chatId: number };

/**
 * Agent output level — the mirror's render filter: `mute` = nothing (old
 * `muted: true`), `minimal` = visible text only (narration + answer),
 * `full` = today's behavior (draft + work log + final answer, default).
 * Commands, cards and help are unaffected by any level.
 */
export type OutputLevel = "mute" | "minimal" | "full";

export interface TelegaConfig {
  botToken?: string;
  ownerId?: number;
  streamEditMs: number;
  askClearOnSwitch: boolean;
  maxSessionList: number;
  /** Re-send cadence of the rich draft (keeps the ~30 s ephemeral window alive). */
  draftHeartbeatMs: number;
  /**
   * Grace before an error-ended run's un-persisted work log is posted as its
   * own "⚠️ error" message when no continuation arrives. Must exceed pi's
   * retry backoff (2 s default) so an auto-retry CARRIES OVER the log
   * instead of the error message being double-posted.
   */
  errorSettleMs: number;
  /** Code fences with a body of more than this many lines are wrapped in a closed <details>. */
  codeFoldLines: number;
  /** Agent output level (see `OutputLevel`). Legacy `muted` still parses: true → "mute", false → "full". */
  level: OutputLevel;
  /** Mirror other extensions' TUI dialogs (select/confirm/input/editor) to Telegram as interactive messages. */
  mirrorDialogs: boolean;
  /** IDs of bot-sent messages, for chat cleaning (capped at 500, newest last). */
  sentMessageIds: number[];
  /** Polling cursor, persisted so a restart/instance-swap resumes without re-read. */
  lastOffset?: number;
  /** Set before newSession/switchSession; consumed by the replacement instance. */
  pendingAction?: PendingAction;
}

export interface ConfigOptions {
  /** Override the config file path (tests). */
  path?: string;
  /** Process env for the token override (tests). */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULTS: Pick<
  TelegaConfig,
  "streamEditMs" | "askClearOnSwitch" | "maxSessionList" | "draftHeartbeatMs" | "errorSettleMs" | "codeFoldLines" | "level" | "mirrorDialogs" | "sentMessageIds"
> = {
  streamEditMs: 1500,
  askClearOnSwitch: true,
  maxSessionList: 20,
  draftHeartbeatMs: 17_000,
  errorSettleMs: 5_000,
  codeFoldLines: 25,
  level: "full",
  mirrorDialogs: true,
  sentMessageIds: [],
};

export function configPath(opts?: ConfigOptions): string {
  return opts?.path ?? join(homedir(), ".pi", "agent", "pi-telega.json");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const v = Math.round(value);
    if (v >= min && v <= max) return v;
  }
  return fallback;
}

function capSentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0 && !seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids.slice(-500);
}

function sanitizePending(value: unknown): PendingAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.chatId !== "number" || !Number.isFinite(p.chatId)) return undefined;
  if (p.type === "new") {
    const ackMsgId = typeof p.ackMsgId === "number" && Number.isInteger(p.ackMsgId) && p.ackMsgId > 0 ? p.ackMsgId : undefined;
    return ackMsgId !== undefined ? { type: "new", chatId: p.chatId, ackMsgId } : { type: "new", chatId: p.chatId };
  }
  if (p.type === "activate" && typeof p.path === "string" && p.path !== "") {
    return { type: "activate", chatId: p.chatId, path: p.path };
  }
  if (p.type === "reload") return { type: "reload", chatId: p.chatId };
  return undefined;
}

/** `level`: a valid value wins; otherwise legacy `muted` (strict boolean: true → "mute", false → "full"); otherwise the default. */
function parseLevel(obj: Record<string, unknown>): OutputLevel {
  if (obj.level === "mute" || obj.level === "minimal" || obj.level === "full") return obj.level;
  if (obj.muted === true) return "mute";
  if (obj.muted === false) return "full";
  return DEFAULTS.level;
}

/** Repair a raw (possibly hand-edited/corrupt) config object into a valid one. */
export function sanitize(raw: unknown): TelegaConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    botToken: typeof obj.botToken === "string" && obj.botToken.trim() !== "" ? obj.botToken : undefined,
    ownerId: typeof obj.ownerId === "number" && Number.isFinite(obj.ownerId) ? obj.ownerId : undefined,
    streamEditMs: clampInt(obj.streamEditMs, DEFAULTS.streamEditMs, 500, 10_000),
    askClearOnSwitch: typeof obj.askClearOnSwitch === "boolean" ? obj.askClearOnSwitch : DEFAULTS.askClearOnSwitch,
    maxSessionList: clampInt(obj.maxSessionList, DEFAULTS.maxSessionList, 5, 50),
    draftHeartbeatMs: clampInt(obj.draftHeartbeatMs, DEFAULTS.draftHeartbeatMs, 5_000, 25_000),
    errorSettleMs: clampInt(obj.errorSettleMs, DEFAULTS.errorSettleMs, 1_000, 30_000),
    codeFoldLines: clampInt(obj.codeFoldLines, DEFAULTS.codeFoldLines, 5, 500),
    level: parseLevel(obj),
    mirrorDialogs: typeof obj.mirrorDialogs === "boolean" ? obj.mirrorDialogs : DEFAULTS.mirrorDialogs,
    sentMessageIds: capSentIds(obj.sentMessageIds),
    lastOffset: typeof obj.lastOffset === "number" && Number.isFinite(obj.lastOffset) ? obj.lastOffset : undefined,
    pendingAction: sanitizePending(obj.pendingAction),
  };
}

export function loadConfig(opts?: ConfigOptions): TelegaConfig {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(opts), "utf-8")));
  } catch {
    return sanitize({}); // missing or corrupt → defaults (never crash pi on a bad file)
  }
}

/** Effective bot token: env `PI_TELEGA_BOT_TOKEN` (preferred) beats the stored value. */
export function getBotToken(cfg: TelegaConfig, opts?: ConfigOptions): string | undefined {
  const env = opts?.env ?? process.env;
  const fromEnv = env.PI_TELEGA_BOT_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return cfg.botToken;
}

/** Atomic-ish write (tmp + rename) so a crash never leaves a torn config file. */
export function saveConfig(cfg: TelegaConfig, opts?: ConfigOptions): void {
  const path = configPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmp, path);
}
