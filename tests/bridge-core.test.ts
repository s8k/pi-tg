import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText, timeAgo, type TelegramPi } from "../src/session-bridge.ts";
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
  assert.equal(lastSend(out), "⚡️ Message queued");
});

test("stop: idle → note only; busy → abort + note", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi.abortCalls, 1);
  assert.equal(lastSend(out), "⏹️ Stopping…");
  const pi2 = new FakePi();
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi2.abortCalls, 0);
  assert.ok(lastSend(out2).includes("idle"));
});

test("stop: busy → '⏹️ Stopping…' gets stamped '✔️' once the agent is idle again", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi.abortCalls, 1);
  const stopSend = out.calls.find((c) => c.kind === "send" && c.text === "⏹️ Stopping…");
  assert.ok(stopSend, "stop message sent");
  await new Promise((r) => setTimeout(r, 10)); // the stamp is fire-and-forget
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit, "the 'Stopping…' message is edited once idle");
  assert.equal(edit.messageId, stopSend.messageId);
  assert.equal(edit.text, "⏹️ Stopping… ✔️");
});

test("stop: waitForIdle rejects (context gone) → no stamp, no crash", async () => {
  const pi = new FakePi({ busy: true });
  const adapter = pi.build();
  adapter.waitForIdle = async () => { throw new Error("no active pi context"); };
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(adapter, out));
  await bridge.dispatch({ kind: "stop", chatId: 7 });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!out.calls.some((c) => c.kind === "edit"), "no stamp when the wait fails");
});

test("status: card format 📌/📁/🤖/📖/📨/🪙, plain session name, rounded context percent, session tokens", async () => {
  const pi = new FakePi({
    cwd: "/proj",
    model: { id: "m1", name: "Model One", provider: "p", reasoning: false },
    thinking: "high",
    contextUsage: { tokens: 90720, contextWindow: 120000, percent: 75.6 }, // → rounds to 76%
    messageCount: 171,
    sessionUsage: { input: 12500, output: 128000 }, // → human-formatted ↑12.5k ↓128k
  });
  const out = new FakeOut();
  await new SessionBridge(makeDeps(pi.build(), out)).dispatch({ kind: "status", chatId: 7 });
  const lines = lastSend(out).split("\n");
  assert.deepEqual(lines, [
    "📌 Untitled session — idle · 🔊 full", // plain name (no <b>), always-on level suffix
    "📁 dir: <code>/proj</code>",
    "🤖 model: Model One · 🧠 thinking: high",
    "📖 context: 76% (90720/120000)",
    "🪙 tokens: ↑12.5k ↓128k", // session cumulative, ALWAYS shown (↑0 ↓0 proves the wiring is live)
    "📨 messages: 171", // tokens sit ABOVE the messages line
  ]);

  // busy + muted + no model + no context usage
  const pi2 = new FakePi({ cwd: "/p", busy: true, sessionName: "My <sess>" });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2, { level: "mute" })).dispatch({ kind: "status", chatId: 7 });
  const lines2 = lastSend(out2).split("\n");
  assert.equal(lines2[0], "📌 My &lt;sess&gt; — busy · 🔇 mute");
  assert.equal(lines2[2], "🤖 model: n/a · 🧠 thinking: default");
  assert.equal(lines2[3], "📖 context: n/a");
  assert.equal(lines2[4], "🪙 tokens: ↑0 ↓0"); // no usage yet → zeros, still shown, above the messages line
});

test("status: 🔥 GPU line from probeGpu (single + multi); omitted when probe unavailable", async () => {
  const base = {
    cwd: "/proj",
    model: { id: "m1", name: "Model One", provider: "p", reasoning: false },
    thinking: "high" as const,
    contextUsage: { tokens: 90720, contextWindow: 120000, percent: 75.6 },
    messageCount: 171,
  };
  const gpu = { tempC: 67, utilPct: 96, memUsedGb: 14.19140625, memTotalGb: 24 };

  // makeDeps default: probe unavailable → no GPU line (base has no sessionUsage → ↑0 ↓0)
  const out0 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi(base).build(), out0)).dispatch({ kind: "status", chatId: 7 });
  const l0 = lastSend(out0).split("\n");
  assert.equal(l0.length, 6); // 📌 📁 🤖 📖 🪙 📨
  assert.equal(l0[4], "🪙 tokens: ↑0 ↓0");
  assert.ok(l0[5].startsWith("📨 messages: "));

  const out1 = new FakeOut();
  const deps1 = makeDeps(new FakePi(base).build(), out1);
  deps1.probeGpu = async () => [gpu];
  await new SessionBridge(deps1).dispatch({ kind: "status", chatId: 7 });
  assert.equal(lastSend(out1).split("\n")[6], "🔥 GPU: 67°C · 96% · 14.2/24.0 GB");

  const out2 = new FakeOut();
  const deps2 = makeDeps(new FakePi(base).build(), out2);
  deps2.probeGpu = async () => [gpu, { tempC: 72, utilPct: 50, memUsedGb: 8, memTotalGb: 24 }];
  await new SessionBridge(deps2).dispatch({ kind: "status", chatId: 7 });
  const lines = lastSend(out2).split("\n");
  assert.ok(lines[6].startsWith("🔥 GPU 0: 67°C"));
  assert.ok(lines[7].startsWith("🔥 GPU 1: 72°C"));
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
  assert.ok(texts[1].startsWith("📌 Untitled session — idle")); // the STATUS card (not the old session card)
  assert.ok(texts[1].includes("📨 messages:"));
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
  const evil: TelegramPi = { ...pi.build(), isIdle: () => { throw new Error("boom"); } };
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

test("pair: persists ownerChatId (the chat survives a restart right after pairing)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  assert.equal(deps.cfg.ownerChatId, 99);
});
