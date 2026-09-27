import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramState } from "../src/state.ts";

test("sent ids: add, dedupe, cap 500 (newest kept)", () => {
  const s = new TelegramState();
  s.addSent(1);
  s.addSent(1);
  s.addSent(2);
  assert.deepEqual(s.sentIds(), [1, 2]);
  for (let i = 3; i <= 502; i++) s.addSent(i);
  const ids = s.sentIds();
  assert.equal(ids.length, 500);
  assert.equal(ids[0], 3);
  assert.equal(ids[499], 502);
});

test("drainSent: newest first + resets", () => {
  const s = new TelegramState();
  s.addSent(1);
  s.addSent(2);
  s.addSent(3);
  assert.deepEqual(s.drainSent(), [3, 2, 1]);
  assert.deepEqual(s.sentIds(), []);
});

test("restoreSentIds: capped + copied", () => {
  const s = new TelegramState();
  const many = Array.from({ length: 600 }, (_, i) => i + 1);
  s.restoreSentIds(many);
  assert.equal(s.sentIds().length, 500);
  many.push(9999);
  assert.equal(s.sentIds().length, 500); // stored copy, not the reference
});

test("offset lifecycle", () => {
  const s = new TelegramState(41);
  assert.equal(s.getOffset(), 41);
  s.setOffset(42);
  assert.equal(s.getOffset(), 42);
});

test("list caches: index + out of range", () => {
  const s = new TelegramState();
  s.setSessionList([{ path: "/a.jsonl", id: "a", modified: 1, messageCount: 3 }]);
  assert.equal(s.sessionAt(0)?.path, "/a.jsonl");
  assert.equal(s.sessionAt(1), undefined);
  s.setModelList(["m1", "m2"]);
  assert.equal(s.modelAt(1), "m2");
  assert.equal(s.modelAt(2), undefined);
  s.setThinkingList(["off", "high"]);
  assert.equal(s.thinkingAt(0), "off");
});
