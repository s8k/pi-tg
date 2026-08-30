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
}
