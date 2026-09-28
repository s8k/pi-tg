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

test("seen update ids: mark, isSeen, dedupe, cap 200 (newest kept)", () => {
  const s = new TelegramState();
  assert.equal(s.isSeen(7), false);
  s.markSeen(7);
  s.markSeen(7); // re-mark is a no-op
  s.markSeen(8);
  assert.equal(s.isSeen(7), true);
  assert.equal(s.isSeen(8), true);
  assert.equal(s.isSeen(9), false);
  assert.deepEqual(s.seenIds(), [7, 8]);
  for (let i = 100; i <= 304; i++) s.markSeen(i);
  const ids = s.seenIds();
  assert.equal(ids.length, 200);
  assert.equal(ids[0], 105);
  assert.equal(s.isSeen(104), false, "oldest evicted beyond the cap");
  assert.equal(s.isSeen(304), true);
});

test("restoreSeenIds: capped + copied", () => {
  const s = new TelegramState(0);
  const many = Array.from({ length: 250 }, (_, i) => i + 1);
  s.restoreSeenIds(many, 0);
  assert.equal(s.seenIds().length, 200);
  assert.equal(s.isSeen(50), false);
  assert.equal(s.isSeen(250), true);
});

test("restoreSeenIds: ids at/below the restored offset are dropped (never redeliverable)", () => {
  const s = new TelegramState(14);
  s.restoreSeenIds([10, 11, 14, 15, 16], 14);
  assert.deepEqual(s.seenIds(), [15, 16], "only ids above the offset remain as replay guard");
  assert.equal(s.isSeen(14), false);
  assert.equal(s.isSeen(15), true);
});
