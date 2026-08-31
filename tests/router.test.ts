import { test } from "node:test";
import assert from "node:assert/strict";
import { route, CB } from "../src/router.ts";
import type { TgUpdate } from "../src/telegram-client.ts";

const chat = { id: 7, type: "private" };
const from = (id: number, bot = false) => ({ id, is_bot: bot });
const msgUpdate = (updateId: number, id: number, text: string, bot = false): TgUpdate => ({
  update_id: updateId,
  message: { message_id: 1, date: 1, chat, from: from(id, bot), text },
});
const cbUpdate = (updateId: number, id: number, data: string): TgUpdate => ({
  update_id: updateId,
  callback_query: { id: "cb" + updateId, from: from(id), message: { message_id: 1, date: 1, chat }, data },
});

test("ignore: no message, non-text, bot messages", () => {
  assert.deepEqual(route({ update_id: 1 }, 5), { kind: "ignore" });
  assert.deepEqual(route({ update_id: 2, edited_message: { message_id: 9, date: 1, chat, from: from(5), text: "x" } }, 5), { kind: "ignore" });
  assert.deepEqual(route(msgUpdate(3, 5, "hello", true), 5), { kind: "ignore" });
});

test("unpaired: /start → pair, anything else → notAuthorized", () => {
  assert.deepEqual(route(msgUpdate(1, 42, "/start"), undefined), { kind: "pair", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(2, 42, "/start@MyBot"), undefined), { kind: "pair", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(3, 42, "hi"), undefined), { kind: "notAuthorized", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(4, 42, "/new"), undefined), { kind: "notAuthorized", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(5, 42, "/mute"), undefined), { kind: "notAuthorized", chatId: 7, fromId: 42 });
});

test("paired: non-owner rejected; owner commands map", () => {
  assert.deepEqual(route(msgUpdate(1, 99, "/status"), 5), { kind: "notAuthorized", chatId: 7, fromId: 99 });
  const owner = 5;
  assert.deepEqual(route(msgUpdate(1, owner, "/start"), owner), { kind: "start", chatId: 7 });
  assert.deepEqual(route(msgUpdate(2, owner, "/help"), owner), { kind: "help", chatId: 7 });
  assert.deepEqual(route(msgUpdate(3, owner, "/new"), owner), { kind: "new", chatId: 7 });
  assert.deepEqual(route(msgUpdate(4, owner, "/sessions"), owner), { kind: "sessions", chatId: 7 });
  assert.deepEqual(route(msgUpdate(5, owner, "/models"), owner), { kind: "modelList", chatId: 7 });
  assert.deepEqual(route(msgUpdate(6, owner, "/thinking"), owner), { kind: "thinkingList", chatId: 7 });
  assert.deepEqual(route(msgUpdate(7, owner, "/status"), owner), { kind: "status", chatId: 7 });
  assert.deepEqual(route(msgUpdate(8, owner, "/stop"), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(msgUpdate(9, owner, "/stop@MyBot"), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(msgUpdate(10, owner, "/compact"), owner), { kind: "compact", chatId: 7 });
  assert.deepEqual(route(msgUpdate(11, owner, "/name My Project"), owner), { kind: "nameSet", chatId: 7, name: "My Project" });
  assert.deepEqual(route(msgUpdate(12, owner, "/kill"), owner), { kind: "killAsk", chatId: 7 });
  assert.deepEqual(route(msgUpdate(15, owner, "/mute"), owner), { kind: "mute", chatId: 7 });
  assert.deepEqual(route(msgUpdate(16, owner, "/unmute"), owner), { kind: "unmute", chatId: 7 });
  assert.deepEqual(route(msgUpdate(13, owner, "/bogus"), owner), { kind: "unknown", chatId: 7, text: "/bogus" });
  assert.deepEqual(route(msgUpdate(14, owner, "just some prompt text"), owner), { kind: "prompt", chatId: 7, text: "just some prompt text" });
});

test("callbacks: owner only, vocabulary maps, stale → ignore", () => {
  const owner = 5;
  assert.deepEqual(route(cbUpdate(1, 99, "stop"), owner), { kind: "notAuthorized", chatId: 7, fromId: 99 });
  assert.deepEqual(route(cbUpdate(1, owner, CB.STOP), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(cbUpdate(2, owner, CB.session(3)), owner), { kind: "sessionActivate", chatId: 7, index: 3 });
  assert.deepEqual(route(cbUpdate(3, owner, CB.sessionOk(2)), owner), { kind: "switchOk", chatId: 7, index: 2 });
  assert.deepEqual(route(cbUpdate(4, owner, CB.model(0)), owner), { kind: "modelSet", chatId: 7, index: 0 });
  assert.deepEqual(route(cbUpdate(5, owner, CB.thinking(1)), owner), { kind: "thinkingSet", chatId: 7, index: 1 });
  assert.deepEqual(route(cbUpdate(6, owner, CB.kill(true)), owner), { kind: "kill", chatId: 7, yes: true });
  assert.deepEqual(route(cbUpdate(7, owner, CB.kill(false)), owner), { kind: "kill", chatId: 7, yes: false });
  assert.deepEqual(route(cbUpdate(8, owner, CB.clear(true)), owner), { kind: "clear", chatId: 7, doIt: true });
  assert.deepEqual(route(cbUpdate(9, owner, CB.clear(false)), owner), { kind: "clear", chatId: 7, doIt: false });
  assert.deepEqual(route(cbUpdate(10, owner, "garbage"), owner), { kind: "ignore" });
  assert.deepEqual(route(cbUpdate(11, owner, "s:999999"), owner), { kind: "sessionActivate", chatId: 7, index: 999999 });
});

test("stopped_message_generation → stop (the draft's native Stop button)", () => {
  const a = route(
    { update_id: 9, stopped_message_generation: { chat: { id: 55, type: "private" }, draft_id: 3 } },
    42,
  );
  assert.deepEqual(a, { kind: "stop", chatId: 55 });
});
