import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText, timeAgo, type TelegaPi } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

test("prompt: idle → deliverAs 'now', no ack message", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "do it" });
  assert.deepEqual(pi.sentPrompts, [{ text: "do it", deliverAs: "now" }]);
  assert.equal(out.calls.length, 0);
});

test("prompt: busy → 'steer' + queued ack", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "next" });
  assert.deepEqual(pi.sentPrompts, [{ text: "next", deliverAs: "steer" }]);
  assert.equal(lastSend(out), "⚡ queued (applies after current tool step)");
});

test("stop: idle → note only; busy → abort + note", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi.abortCalls, 1);
  assert.ok(lastSend(out).startsWith("⏹"));
  const pi2 = new FakePi();
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi2.abortCalls, 0);
  assert.ok(lastSend(out2).includes("idle"));
});

test("status: renders cwd/model/thinking/context/messages + busy state", async () => {
  const pi = new FakePi({
    cwd: "/proj",
    model: { id: "m1", name: "Model One", provider: "p", reasoning: false },
    thinking: "high",
    contextUsage: { tokens: 1000, contextWindow: 2000, percent: 50 },
    messageCount: 12,
  });
  const out = new FakeOut();
  await new SessionBridge(makeDeps(pi.build(), out)).dispatch({ kind: "status", chatId: 7 });
  const t = lastSend(out);
  assert.ok(t.includes("/proj"));
  assert.ok(t.includes("Model One"));
  assert.ok(t.includes("thinking: high"));
  assert.ok(t.includes("50%"));
  assert.ok(t.includes("12"));
  assert.ok(t.includes("idle"));
});

test("pair: sets ownerId, sends welcome + card + help", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  assert.equal(deps.cfg.ownerId, 42);
  const texts = out.calls.map((c) => c.text).filter(Boolean) as string[];
  assert.equal(texts.length, 3);
  assert.ok(texts[0].includes("ID 42"));
  assert.ok(texts[1].startsWith("📌"));
  assert.ok(texts[2].includes("/help"));
});

test("notAuthorized: different text paired vs unpaired", async () => {
  const out = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out, { ownerId: undefined }))
    .dispatch({ kind: "notAuthorized", chatId: 1, fromId: 2 });
  assert.ok(lastSend(out).includes("Start"));
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out2)).dispatch({
    kind: "notAuthorized",
    chatId: 1,
    fromId: 2,
  });
  assert.ok(lastSend(out2).includes("another account"));
});

test("unknown + help", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.dispatch({ kind: "unknown", chatId: 7, text: "/wat" });
  assert.ok(lastSend(out).includes("/help"));
  await bridge.dispatch({ kind: "help", chatId: 7 });
  const t = lastSend(out);
  for (const c of ["/new", "/sessions", "/models", "/thinking", "/stop", "/compact", "/name", "/kill"]) {
    assert.ok(t.includes(c), `help missing ${c}`);
  }
  assert.ok(helpText().includes("&lt;text&gt;")); // escaped in HTML mode
});

test("dispatch: handler error → ⚠ to chat + TUI notice, never throws", async () => {
  const pi = new FakePi();
  const evil: TelegaPi = { ...pi.build(), isIdle: () => { throw new Error("boom"); } };
  const out = new FakeOut();
  const deps = makeDeps(evil, out);
  assert.throws(() => deps.pi.isIdle());
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "x" }); // prompt path calls isIdle()
  assert.ok(lastSend(out).includes("boom"));
  assert.equal(pi.uiNotices.length, 1);
  assert.equal(pi.uiNotices[0].level, "error");
});

test("timeAgo", () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), "5s ago");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(timeAgo(now - 3 * 3600_000, now), "3h ago");
  assert.equal(timeAgo(now - 2 * 86400_000, now), "2d ago");
  assert.match(timeAgo(now - 30 * 86400_000, now), /^\d{4}-\d{2}-\d{2}$/);
});
