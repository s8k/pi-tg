import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PendingAction =
  | { type: "new"; chatId: number }
  | { type: "activate"; chatId: number; path: string }
  | { type: "reload"; chatId: number };

export interface TelegaConfig {
  botToken?: string;
  ownerId?: number;
  streamEditMs: number;
  askClearOnSwitch: boolean;
  maxSessionList: number;
  /** Re-send cadence of the rich draft (keeps the ~30 s ephemeral window alive). */
  draftHeartbeatMs: number;
  /** Code fences with a body of more than this many lines are wrapped in a closed <details>. */
  codeFoldLines: number;
  /** When true, agent output (mirror) is suppressed; command replies still work. */
  muted: boolean;
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
  "streamEditMs" | "askClearOnSwitch" | "maxSessionList" | "draftHeartbeatMs" | "codeFoldLines" | "muted" | "sentMessageIds"
> = {
  streamEditMs: 1500,
  askClearOnSwitch: true,
  maxSessionList: 20,
  draftHeartbeatMs: 17_000,
  codeFoldLines: 25,
  muted: false,
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
  if (p.type === "new") return { type: "new", chatId: p.chatId };
  if (p.type === "activate" && typeof p.path === "string" && p.path !== "") {
    return { type: "activate", chatId: p.chatId, path: p.path };
  }
  if (p.type === "reload") return { type: "reload", chatId: p.chatId };
  return undefined;
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
    codeFoldLines: clampInt(obj.codeFoldLines, DEFAULTS.codeFoldLines, 5, 500),
    muted: typeof obj.muted === "boolean" ? obj.muted : DEFAULTS.muted,
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
