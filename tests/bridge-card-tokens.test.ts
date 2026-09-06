// Session card token line (2026-09-05): the session's cumulative token usage
// (TelegaPi.sessionUsage — sum over the session's assistant messages) gets
// its OWN line ABOVE the messages line — `🪙 tokens: ↑<in> ↓<out>` (same
// format as /status) — and is omitted when the session has no usage yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

const card = (out: FakeOut): string =>
  out.calls.map((c) => c.text).find((t) => t?.startsWith("📌")) ?? "";

test("card: the tokens line sits ABOVE the messages line", async () => {
  const pi = new FakePi({
    sessionUsage: { input: 12500, output: 128000 },
    messageCount: 12,
    contextUsage: { tokens: 4500, contextWindow: 10000, percent: 45 },
  });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  await new SessionBridge(deps).dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  const lines = card(out).split("\n");
  assert.equal(lines[3], "🪙 tokens: ↑12.5k ↓128k");
  assert.equal(lines[4], "12 messages · context 45%");
});

test("card: no tokens line when the session has no usage yet", async () => {
  const pi = new FakePi({ messageCount: 3, contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 } });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  await new SessionBridge(deps).dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  const lines = card(out).split("\n");
  assert.equal(lines.length, 4); // no tokens line
  assert.equal(lines[3], "3 messages · context 10%");
});

test("card: tokens line without a context percentage", async () => {
  const pi = new FakePi({ sessionUsage: { input: 567, output: 89 }, messageCount: 4 });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  await new SessionBridge(deps).dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  const lines = card(out).split("\n");
  assert.equal(lines[3], "🪙 tokens: ↑567 ↓89");
  assert.equal(lines[4], "4 messages");
});
