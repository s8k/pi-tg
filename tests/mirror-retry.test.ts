// Retry carryover: when pi auto-retries a run that ended in a provider error
// (429/5xx/…), the stream continues: agent_end → agent_settled →
// agent.continue() → agent_start. The previous run's UN-PERSISTED work log
// (the tool calls the user has been watching live) must NOT be wiped from the
// draft — the continued run appends to the same log, and the final message
// carries the whole story (old blocks → ⚠️ error → retried blocks → marker).
//
// Regression: a 502 mid-run used to clear the draft — the retried run's first
// (failed) call became the only visible block, and the successful calls before
// the error vanished from the message the user was watching.
//
// If NO continuation arrives (not retryable / retries exhausted / user silent),
// the error log must still be persisted — after a grace window (cfg
// `errorSettleMs`), not immediately at agent_settled (the retry's backoff is
// 2 s by default; persisting earlier would double-post on a retry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";
import type { FakeOutCall } from "./fake-pi.ts";

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

const toolMsg = (id: string, name: string, text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "toolCall", id, name, arguments: {} }],
  ...extra,
});

/** A tool call that commits and then succeeds (✔). */
async function okTool(m: Mirror, id: string, name: string, text: string): Promise<void> {
  m.onAssistantStart(toolMsg(id, name, text));
  await m.onAssistantEnd(toolMsg(id, name, text));
  m.onToolEnd(id, false, "ok");
  await tick();
}

/** A tool call that commits and then fails (✖). */
async function badTool(m: Mirror, id: string, name: string, text: string, err: string): Promise<void> {
  m.onAssistantStart(toolMsg(id, name, text));
  await m.onAssistantEnd(toolMsg(id, name, text));
  m.onToolEnd(id, true, err);
  await tick();
}

const richCalls = (h: ReturnType<typeof makeMirrorDeps>): FakeOutCall[] => h.out.calls.filter((c) => c.kind === "sendRich");

test("502 mid-run then retry: the successful calls before the error survive in the final m1", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  // run 1: two successful tool calls, then a 502 ends the run
  await okTool(m, "c1", "read", "Reading the spec.");
  await okTool(m, "c2", "bash", "Checking the docs.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "no persistent send at agent_end (pi may retry)");
  // pi: agent_settled fires before the retry continuation — still no send (the backoff is in flight)
  await m.onAgentSettled();
  await tick();
  assert.equal(richCalls(h).length, 0, "no persistent send at settle yet (the retry window is open)");

  // the retried run starts (agent.continue() → agent_start)
  m.onAgentStart();
  await tick();
  // NO VISIBLE WIPE: the live draft must still show run 1's successful calls
  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  const lastDraft = drafts[drafts.length - 1];
  assert.ok(lastDraft, "the retried run has a live draft");
  const draftText = lastDraft.text ?? "";
  assert.ok(draftText.includes("⚙ read ✔"), `draft lost run 1's first call: ${draftText}`);
  assert.ok(draftText.includes("⚙ bash ✔"), `draft lost run 1's second call: ${draftText}`);
  assert.ok(draftText.includes("⚠️ error: 502 status code (no body)"), "the error block is visible in the draft");

  // the retried run re-issues work: a failing call, then confirms cleanly
  await badTool(m, "c3", "bash", "Retrying the extraction.", "Traceback…");
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Done."));
  await m.onAssistantEnd(textMsg("Done.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, "exactly m1 + m2");
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚙ read ✔"), "run 1's first tool block is in the final m1");
  assert.ok(m1.includes("⚙ bash ✔"), "run 1's second tool block is in the final m1");
  assert.ok(m1.includes("⚠️ error: 502 status code (no body)"), "the error block documents the interruption");
  assert.ok(m1.includes("⚙ bash ✖"), "the retried run's failed call is in the same log");
  assert.ok(m1.includes("Completed ✔️"), "the marker ends the combined log");
  // order: old blocks → error → retried block → marker
  const o1 = m1.indexOf("⚙ read ✔");
  const o2 = m1.indexOf("⚠️ error: 502");
  const o3 = m1.indexOf("⚙ bash ✖");
  const o4 = m1.indexOf("Completed ✔️");
  assert.ok(o1 !== -1 && o1 < o2 && o2 < o3 && o3 < o4, `wrong order in m1: ${m1}`);
  assert.equal(rich[1]?.text, "Done.", "m2 is the retried run's answer");
});

test("no continuation: the error log is persisted after the grace window (errorSettleMs)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Reading the spec.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "401 Unauthorized" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();
  await m.onAgentSettled();
  await tick();
  assert.equal(richCalls(h).length, 0, "not persisted immediately at settle (a retry may still be in its backoff)");
  h.advance(1000);
  await tick();
  const rich = richCalls(h);
  assert.equal(rich.length, 1, "persisted once after the grace window");
  assert.ok(rich[0]?.text?.includes("⚠️ error: 401 Unauthorized"), "the error is in the message");
  assert.ok(rich[0]?.text?.includes("⚙ read ✔"), "the successful call is in the message");
});

test("retry that fails again: the combined log persists exactly once", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "First call.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentEnd([]);
  await m.onAgentSettled();
  await tick();
  // retry 1 (carryover): fails again
  m.onAgentStart();
  await tick();
  await badTool(m, "c2", "bash", "Retrying.", "boom");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "503 Service Unavailable" }));
  await tick();
  await m.onAgentEnd([]);
  assert.equal(richCalls(h).length, 0, "still nothing after the second error end");
  // the stream settles (no further retries)
  await m.onAgentSettled();
  await tick();
  h.advance(1000);
  await tick();
  const rich = richCalls(h);
  assert.equal(rich.length, 1, "the whole combined log persists exactly once");
  const t = rich[0]?.text ?? "";
  assert.ok(t.includes("⚙ read ✔") && t.includes("⚙ bash ✖"), "both runs' blocks are in the one message");
  assert.ok(t.includes("⚠️ error: 502") && t.includes("⚠️ error: 503"), "both errors are documented");
});

test("a run that starts after the grace fired starts clean (the old log was already persisted)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Old work.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "401 Unauthorized" }));
  await tick();
  await m.onAgentEnd([]);
  await m.onAgentSettled();
  await tick();
  h.advance(1000);
  await tick();
  assert.equal(richCalls(h).length, 1, "the old error log was persisted by the grace timer");
  // the next prompt starts — its run must NOT inherit the already-persisted log
  m.onAgentStart();
  await tick();
  await okTool(m, "c2", "bash", "New work.");
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("New answer."));
  await m.onAssistantEnd(textMsg("New answer.", { stopReason: "stop" }));
  await tick();
  const rich = richCalls(h);
  assert.equal(rich.length, 3, "old error message + new m1 + new m2");
  assert.ok(!rich[1]?.text?.includes("⚙ read ✔"), "the new run's m1 does not carry the old log");
  assert.ok(rich[1]?.text?.includes("⚙ bash ✔"), "the new run's m1 has its own block");
  assert.equal(rich[2]?.text, "New answer.");
});

test("a fast new prompt inside the grace window continues the live log (truthful, no loss)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Old work.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "401 Unauthorized" }));
  await tick();
  await m.onAgentEnd([]);
  await m.onAgentSettled();
  await tick();
  // the user sends the next prompt before the grace fires (no retry was coming)
  m.onAgentStart();
  await tick();
  await okTool(m, "c2", "bash", "New work.");
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("New answer."));
  await m.onAssistantEnd(textMsg("New answer.", { stopReason: "stop" }));
  await tick();
  const rich = richCalls(h);
  assert.equal(rich.length, 2, "one combined m1 + m2 (the grace timer was cancelled, no separate error message)");
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚙ read ✔") && m1.includes("⚠️ error: 401") && m1.includes("⚙ bash ✔"), "the combined log keeps the old work, the error, and the new work");
  assert.equal(rich[1]?.text, "New answer.");
});
