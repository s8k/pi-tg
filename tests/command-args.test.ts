import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeInternal, parseInternal } from "../src/command-args.ts";
import type { TgAction } from "../src/router.ts";

test("round-trip: every dispatchable action", () => {
  const actions: TgAction[] = [
    { kind: "pair", chatId: 7, fromId: 42 },
    { kind: "start", chatId: 7 },
    { kind: "help", chatId: 7 },
    { kind: "new", chatId: 7 },
    { kind: "sessions", chatId: 7 },
    { kind: "sessionActivate", chatId: 7, index: 3 },
    { kind: "modelList", chatId: 7 },
    { kind: "modelSet", chatId: 7, index: 0 },
    { kind: "thinkingList", chatId: 7 },
    { kind: "thinkingSet", chatId: 7, index: 1 },
    { kind: "status", chatId: 7 },
    { kind: "stop", chatId: 7 },
    { kind: "compact", chatId: 7 },
    { kind: "nameSet", chatId: 7, name: "my name & stuff" },
    { kind: "killAsk", chatId: 7 },
    { kind: "kill", chatId: 7, yes: true },
    { kind: "kill", chatId: 7, yes: false },
    { kind: "level_mute", chatId: 7 },
    { kind: "level_minimal", chatId: 7 },
    { kind: "level_full", chatId: 7 },
    { kind: "clear", chatId: 7, doIt: true },
    { kind: "reload", chatId: 7 },
    { kind: "prompt", chatId: 7, text: "hello\nworld \"quoted\"" },
  ];
  for (const a of actions) {
    const enc = encodeInternal(a);
    assert.ok(enc !== null, `encode(${a.kind})`);
    assert.deepEqual(parseInternal(enc!), a, `round-trip ${a.kind}`);
  }
});

test("encode: undisplayable actions → null", () => {
  assert.equal(encodeInternal({ kind: "ignore" }), null);
  assert.equal(encodeInternal({ kind: "notAuthorized", chatId: 1, fromId: 2 }), null);
  assert.equal(encodeInternal({ kind: "unknown", chatId: 1, text: "x" }), null);
});

test("parse: garbage → null (never throws)", () => {
  assert.equal(parseInternal(""), null);
  assert.equal(parseInternal("help"), null);
  assert.equal(parseInternal("internal"), null);
  assert.equal(parseInternal("internal status"), null);
  assert.equal(parseInternal("internal status abc"), null);
  assert.equal(parseInternal("internal status -1"), null);
  assert.equal(parseInternal("internal bogus 7"), null);
  assert.equal(parseInternal("internal nameSet 7 not-json"), null);
  assert.equal(parseInternal("internal prompt 7 {1}"), null);
  assert.equal(parseInternal("internal sessionActivate 7 x"), null);
  assert.equal(parseInternal("internal kill 7 maybe"), null);
  assert.equal(parseInternal("internal switchOk 7 2"), null); // the dead switchOk action
});

test("dialog actions round-trip", () => {
  const a1: TgAction = { kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 7 };
  assert.deepEqual(parseInternal(encodeInternal(a1)!), a1);
  const a2: TgAction = { kind: "dialogCancel", chatId: 42, dialogId: 3 };
  assert.deepEqual(parseInternal(encodeInternal(a2)!), a2);
  const a3: TgAction = { kind: "dialogText", chatId: 42, replyToMessageId: 100, text: 'it\'s a "reply" /stop' };
  assert.deepEqual(parseInternal(encodeInternal(a3)!), a3);
  const a4: TgAction = { kind: "dialogPlain", chatId: 42, dialogId: 9, text: "Mr. Bean" };
  assert.deepEqual(parseInternal(encodeInternal(a4)!), a4);
  assert.equal(parseInternal("internal dialogPlain 42 {}"), null); // missing fields
  assert.equal(parseInternal("internal dialogPlain 42 {\"d\":9}"), null); // missing text
  assert.equal(parseInternal("internal dialogPlain 42 {\"d\":\"9\",\"t\":\"x\"}"), null); // d must be int
  // malformed → null (never crash)
  assert.equal(parseInternal("internal dialogAnswer 42 x 1"), null);
  assert.equal(parseInternal("internal dialogAnswer 42 3 -1"), null);
  assert.equal(parseInternal("internal dialogAnswer 42 3"), null); // missing index
  assert.equal(parseInternal("internal dialogAnswer 42 0 1"), null); // dialogId must be > 0
  assert.equal(parseInternal("internal dialogCancel 42 x"), null);
  assert.equal(parseInternal("internal dialogText 42 notjson"), null);
  assert.equal(parseInternal("internal dialogText 42 {}"), null); // missing fields
  assert.equal(parseInternal("internal dialogText 42 {\"r\":100}"), null); // missing text
  assert.equal(parseInternal("internal dialogText 42 {\"r\":\"100\",\"t\":\"x\"}"), null); // r must be int
});
