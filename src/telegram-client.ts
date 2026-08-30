/** Structural fetch — the real global `fetch` satisfies it; tests inject a fake. */
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

const MAX_429_RETRIES = 3;

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
      if (code === 429 && attempt < MAX_429_RETRIES) {
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

  sendMessage(
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown },
  ): Promise<TgSentMessage> {
    const p: Record<string, unknown> = { chat_id: chatId, text };
    if (opts?.parseMode) p.parse_mode = opts.parseMode;
    if (opts?.replyToId) p.reply_to_message = { message_id: opts.replyToId };
    if (opts?.replyMarkup) p.reply_markup = opts.replyMarkup;
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
}
