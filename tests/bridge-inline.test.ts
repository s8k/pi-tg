import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import { FakePi, FakeOut } from "./fake-pi.ts";
import { makeDeps, lastSend, lastRichText } from "./helpers.ts";
import { PICKER_BUTTON } from "../src/pi-commands.ts";

const owner = 7;

function setup(opts: ConstructorParameters<typeof FakePi>[0] = {}) {
  const pi = new FakePi(opts);
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  return { pi, out, bridge };
}

// ── pending runs: one-shot nonce map ──

test("pendingRuns: register → consume once; second consume and unknown nonces → undefined", () => {
  const { bridge } = setup();
  bridge.registerRun("ab12cd", "tg");
  assert.equal(bridge.consumeRun("ab12cd"), "tg");
  assert.equal(bridge.consumeRun("ab12cd"), undefined); // one-shot
  assert.equal(bridge.consumeRun("zzzzzz"), undefined);
});

test("pendingRuns: capped — the oldest entry evicts past 32", () => {
  const { bridge } = setup();
  for (let i = 0; i < 33; i++) bridge.registerRun(`n${String(i).padStart(5, "0")}`, "tg");
  assert.equal(bridge.consumeRun("n00000"), undefined); // evicted
  assert.equal(bridge.consumeRun("n00032"), "tg");
});

// ── cmdRun (tap / ▶ Run fallback) ──

test("cmdRun: a registered resource command runs via pi.runCommand (no ack message)", async () => {
  const { pi, out, bridge } = setup({ commands: [{ name: "skill:brainstorming", description: "d", source: "skill" }] });
  bridge.registerRun("ab12cd", "skill:brainstorming");
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  assert.deepEqual(pi.runCommands, [{ name: "skill:brainstorming", args: "" }]);
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0);
});

test("cmdRun: stale nonce is a silent no-op (one-shot — double taps die)", async () => {
  const { pi, out, bridge } = setup({ commands: [{ name: "myext", description: "d", source: "extension" }] });
  bridge.registerRun("ab12cd", "myext");
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "nope12" });
  assert.deepEqual(pi.runCommands, [{ name: "myext", args: "" }]);
});

test("cmdRun: a mapped built-in dispatches its existing TG flow (quit → kill confirm)", async () => {
  const { bridge, out } = setup();
  bridge.registerRun("ab12cd", "quit");
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  assert.ok(lastRichText(out).includes("terminates the pi process"));
});

test("cmdRun: a mapped built-in with args carries them (name → rename)", async () => {
  const { pi, bridge } = setup();
  bridge.registerRun("ab12cd", "name");
  // the table says /name takes a name argument — the tap has none, so the
  // existing nameSet usage reply fires (empty name)
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  assert.equal(pi.setNames.length, 0);
});

test("cmdRun: terminal-only built-in → the 🖥 explanation, nothing runs", async () => {
  const { pi, out, bridge } = setup();
  bridge.registerRun("ab12cd", "tree");
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd" });
  assert.equal(pi.runCommands.length, 0);
  assert.ok(lastSend(out).includes("terminal-only"));
});

test("cmdRun: with inlineMessageId the auto-sent card gets the ✅ stamp", async () => {
  const { out, bridge } = setup({ commands: [{ name: "myext", description: "d", source: "extension" }] });
  bridge.registerRun("ab12cd", "myext");
  await bridge.dispatch({ kind: "cmdRun", chatId: owner, nonce: "ab12cd", inlineMessageId: "inl-1" });
  const stamp = out.calls.find((c) => c.kind === "editInline");
  assert.ok(stamp, "the card is stamped");
  assert.equal(stamp?.inlineMessageId, "inl-1");
  assert.ok(String(stamp?.text).includes("✅"));
  assert.equal(String(stamp?.text), "/myext\n✅"); // the card is the bare command
});

// ── cmdSend (typed @bot /name args) ──

test("cmdSend: resource command runs with its args", async () => {
  const { pi, bridge } = setup({ commands: [{ name: "my-tpl", description: "d", source: "prompt" }] });
  await bridge.dispatch({ kind: "cmdSend", chatId: owner, name: "my-tpl", args: "arg1 arg2" });
  assert.deepEqual(pi.runCommands, [{ name: "my-tpl", args: "arg1 arg2" }]);
});

test("cmdSend: busy agent → refusal, nothing runs", async () => {
  const { pi, out, bridge } = setup({ busy: true, commands: [{ name: "myext", description: "d", source: "extension" }] });
  await bridge.dispatch({ kind: "cmdSend", chatId: owner, name: "myext", args: "" });
  assert.equal(pi.runCommands.length, 0);
  assert.ok(lastSend(out).includes("busy"));
});

test("cmdSend: manual compaction in flight → refusal, nothing runs", async () => {
  const { pi, out, bridge } = setup({ commands: [{ name: "myext", description: "d", source: "extension" }] });
  await bridge.dispatch({ kind: "compact", chatId: owner }); // raises the compact state
  assert.ok(pi.compactDone, "compact started");
  await bridge.dispatch({ kind: "cmdSend", chatId: owner, name: "myext", args: "" });
  assert.equal(pi.runCommands.length, 0);
  assert.ok(lastSend(out).includes("ompaction"));
  pi.compactDone!(true); // clean up the compact state
});

test("cmdSend: a name not in the session table → unknown-command reply (never dispatched)", async () => {
  const { pi, out, bridge } = setup();
  await bridge.dispatch({ kind: "cmdSend", chatId: owner, name: "ghost", args: "" });
  assert.equal(pi.runCommands.length, 0);
  assert.ok(lastSend(out).includes("Unknown command"));
});

test("cmdSend: mapped built-in with args (compact instructions) reaches the compact flow", async () => {
  const { pi, bridge } = setup();
  await bridge.dispatch({ kind: "cmdSend", chatId: owner, name: "compact", args: "keep the tests" });
  assert.equal(pi.compactInstructions, "keep the tests");
  pi.compactDone?.(true);
});

// ── importSet (/import <path> → switch session) ──

test("importSet: idle → the switch-session flow", async () => {
  const { pi, out, bridge } = setup();
  await bridge.dispatch({ kind: "importSet", chatId: owner, path: "/tmp/s.jsonl" });
  assert.deepEqual(pi.switchSessions, ["/tmp/s.jsonl"]);
  assert.ok(lastSend(out).includes("Switching session"));
});

test("importSet: busy → refusal; the current path → 'Already active'", async () => {
  const { pi, out, bridge } = setup({ busy: true, sessionPath: "/tmp/s.jsonl" });
  await bridge.dispatch({ kind: "importSet", chatId: owner, path: "/tmp/other.jsonl" });
  assert.equal(pi.switchSessions.length, 0);
  assert.ok(lastSend(out).includes("busy"));
  const { pi: pi2, out: out2, bridge: bridge2 } = setup({ sessionPath: "/tmp/s.jsonl" });
  await bridge2.dispatch({ kind: "importSet", chatId: owner, path: "/tmp/s.jsonl" });
  assert.equal(pi2.switchSessions.length, 0);
  assert.ok(lastSend(out2).includes("Already active"));
});

// ── cmdTerminal (typed terminal-only built-in) ──

test("cmdTerminal: the 🖥 explanation reply", async () => {
  const { out, bridge } = setup();
  await bridge.dispatch({ kind: "cmdTerminal", chatId: owner, name: "login" });
  assert.ok(lastSend(out).includes("terminal-only"));
  assert.ok(lastSend(out).includes("/login"));
});

// ── picker button on the help card (removed from /status 2026-10-11) ──

test("help card carries the ⌨️ Other Pi commands button (switch_inline_query_current_chat '/')", async () => {
  const { out, bridge } = setup();
  await bridge.dispatch({ kind: "help", chatId: owner });
  const help = out.calls.filter((c) => c.kind === "sendRich").pop()!;
  assert.deepEqual(help.opts?.replyMarkup, PICKER_BUTTON);
  assert.ok(lastRichText(out).includes("other Pi commands"), "the /help line mentions the picker for the other Pi commands");
});

test("status card has NO picker button (2026-10-11: the button lives on the /help card only)", async () => {
  const { out, bridge } = setup();
  await bridge.dispatch({ kind: "status", chatId: owner });
  const status = out.calls.filter((c) => c.kind === "sendRich").pop()!;
  assert.equal(status.opts?.replyMarkup, undefined);
});

test("start (pairing card + help) — the help card carries the button", async () => {
  const { out, bridge } = setup();
  await bridge.dispatch({ kind: "start", chatId: owner });
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.ok(rich.some((c) => c.opts?.replyMarkup === PICKER_BUTTON));
});
