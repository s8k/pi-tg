import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, TgError, TgNetworkError } from "../src/telegram-client.ts";
import { makeFakeFetch } from "./fake-fetch.ts";

test("call: ok:true → result, correct URL + JSON body", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { hello: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.deepEqual(await c.call("anyMethod", { a: 1 }), { hello: 1 });
  assert.equal(ff.calls[0].url, "https://api.telegram.org/botT/anyMethod");
  assert.equal(ff.calls[0].init?.method, "POST");
  assert.equal(ff.calls[0].init?.body, JSON.stringify({ a: 1 }));
});

test("call: ok:false → TgError(method, code, description)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "chat not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(
    c.call("sendMessage"),
    (e: unknown) => e instanceof TgError && e.code === 400 && e.description === "chat not found" && e.method === "sendMessage",
  );
});

test("call: 429 → sleep(retry_after) then retry", async () => {
  const sleeps: number[] = [];
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: "ok-now" } }));
  ff.queue.push({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } });
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await c.call("getUpdates"), "ok-now");
  assert.deepEqual(sleeps, [7000]);
  assert.equal(ff.calls.length, 2);
});

test("call: 429 exhausted (3 retries) → throws TgError(429)", async () => {
  const ff = makeFakeFetch(() => ({ status: 429, body: { ok: false, error_code: 429, description: "slow down", parameters: { retry_after: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  await assert.rejects(c.call("getUpdates"), (e: unknown) => e instanceof TgError && e.code === 429);
  assert.equal(ff.calls.length, 4);
});

test("call: network failure → TgNetworkError", async () => {
  const ff = makeFakeFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.call("getMe"), TgNetworkError);
});
