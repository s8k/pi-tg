import type { FetchLike } from "../src/telegram-client.ts";

export interface CapturedCall {
  url: string;
  init?: RequestInit;
}

export interface ScriptedResponse {
  status: number;
  body: unknown;
}

type Handler = (url: string, init?: RequestInit) => ScriptedResponse | never;

/**
 * Scripted fetch stand-in. Responses come from `queue` (FIFO) first, then `handler`.
 * Every call is recorded in `calls` for assertions.
 */
export function makeFakeFetch(handler?: Handler): {
  fetchImpl: FetchLike;
  calls: CapturedCall[];
  queue: ScriptedResponse[];
  setHandler(h: Handler): void;
} {
  const calls: CapturedCall[] = [];
  const queue: ScriptedResponse[] = [];
  let h = handler;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    let r = queue.shift();
    if (!r && h) r = h(url, init);
    if (!r) throw new Error(`fake-fetch: no response scripted for ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  };
  return { fetchImpl, calls, queue, setHandler: (x) => (h = x) };
}
