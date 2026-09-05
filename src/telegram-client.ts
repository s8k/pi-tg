/** Structural fetch — the real global `fetch` satisfies it; tests inject a fake. */
import { BOT_COMMANDS } from "./bot-commands.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TgError extends Error {
  method: string;
  code: number;
  description: string;
  retryAfter?: number;
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`${method}: ${code} ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

export class TgNetworkError extends Error {
  method: string;
  constructor(method: string, cause: unknown) {
    super(`network error calling ${method}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.method = method;
    this.cause = cause;
  }
}

export interface ClientOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface TgChat {
  id: number;
  type: string; // "private" | "group" | "supergroup" | "channel"
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

export interface TgFrom {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgFrom;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgFrom;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  /** Bot API 10.3: the user pressed the Stop button on a draft we created. */
  stopped_message_generation?: MessageGenerationStopped;
}

/** One of `markdown` | `html` | `blocks` must be set (Bot API 10.2, InputRichMessage). */
export interface InputRichMessage {
  markdown?: string;
  html?: string;
  blocks?: unknown[];
}

/**
 * Update sent when a user stops a draft message (Bot API 10.3).
 * Spike 2026-08-31: `draft_id` arrives as a *string* (e.g. "6"), despite the
 * docs calling it an Integer; `chat` is a full Chat object, not `chat_id`.
 */
export interface MessageGenerationStopped {
  chat: TgChat;
  message_thread_id?: number;
  draft_id: string;
}

export interface TgBotMe {
  id: number;
  is_bot: true;
  first_name: string;
  username?: string;
}

export interface TgSentMessage {
  message_id: number;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface PollerDeps {
  client: TelegramClient;
  getOffset(): number;
  setOffset(n: number): void;
  onUpdates(updates: TgUpdate[]): Promise<void>;
  onError(err: unknown): void;
  shouldStop(): boolean;
  sleep(ms: number): Promise<void>;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export async function pollLoop(deps: PollerDeps): Promise<void> {
  let backoff = BACKOFF_START_MS;
  for (;;) {
    if (deps.shouldStop()) return;
    try {
      const updates = await deps.client.getUpdates(deps.getOffset(), 50);
      if (updates.length > 0) {
        await deps.onUpdates(updates);
        deps.setOffset(updates[updates.length - 1].update_id + 1);
      }
      backoff = BACKOFF_START_MS;
    } catch (err) {
      if (deps.shouldStop()) return;
      deps.onError(err);
      if (err instanceof TgError && err.code === 409) return; // another poller owns the token
      await deps.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}

const MAX_429_RETRIES = 3;

/**
 * Ephemeral-payload methods: the content ages out during a 429 backoff, so a
 * retry (or a late success) ships stale state. They fail fast with
 * `retryAfter`; the caller (Mirror) paces the retry with fresh content.
 */
const NO_429_RETRY = new Set<string>(["sendRichMessageDraft"]);

export class TelegramClient {
  token: string;
  private fetchImpl: FetchLike;
  private sleep: (ms: number) => Promise<void>;

  constructor(token: string, opts: ClientOptions = {}) {
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One Bot API call: JSON POST, ok:false → TgError, 429 → sleep retry_after & retry (max 3). */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const max429 = NO_429_RETRY.has(method) ? 0 : MAX_429_RETRIES;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
      } catch (err) {
        throw new TgNetworkError(method, err);
      }
      let data: {
        ok: boolean;
        result?: unknown;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new TgNetworkError(method, new Error(`non-JSON response (HTTP ${res.status})`));
      }
      if (data.ok) return data.result;
      const code = data.error_code ?? 0;
      if (code === 429 && attempt < max429) {
        attempt++;
        await this.sleep((data.parameters?.retry_after ?? 3) * 1000);
        continue;
      }
      throw new TgError(method, code, data.description ?? "unknown error", data.parameters?.retry_after);
    }
  }

  getMe(): Promise<TgBotMe> {
    return this.call("getMe") as Promise<TgBotMe>;
  }

  /** Set the global bot menu (idempotent; the caller treats this best-effort). */
  setMyCommands(): Promise<unknown> {
    return this.call("setMyCommands", { commands: BOT_COMMANDS });
  }

  sendMessage(
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown; disableNotification?: boolean },
  ): Promise<TgSentMessage> {
    const p: Record<string, unknown> = { chat_id: chatId, text };
    if (opts?.parseMode) p.parse_mode = opts.parseMode;
    if (opts?.replyToId) p.reply_to_message = { message_id: opts.replyToId };
    if (opts?.replyMarkup) p.reply_markup = opts.replyMarkup;
    if (opts?.disableNotification) p.disable_notification = true;
    return this.call("sendMessage", p) as Promise<TgSentMessage>;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown },
  ): Promise<boolean> {
    try {
      const p: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
      if (opts?.parseMode) p.parse_mode = opts.parseMode;
      if (opts?.replyMarkup) p.reply_markup = opts.replyMarkup;
      await this.call("editMessageText", p);
      return true;
    } catch (err) {
      if (err instanceof TgError && err.code === 400 && /not modified/i.test(err.description)) return false;
      throw err;
    }
  }

  /** Idempotent: "Message to delete not found" (already deleted / too old) resolves. */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch (err) {
      if (err instanceof TgError && err.code === 400 && /not found/i.test(err.description)) return;
      throw err;
    }
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
    const p: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) p.text = text;
    return this.call("answerCallbackQuery", p);
  }

  sendRichMessage(
    chatId: number,
    richMessage: InputRichMessage,
    opts?: { replyToId?: number; disableNotification?: boolean },
  ): Promise<TgSentMessage> {
    const p: Record<string, unknown> = { chat_id: chatId, rich_message: richMessage };
    if (opts?.replyToId) p.reply_to_message = { message_id: opts.replyToId };
    if (opts?.disableNotification) p.disable_notification = true;
    return this.call("sendRichMessage", p) as Promise<TgSentMessage>;
  }

  /**
   * Creates or updates an ephemeral draft (~30 s window). `canStop` adds the
   * native Stop button, which produces a `stopped_message_generation` update;
   * `keepOnStop` keeps the draft when Stop is pressed (so the bot can
   * persist it as a real message). Returns true on success, false if the
   * draft no longer exists.
   */
  sendRichMessageDraft(
    chatId: number,
    draftId: number,
    richMessage: InputRichMessage,
    canStop?: boolean,
    keepOnStop?: boolean,
  ): Promise<boolean> {
    const p: Record<string, unknown> = { chat_id: chatId, draft_id: draftId, rich_message: richMessage };
    if (canStop) p.can_stop = true;
    if (keepOnStop) p.keep_on_stop = true;
    return this.call("sendRichMessageDraft", p) as Promise<boolean>;
  }

  getUpdates(offset: number, timeoutSec = 50): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query", "edited_message", "stopped_message_generation"] }) as Promise<TgUpdate[]>;
  }
}
