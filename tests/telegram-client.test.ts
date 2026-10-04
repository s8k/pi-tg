import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, TgError, TgNetworkError, pollLoop } from "../src/telegram-client.ts";
import type { FetchLike, InputRichMessage } from "../src/telegram-client.ts";
import { BOT_COMMANDS } from "../src/bot-commands.ts";
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

test("sendRichMessageDraft: 429 is NOT retried (ephemeral payload) — one request, retryAfter surfaced", async () => {
  const ff = makeFakeFetch(() => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 25 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  await assert.rejects(
    c.sendRichMessageDraft(7, 1, { blocks: [{"type":"paragraph", text: "x"}]}),
    (e: unknown) => e instanceof TgError && e.code === 429 && e.retryAfter === 25,
  );
  assert.equal(ff.calls.length, 1, "the mirror paces the retry via its failure cooldown");
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

test("getUpdates: offset, timeout, allowed_updates", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: [] } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.getUpdates(42, 30);
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { offset: 42, timeout: 30, allowed_updates: ["message", "callback_query", "edited_message", "stopped_message_generation"] });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("pollLoop: delivers batches, advances offset, stops on flag", async () => {
  const delivered: number[] = [];
  let offset = 0;
  let stop = false;
  const ff = makeFakeFetch();
  ff.queue.push(
    { status: 200, body: { ok: true, result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, date: 1 } },
      { update_id: 2, message: { message_id: 2, chat: { id: 7, type: "private" }, date: 2 } },
    ] } },
    { status: 200, body: { ok: true, result: [] } },
  );
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const seen = new Set<number>();
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (n) => (offset = n),
    onUpdate: async (u) => { delivered.push(u.update_id); },
    isSeen: (id) => seen.has(id),
    markSeen: (id) => seen.add(id),
    onError: () => {},
    onConflict: () => {},
    shouldStop: () => stop,
    // real (short) timer: a no-op sleep would spin in microtasks and starve the event loop
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  await waitFor(() => delivered.length === 2); // per-update now: the whole batch lands in one tick
  stop = true;
  await p;
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(offset, 3);
});

test("pollLoop: network error → backoff(1s) then retry succeeds", async () => {
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  // call 1: network failure; call 2: one update; call 3+: empty, yielding like a real long poll
  let n = 0;
  const ff = makeFakeFetch(async () => {
    n++;
    if (n === 1) throw new Error("boom");
    if (n > 2) await new Promise((r) => setTimeout(r, 5));
    const updates = n === 2
      ? [{ update_id: 9, message: { message_id: 9, chat: { id: 7, type: "private" }, date: 9 } }]
      : [];
    return { status: 200, body: { ok: true, result: updates } };
  });
  let offset = 0;
  let stop = false;
  const delivered: number[] = [];
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (m) => (offset = m),
    onUpdate: async (u) => { delivered.push(u.update_id); },
    isSeen: () => false,
    markSeen: () => {},
    onError: (e) => errors.push(e),
    onConflict: (e) => { throw new Error("no conflicts expected"); },
    shouldStop: () => stop,
    // real (short) timer so the error path yields to the event loop; records the backoff ms
    sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
  });
  await waitFor(() => delivered.length === 1);
  stop = true;
  await p;
  assert.deepEqual(delivered, [9]);
  assert.equal(offset, 10);
  assert.equal(errors.length, 1);
  assert.ok(sleeps.includes(1000));
});

test("pollLoop: 409 conflict → onConflict (not onError), backoff, retry — never dies", async () => {
  // Two 409s (another poller active), then one update, then empty polls.
  let n = 0;
  const conflicts: unknown[] = [];
  const errors: unknown[] = [];
  const sleeps: number[] = [];
  const ff = makeFakeFetch(async () => {
    n++;
    if (n <= 2)
      return { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot client is running" } };
    if (n > 3) await new Promise((r) => setTimeout(r, 5)); // yield like a real long poll
    const updates = n === 3
      ? [{ update_id: 4, message: { message_id: 4, chat: { id: 7, type: "private" }, date: 4 } }]
      : [];
    return { status: 200, body: { ok: true, result: updates } };
  });
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  let offset = 0;
  let stop = false;
  const delivered: number[] = [];
  const seen = new Set<number>();
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (m) => (offset = m),
    onUpdate: async (u) => { delivered.push(u.update_id); },
    isSeen: (id) => seen.has(id),
    markSeen: (id) => seen.add(id),
    onError: (e) => errors.push(e),
    onConflict: (e) => conflicts.push(e),
    shouldStop: () => stop,
    sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
  });
  await waitFor(() => delivered.length === 1);
  stop = true;
  await p;
  assert.deepEqual(delivered, [4], "the loop survives the conflicts and delivers the later update");
  assert.equal(offset, 5);
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts[0] instanceof TgError && (conflicts[0] as TgError).code === 409);
  assert.equal(errors.length, 0, "a conflict is a warning, not a hard error");
  assert.ok(sleeps.includes(1000) && sleeps.includes(2000), "conflicts back off like any error");
});

test("pollLoop: generation signal aborted → in-flight long-poll dies at once, quiet exit", async () => {
  const ac = new AbortController();
  let calls = 0;
  // Emulates a 50 s long poll that hangs until the signal aborts it.
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    await new Promise<never>((resolve, reject) => {
      calls++;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => reject(new Error("test: long poll should have been aborted first")), 2000);
      if (init?.signal) {
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
      }
    })) as FetchLike;
  const client = new TelegramClient("T", { fetchImpl, sleep: async () => {} });
  const errors: unknown[] = [];
  const conflicts: unknown[] = [];
  const p = pollLoop({
    client,
    getOffset: () => 0,
    setOffset: () => {},
    onUpdate: async () => {},
    isSeen: () => false,
    markSeen: () => {},
    onError: (e) => errors.push(e),
    onConflict: (e) => conflicts.push(e),
    shouldStop: () => false, // the ONLY stop path here is the signal
    sleep: async () => {},
    signal: ac.signal,
  });
  await waitFor(() => calls >= 1);
  const t0 = Date.now();
  ac.abort();
  await p;
  assert.ok(Date.now() - t0 < 500, "exits promptly on abort, not at the long-poll timeout");
  assert.equal(errors.length, 0, "an abort is not an error — no toast");
  assert.equal(conflicts.length, 0);
});

test("call: aborted signal → rejects (AbortError → TgNetworkError), no retry", async () => {
  const ac = new AbortController();
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal) {
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
      }
    })) as FetchLike;
  const c = new TelegramClient("T", { fetchImpl });
  const p = c.call("getUpdates", {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => e instanceof TgNetworkError && /abort/i.test(String(e)));
});

test("pollLoop: already stopping → returns without any call", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: [] } }));
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  await pollLoop({
    client,
    getOffset: () => 0,
    setOffset: () => {},
    onUpdate: async () => {},
    isSeen: () => false,
    markSeen: () => {},
    onError: () => {},
    onConflict: () => {},
    shouldStop: () => true,
    sleep: async () => {},
  });
  assert.equal(ff.calls.length, 0);
});

test("sendRichMessage: rich_message param, optional reply_to_message", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 9, chat: { id: 7, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  const msg = await c.sendRichMessage(7, { blocks: [{"type":"paragraph", text: "| a | b |"}]}, { replyToId: 4 });
  assert.equal(msg.message_id, 9);
  assert.equal(ff.calls[0].url, "https://api.telegram.org/botT/sendRichMessage");
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { chat_id: 7, rich_message: { blocks: [{"type":"paragraph", text: "| a | b |"}]}, reply_to_message: { message_id: 4 } });
});

test("sendRichMessage: no replyToId omits reply_to_message", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 5, chat: { id: 7, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  const rich: InputRichMessage = { blocks: [{ type: "paragraph", text: "# hi" }] };
  await c.sendRichMessage(7, rich);
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.equal(body.chat_id, 7);
  assert.deepEqual(body.rich_message, rich);
  assert.ok(!("reply_to_message" in body));
});

test("sendRichMessage: disableNotification → disable_notification param; omitted when absent", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 5, chat: { id: 7, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.sendRichMessage(7, { blocks: [{"type":"paragraph", text: "x"}]}, { disableNotification: true });
  const b1 = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.equal(b1.disable_notification, true, "silent send carries disable_notification: true");
  await c.sendRichMessage(7, { blocks: [{"type":"paragraph", text: "y"}]});
  const b2 = JSON.parse(String(ff.calls[1].init?.body ?? "{}"));
  assert.ok(!("disable_notification" in b2), "a notifying send omits the param");
});

test("sendRichMessageDraft: draft_id + can_stop only when true; omitted when falsy", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.equal(await c.sendRichMessageDraft(7, 3, { blocks: [{"type":"paragraph", text: "x"}]}, true), true);
  assert.deepEqual(JSON.parse(String(ff.calls[0].init?.body)), { chat_id: 7, draft_id: 3, rich_message: { blocks: [{"type":"paragraph", text: "x"}]}, can_stop: true });
  assert.equal(await c.sendRichMessageDraft(7, 4, { blocks: [{"type":"paragraph", text: "y"}]}), true);
  const body2 = JSON.parse(String(ff.calls[1].init?.body));
  assert.equal("can_stop" in body2, false);
  assert.equal(body2.draft_id, 4);
});

test("sendRichMessageDraft: keep_on_stop only when true (drafts survive Stop so the bot can persist them)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.equal(await c.sendRichMessageDraft(7, 5, { blocks: [{"type":"paragraph", text: "x"}]}, true, true), true);
  assert.deepEqual(JSON.parse(String(ff.calls[0].init?.body)), {
    chat_id: 7,
    draft_id: 5,
    rich_message: { blocks: [{"type":"paragraph", text: "x"}]},
    can_stop: true,
    keep_on_stop: true,
  });
  assert.equal(await c.sendRichMessageDraft(7, 6, { blocks: [{"type":"paragraph", text: "y"}]}, true, false), true);
  const body2 = JSON.parse(String(ff.calls[1].init?.body));
  assert.equal("keep_on_stop" in body2, false, "falsy keepOnStop is omitted, not sent as false");
});

test("sendRichMessage: 400 surfaces as TgError (fallback trigger)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: rich message parse error" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.sendRichMessage(7, { blocks: [{"type":"paragraph", text: "<broken"}]}), (e: unknown) => e instanceof TgError && e.code === 400);
});

test("setMyCommands: posts the full menu (global scope, no language_code)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.equal(await c.setMyCommands(), true);
  assert.equal(ff.calls[0].url, "https://api.telegram.org/botT/setMyCommands");
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { commands: BOT_COMMANDS });
  assert.equal("scope" in body, false);
  assert.equal("language_code" in body, false);
});

// ── replay protection + per-update isolation (incident 2026-09-27: one /stop
// answered three times after an outage redelivered the same update batch) ──

test("pollLoop: replayed updates (regressed offset) are skipped — handled exactly once, offset never regresses", async () => {
  // Telegram redelivers the SAME batch twice (offset regressed after a crash /
  // 409 twin), then goes quiet like a real long poll.
  let n = 0;
  const batch = [
    { update_id: 5, message: { message_id: 5, chat: { id: 7, type: "private" }, date: 5 } },
    { update_id: 6, message: { message_id: 6, chat: { id: 7, type: "private" }, date: 6 } },
  ];
  const ff = makeFakeFetch(async () => {
    n++;
    if (n > 2) await new Promise((r) => setTimeout(r, 5));
    return { status: 200, body: { ok: true, result: n <= 2 ? batch : [] } };
  });
  let offset = 0;
  let stop = false;
  const seen = new Set<number>();
  const handled: number[] = [];
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (m) => (offset = m),
    onUpdate: async (u) => { handled.push(u.update_id); },
    isSeen: (id) => seen.has(id),
    markSeen: (id) => seen.add(id),
    onError: () => { throw new Error("no errors expected"); },
    onConflict: () => {},
    shouldStop: () => stop,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  await waitFor(() => handled.length === 2);
  stop = true;
  await p;
  assert.deepEqual(handled, [5, 6], "each update handled exactly once despite the replay");
  assert.equal(offset, 7, "offset advanced past the batch");
});

test("pollLoop: a throwing update is contained — error surfaced, batch continues, offset advances past it", async () => {
  let n = 0;
  const ff = makeFakeFetch(async () => {
    n++;
    if (n > 1) await new Promise((r) => setTimeout(r, 5));
    const updates = n === 1
      ? [
          { update_id: 10, message: { message_id: 10, chat: { id: 7, type: "private" }, date: 10 } },
          { update_id: 11, message: { message_id: 11, chat: { id: 7, type: "private" }, date: 11 } },
        ]
      : [];
    return { status: 200, body: { ok: true, result: updates } };
  });
  let offset = 0;
  let stop = false;
  const seen = new Set<number>();
  const errors: unknown[] = [];
  const handled: number[] = [];
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (m) => (offset = m),
    onUpdate: async (u) => {
      if (u.update_id === 10) throw new Error("handler boom");
      handled.push(u.update_id);
    },
    isSeen: (id) => seen.has(id),
    markSeen: (id) => seen.add(id),
    onError: (e) => errors.push(e),
    onConflict: () => {},
    shouldStop: () => stop,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  await waitFor(() => handled.length === 1 && errors.length === 1);
  stop = true;
  await p;
  assert.deepEqual(handled, [11], "the healthy update after the bad one was still processed");
  assert.equal(offset, 12, "offset advanced past BOTH updates — the bad one cannot wedge the batch");
  assert.equal(String(errors[0]), "Error: handler boom");
});
