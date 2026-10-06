// Token usage display (2026-09-05): the live draft's bottom line (the
//  spinner / compact status) and the finalized `Completed ✔️`
// line carry the current run's token usage — ` ↑<input> ↓<output>`,
// human-formatted (fmtTokens). Usage accumulates across ALL of the run's
// assistant messages (and across pi's auto-retries); a NEW run starts from
// zero. Error/stop ends carry no suffix (the ⚠️ line is the bottom line).
// Placement (2026-09-05, field report): the tokens live INSIDE the
//  tag — the rich renderer treats the tag as its own line, so
// text after the closing tag wraps to the NEXT line (observed live on the
// auto-compact status). Inside the tag is the only same-line placement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, fmtTokens, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

type H = ReturnType<typeof makeMirrorDeps>;

const draftCalls = (h: H) => h.out.calls.filter((c) => c.kind === "sendDraft");
const latest = (h: H, draftId: number): string => {
  const calls = draftCalls(h).filter((c) => c.draftId === draftId);
  return calls[calls.length - 1]?.text ?? "";
};
const richSends = (h: H) => h.out.calls.filter((c) => c.kind === "sendRich");

const msg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

test("fmtTokens: human formatting", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(567), "567");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1k");
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(12500), "12.5k");
  assert.equal(fmtTokens(999499), "999.5k");
  assert.equal(fmtTokens(999500), "1m");
  assert.equal(fmtTokens(1500000), "1.5m");
  assert.equal(fmtTokens(2000000), "2m");
});

test("live draft: the spinner line carries the in-flight message's usage", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  assert.match(latest(h, 1), /^\w+…$/, "no usage yet → bare spinner, no suffix");
  m.onAssistantStart(msg(""));
  m.onAssistantUpdate(msg("Thinking hard", { usage: { input: 567, output: 12 } }));
  await tick();
  assert.match(latest(h, 1), /\w+… ↑567 ↓12$/, "spinner + ` ↑in ↓out` on the spinner line");
});

test("usage-only updates (no text) still refresh the draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart({ role: "assistant", content: [{ type: "thinking", thinking: "a" }] });
  m.onAssistantUpdate(
    { role: "assistant", content: [{ type: "thinking", thinking: "a, b" }] },
  );
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "a, b" }], usage: { input: 100, output: 40 } });
  await tick();
  assert.match(latest(h, 1), /↑100 ↓40$/, "the latest usage lands in the draft even without a text change");
});

test("usage accumulates across the run's assistant messages", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(msg("Let me check."));
  await m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "t1", name: "read", arguments: {} },
    ],
    stopReason: "toolUse",
    usage: { input: 100, output: 50 },
  });
  m.onAssistantStart(msg(""));
  m.onAssistantUpdate(msg("The answer.", { usage: { input: 300, output: 115 } }));
  await tick();
  assert.match(latest(h, 1), /↑400 ↓165$/, "100+300 in, 50+115 out");
});

test("clean end: m1 shows Completed with the run's total usage", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(msg(""));
  m.onAssistantUpdate(msg("The answer.", { usage: { input: 567, output: 12500 } }));
  await m.onAssistantEnd(msg("The answer.", { stopReason: "stop", usage: { input: 567, output: 12500 } }));
  await tick();
  const m1 = richSends(h)[0]?.text ?? "";
  assert.ok(m1.includes("Completed ✔️ ↑567 ↓12.5k"), `m1 got: ${JSON.stringify(m1)}`);
});

test("error and stop ends carry no token suffix", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 5000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(msg("partial"));
  await m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    stopReason: "error",
    errorMessage: "boom",
    usage: { input: 100, output: 5 },
  });
  await m.onAgentEnd([]); // arms the grace timer (backstop for a lost agent_settled)
  await h.advance(6000); // the grace timer persists the error end
  await tick();
  const persisted = richSends(h)[0]?.text ?? "";
  assert.ok(persisted.includes("⚠️ error: boom"), persisted);
  assert.ok(!persisted.includes("↑"), `no suffix on the error end: ${JSON.stringify(persisted)}`);
});

test("a new run resets the counters", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(msg(""));
  m.onAssistantUpdate(msg("First answer.", { usage: { input: 900, output: 900 } }));
  await m.onAssistantEnd(msg("First answer.", { stopReason: "stop", usage: { input: 900, output: 900 } }));
  await tick();
  m.onAgentStart(); // the second run (fresh draft id — the first run's draft is finalized)
  m.onAssistantStart(msg(""));
  m.onAssistantUpdate(msg("Second.", { usage: { input: 10, output: 20 } }));
  await tick();
  const lastDraft = draftCalls(h).slice(-1)[0]?.text ?? "";
  assert.match(lastDraft, /↑10 ↓20$/, `the second run shows only its own usage, got: ${JSON.stringify(lastDraft)}`);
});

test("a pi retry carries the tokens over (cumulative across retries)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(msg("x"));
  await m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    stopReason: "error",
    errorMessage: "502",
    usage: { input: 100, output: 5 },
  });
  // pi's auto-retry: a continuation agent_start while the error end is live
  m.onAgentStart();
  m.onAssistantStart(msg("y"));
  m.onAssistantUpdate(msg("y2", { usage: { input: 200, output: 150 } }));
  await tick();
  assert.match(latest(h, 1), /↑300 ↓155$/, "100+200 in, 5+150 out");
});
