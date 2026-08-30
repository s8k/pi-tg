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

test("sendMessage: HTML request with reply", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 5, chat: { id: 1, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  const msg = await c.sendMessage(1, "**hi**", { parseMode: "HTML", replyToId: 4 });
  assert.equal(msg.message_id, 5);
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { chat_id: 1, text: "**hi**", parse_mode: "HTML", reply_to_message: { message_id: 4 } });
});

test("sendMessage: parseMode null → no parse_mode key (plain fallback)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 6, chat: { id: 1, type: "plain" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.sendMessage(1, "<raw>", { parseMode: null });
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.equal("parse_mode" in body, false);
  assert.equal(body.text, "<raw>");
});

test("editMessageText: ok → true; 'Message is not modified' → false (no throw)", async () => {
  const ok = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c1 = new TelegramClient("T", { fetchImpl: ok.fetchImpl });
  assert.equal(await c1.editMessageText(1, 2, "x"), true);
  const nm = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Message is not modified" } }));
  const c2 = new TelegramClient("T", { fetchImpl: nm.fetchImpl });
  assert.equal(await c2.editMessageText(1, 2, "same"), false);
});

test("editMessageText: real error → throws TgError", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "message to edit not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.editMessageText(1, 999, "x"), TgError);
});

test("deleteMessage: 'Message to delete not found' → resolves (idempotent)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Message to delete not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.deleteMessage(1, 999); // must not throw
});

test("deleteMessage: real error → throws", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too old" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.deleteMessage(1, 1), TgError);
});

test("answerCallbackQuery: sends callback_query_id (+ optional text)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.answerCallbackQuery("cb-1", "ok");
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { callback_query_id: "cb-1", text: "ok" });
});
