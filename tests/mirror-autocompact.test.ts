// T6 lane 2: pi auto-compacts (pre-prompt threshold / overflow-with-retry)
// while the run's draft is LIVE. The draft swaps its bottom line for the C1
// status (🗜 Auto-compacting…) — the error grace is SUSPENDED so the draft
// cannot persist mid-compact (the overflow continuation is still coming) —
// and on success the stamped line (🗜 Context auto-compacted ✔️ <detail>)
// joins the work log, so the (retried) run's final message carries it. A
// failed auto-compact leaves the draft's state untouched (the ⚠️ notification
// is the caller's job — index.ts, C3). With no live draft the hooks are
// no-ops (lane 1, the bridge's standalone draft, owns the messaging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage, AUTO_COMPACT_STATUS, AUTO_COMPACT_DONE_TEXT, compactTokenDetail } from "../src/mirror.ts";
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

test("compactTokenDetail: before → after (two numbers) / before only / guards", () => {
  assert.equal(compactTokenDetail(128432, 21904), "128,432 → 21,904 tokens");
  assert.equal(compactTokenDetail(128432, undefined), "128,432 tokens");
  assert.equal(compactTokenDetail(undefined, 21904), undefined, "no before → no detail at all");
  assert.equal(compactTokenDetail(NaN, 21904), undefined);
  assert.equal(compactTokenDetail(128432, Infinity), "128,432 tokens", "a non-finite after degrades to before only");
  assert.equal(compactTokenDetail(128432, NaN), "128,432 tokens");
});

const drafts = (calls: FakeOutCall[]): FakeOutCall[] => calls.filter((c) => c.kind === "sendDraft");
const rich = (calls: FakeOutCall[]): FakeOutCall[] => calls.filter((c) => c.kind === "sendRich");
const lastDraft = (calls: FakeOutCall[]): FakeOutCall | undefined => drafts(calls).at(-1);

/**
 * An error-ended run with its retry window open (retryable 5xx). No
 * agent_settled in between: pi emits it only at the end of the WHOLE stream
 * (after any retry / recovery continuation), never between agent_end and the
 * retry's agent_start.
 */
async function errorRun(m: Mirror): Promise<void> {
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Reading the spec.");
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();
}

test("lane 2 (threshold): start → C1 status on the live draft; done → spinner back, stamped line survives to m1", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Reading the spec.");

  m.onAutoCompactStart();
  await tick();
  let last = lastDraft(h.out.calls);
  assert.ok(last?.text?.includes(AUTO_COMPACT_STATUS), `C1 status in the draft: ${last?.text}`);

  m.onAutoCompactDone("128,432 → 21,904 tokens");
  await tick();
  last = lastDraft(h.out.calls);
  assert.ok(!last?.text?.includes(AUTO_COMPACT_STATUS), "the status is gone after done");
  assert.ok(last?.text?.includes("⚙ read ✔"), "the run's log is still in the draft");

  // the run confirms; the stamped line must be in the final m1
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Done."));
  await m.onAssistantEnd(textMsg("Done.", { stopReason: "stop" }));
  await tick();
  const m1 = rich(h.out.calls)[0]?.text ?? "";
  assert.ok(m1.includes(`${AUTO_COMPACT_DONE_TEXT} 128,432 → 21,904 tokens`), `the stamped line is in m1 (space-joined, two numbers): ${m1}`);
  const oTool = m1.indexOf("⚙ read ✔");
  const oCompact = m1.indexOf(AUTO_COMPACT_DONE_TEXT);
  const oDone = m1.indexOf("Completed ✔️");
  assert.ok(oTool !== -1 && oTool < oCompact && oCompact < oDone, `wrong order in m1: ${m1}`);
  assert.equal(rich(h.out.calls)[1]?.text, "Done.", "m2 is the answer");
});

test("lane 2 (overflow-with-retry): the grace is suspended during the compact; the retried run carries the stamped line", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  await errorRun(m);
  assert.equal(rich(h.out.calls).length, 0, "nothing persisted yet (the retry window is open)");

  // pi auto-compacts (overflow recovery) while the grace window is open
  m.onAutoCompactStart();
  await tick();
  h.advance(1000); // the WHOLE grace window passes during the compact
  await tick();
  assert.equal(rich(h.out.calls).length, 0, "no persistence mid-compact (the grace is suspended)");

  m.onAutoCompactDone("128,432 → 21,904 tokens");
  await tick();
  let last = lastDraft(h.out.calls);
  assert.ok(last?.text?.includes("⚠️ error: 502 status code (no body)"), "the error bottom is back: " + last?.text);

  // pi continues the run (agent.continue() → agent_start)
  m.onAgentStart();
  await tick();
  await badTool(m, "c2", "bash", "Retrying.", "boom");
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Done."));
  await m.onAssistantEnd(textMsg("Done.", { stopReason: "stop" }));
  await tick();

  const m1 = rich(h.out.calls)[0]?.text ?? "";
  assert.ok(m1.includes("⚙ read ✔"), "run 1's tool block survives");
  assert.ok(m1.includes(`${AUTO_COMPACT_DONE_TEXT} 128,432 → 21,904 tokens`), "the stamped line is in the final m1");
  assert.ok(m1.includes("⚠️ error: 502 status code (no body)"), "the interruption is documented");
  assert.ok(m1.includes("⚙ bash ✖"), "the retried run's failed call is in the same log");
  assert.ok(m1.includes("Completed ✔️"), "the marker ends the combined log");
  // order: old block → compact line → error line → retried block → marker
  const o1 = m1.indexOf("⚙ read ✔");
  const o2 = m1.indexOf(AUTO_COMPACT_DONE_TEXT);
  const o3 = m1.indexOf("⚠️ error: 502");
  const o4 = m1.indexOf("⚙ bash ✖");
  const o5 = m1.indexOf("Completed ✔️");
  assert.ok(o1 < o2 && o2 < o3 && o3 < o4 && o4 < o5, `wrong order in m1: ${m1}`);
  const oDiv = m1.indexOf("─", o3);
  assert.ok(oDiv > o3 && oDiv < o4, `the divider separates the carried error from the retried block: ${m1}`);
});

test("lane 2: failed → the draft reverts to the error state; the grace is re-armed", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  await errorRun(m);

  m.onAutoCompactStart();
  await tick();
  m.onAutoCompactFailed();
  await tick();
  const last = lastDraft(h.out.calls);
  assert.ok(!last?.text?.includes(AUTO_COMPACT_STATUS), "the status is gone after the failure");
  assert.ok(last?.text?.includes("⚠️ error: 502 status code (no body)"), "the error bottom is back");

  h.advance(1000);
  await tick();
  assert.equal(rich(h.out.calls).length, 1, "the error log still persists after the re-armed grace window");
  const t = rich(h.out.calls)[0]?.text ?? "";
  assert.ok(t.includes("⚠️ error: 502") && t.includes("⚙ read ✔"), "the error log is intact");
  assert.ok(!t.includes(AUTO_COMPACT_DONE_TEXT), "no done line — the compaction never succeeded");
});

test("error end + auto-compact in flight: the draft shows the C1 status while compacting (not the error line)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  await errorRun(m);
  assert.equal(rich(h.out.calls).length, 0, "nothing persisted while the stream is open");

  m.onAutoCompactStart();
  await tick();
  const last = lastDraft(h.out.calls);
  assert.ok(last?.text?.includes(AUTO_COMPACT_STATUS), `C1 status while compacting: ${last?.text}`);
  assert.ok(!last?.text?.includes("⚠️ error:"), "the error line is hidden while the compact runs (nothing is persisted yet)");
  assert.ok(!last?.text?.includes("─"), "no divider while the C1 status is up");
});

test("lane 2 hooks are no-ops without a live draft (lane 1 owns the messaging)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAutoCompactStart();
  m.onAutoCompactDone("128,432 tokens");
  m.onAutoCompactFailed();
  await tick();
  assert.equal(h.out.calls.length, 0, "no draft activity at all without a run");
  assert.equal(m.hasLiveDraft(), false);

  // and after a run has FINALIZED (post-run threshold: the draft is gone)
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("x"));
  await m.onAssistantEnd(textMsg("x", { stopReason: "stop" }));
  await tick();
  const before = h.out.calls.length;
  m.onAutoCompactStart();
  m.onAutoCompactDone("128,432 tokens");
  await tick();
  assert.equal(h.out.calls.length, before, "no change on a finalized run");
  assert.equal(m.hasLiveDraft(), false);
});

// Lane 1 (no live draft when the compact started): the bridge owns the
// compact's messaging, but a LIVE run whose draft is dead (retired by a
// dialog segment) must get its spinner back at compact-END — not at the
// next message_start (prefill can take seconds on a local LLM; the phone
// would sit blind between the stamped compact message and the first
// streamed message — live report 2026-09-27, same contract as the
// post-dialog respawn).
test("lane 1 done: a live run with a dead draft gets its spinner back immediately", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  await okTool(m, "c1", "read", "Reading the spec.");
  // a mirrored dialog retires the draft (segment); the run stays live
  await m.pauseForDialog();
  await tick();
  assert.equal(m.hasLiveDraft(), false, "precondition: the draft is retired");
  const before = drafts(h.out.calls).length;
  m.onLane1CompactDone();
  await tick();
  const after = drafts(h.out.calls).slice(before);
  assert.equal(after.length, 1, "the spinner draft is re-sent at compact-end");
  assert.ok(after[0].blocks?.some((b) => b.type === "thinking"), `it is the thinking spinner: ${after[0].text}`);
});

test("lane 1 done guards: a live draft (lane 2 owns it) or a finalized run → no-op", async () => {
  // live draft: lane 2's own done/failure hooks manage it — no double send
  const h2 = makeMirrorDeps({ streamEditMs: 0 });
  const m2 = new Mirror(h2.deps);
  m2.onAgentStart();
  await tick();
  m2.onAutoCompactStart();
  await tick();
  const b2 = drafts(h2.out.calls).length;
  m2.onLane1CompactDone();
  await tick();
  assert.equal(drafts(h2.out.calls).length, b2, "live draft: no extra send");

  // finalized run: nothing to respawn
  const h1 = makeMirrorDeps({ streamEditMs: 0 });
  const m1 = new Mirror(h1.deps);
  m1.onAgentStart();
  await tick();
  m1.onAssistantStart(textMsg(""));
  m1.onAssistantUpdate(textMsg("x"));
  await m1.onAssistantEnd(textMsg("x", { stopReason: "stop" }));
  await tick();
  const b1 = h1.out.calls.length;
  m1.onLane1CompactDone();
  await tick();
  assert.equal(h1.out.calls.length, b1, "finalized: no draft");
});
