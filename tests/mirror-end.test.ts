// End states (2026-09-03 single-message flow): one persistent send for the
// whole run —
//  - clean:  [log blocks] Completed ✔️ [answer]   (NO divider)
//  - stop:   [log blocks] [partial tail]   (no marker, no divider, no spinner)
//  - error: agent_end does NOT finalize (pi may auto-retry the run); the
//          draft stays alive. Only agent_settled (the end of the stream —
//          retries exhausted / not retryable) persists ONE message:
//          [log blocks] [partial tail + ⚠ incomplete] — NO `⚠ Error` marker
//          (the `⚠️ error: …` log block already says it), NO divider
//  - muted:  nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import type { FakeOutCall } from "./fake-pi.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

type H = ReturnType<typeof makeMirrorDeps>;
type Call = FakeOutCall;

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

const richCalls = (h: H): Call[] => h.out.calls.filter((c) => c.kind === "sendRich");

/**
 * A run with one stamped tool block (non-empty log) whose answer message has
 * started streaming `text`. The final message_end is up to the test
 * (confirm / abort / error).
 */
async function runWithStreamedCandidate(h: H, text: string): Promise<Mirror> {
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "check it" },
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "check it" },
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  m.onAssistantStart(textMsg(""));
  if (text) m.onAssistantUpdate(textMsg(text));
  await tick();
  return m;
}

test("clean end, empty log: m1 = Completed ✔️, m2 = the answer", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Just an answer."));
  await tick();
  await m.onAssistantEnd(textMsg("Just an answer.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  assert.equal(rich[0]?.text, "Completed ✔️", "m1 is the completion marker");
  assert.equal(rich[1]?.text, "Just an answer.", "m2 is the answer");
});

test("clean end, with log: m1 = log + Completed ✔️ (answer cut), m2 = the answer", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚙ read ✔"), "the stamped tool block is in m1");
  assert.ok(m1.includes("Let me check."), "the committed narration is in m1");
  assert.ok(m1.includes("Completed ✔️"), "the marker ends m1");
  assert.ok(!m1.includes("The answer is 42."), "the answer is cut from m1");
  assert.ok(!m1.includes("---"), "no divider in m1 (there is no answer after it)");
  assert.ok(!m1.includes("<tg-thinking>"), "the spinner is gone");
  assert.equal(rich[1]?.text, "The answer is 42.", "m2 is the answer");

  // the draft's completed state (visible before m1 lands) carried the full
  // composed message: log → marker → answer (NO divider)
  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  const preview = drafts[drafts.length - 1]?.text ?? "";
  assert.ok(!preview.includes("---"), "no divider in the completed state");
  const order = [preview.indexOf("⚙ read ✔"), preview.indexOf("Completed ✔️"), preview.indexOf("The answer is 42.")];
  assert.ok(order.every((i) => i >= 0), `all parts in the preview, got: ${JSON.stringify(preview)}`);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `wrong preview order: ${order}`);
});

test("manual stop: ONE message — log + partial answer, no marker, no divider, no spinner", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, `one persistent send, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚙ read ✔"), "the stamped tool block is in the log part");
  assert.ok(text.includes("The answer is 42."), "the partial answer is preserved");
  assert.ok(!text.includes("Completed ✔️"), "no Completed marker on stop");
  assert.ok(!text.includes("⚠ Error"), "no error marker on stop");
  assert.ok(!text.includes("---"), "no divider without a marker");
  assert.ok(!text.includes("<tg-thinking>"), "no spinner");
});

test("manual stop, spinner-only tail: log only (nothing to append)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "");
  m.onAssistantUpdate(textMsg(""));
  await tick();
  await m.onAssistantEnd(textMsg("", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "one persistent send");
  assert.ok(rich[0]?.text?.includes("⚙ read ✔"), "the log is persisted");
  assert.ok(!rich[0]?.text?.includes("Completed ✔️"), "no marker");
});

test("error end: agent_end does NOT finalize (pi may retry); agent_settled persists ONE message — log + error block + partial + ⚠ incomplete, NO ⚠ Error marker", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "error", errorMessage: "Provider timeout" }));
  await tick();
  await m.onAgentEnd([]); // the run ended — but pi may auto-retry: no finalize yet
  await tick();
  assert.equal(richCalls(h).length, 0, "agent_end after an error persists nothing (the draft stays alive)");

  await m.onAgentSettled(); // the end of the stream — no retry is coming
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, `one persistent send, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚠️ error: Provider timeout"), "the errorMessage became an error block in the log");
  assert.ok(!text.includes("⚠ Error"), "no second error marker — the log block already says it");
  assert.ok(!text.includes("---"), "no divider");
  assert.ok(text.includes("The answer is 42."), "the partial answer is preserved");
  assert.ok(text.includes("⚠ incomplete"), "the incomplete trailer is present");
  const order = [text.indexOf("⚠️ error:"), text.indexOf("The answer is 42."), text.indexOf("⚠ incomplete")];
  assert.ok(order.every((i) => i >= 0), `all parts present, got: ${JSON.stringify(text)}`);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `wrong order: ${order}`);
});

test("error end, no partial answer: settled persists log + error block only, no marker", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" });
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "agent_end persists nothing");

  await m.onAgentSettled();
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "one persistent send");
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚠️ error: boom"), "error block");
  assert.ok(!text.includes("⚠ Error"), "no second error marker");
});

test("retryable error (502): nothing is persisted, the draft stays alive, and the retried run can still finalize", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "");
  // the answer message fails mid-stream (502, no text) — pi will auto-retry
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]); // the run ended, but the stream continues (retry)
  await tick();

  assert.equal(richCalls(h).length, 0, "no persistent send while pi is about to retry");
  const draftsSoFar = h.out.calls.filter((c) => c.kind === "sendDraft").length;
  assert.ok(draftsSoFar > 0, "the draft was alive during the run");

  // pi retries: a fresh run streams and confirms cleanly
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The retried answer."));
  await tick();
  await m.onAssistantEnd(textMsg("The retried answer.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `the retried run finalizes normally (m1 + m2), got ${rich.length}`);
  assert.equal(rich[1]?.text, "The retried answer.", "m2 is the retried answer");
  assert.ok(!rich[0]?.text?.includes("⚠️ error:"), "the error block of the failed attempt is not in the retried run's m1");

  await m.onAgentSettled(); // after the successful retry — a no-op (already finalized)
  await tick();
  assert.equal(richCalls(h).length, 2, "settled after a clean end persists nothing extra");
});

test("error → retry → error again: only the settled end persists, one message", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "first agent_end persists nothing");

  m.onAgentStart(); // the retry
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "second agent_end persists nothing");

  await m.onAgentSettled(); // retries exhausted — the stream is over
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "the settled end persists one message");
  assert.ok(rich[0]?.text?.includes("⚠️ error: 502 status code (no body)"), "the error block is persisted");
});

test("muted run: nothing at all — no drafts, no persistent sends", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, muted: true });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Hi."));
  await tick();
  await m.onAssistantEnd(textMsg("Hi.", { stopReason: "stop" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(h.out.calls.length, 0, `no out calls at all, got: ${JSON.stringify(h.out.calls.map((c) => c.kind))}`);
});
