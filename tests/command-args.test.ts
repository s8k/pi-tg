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
    { kind: "switchOk", chatId: 7, index: 2 },
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
    { kind: "mute", chatId: 7 },
    { kind: "unmute", chatId: 7 },
    { kind: "clear", chatId: 7, doIt: true },
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
});
