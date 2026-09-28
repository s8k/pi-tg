// End states (2026-09-04 Message Framework, D3/D4): one persistent send for
// the whole run —
//  - clean:  [log blocks] Completed ✔️ [answer]   (NO divider)
//  - stop:   [log blocks] [partial tail] ⚠️ Request was aborted   (SILENT —
//          the ⚠️ line is the BOTTOM line, not a log block; no spinner)
//  - error: agent_end does NOT finalize (pi may auto-retry the run). While
//          the stream is open (the retry's backoff, a recovery compaction)
//          the draft stays alive: the ⚠️ line, then a full-width `---`
//          divider, then the <tg-thinking> spinner (pi is still working).
//          agent_settled marks the end of the WHOLE stream (all retries and
//          continuations done) and persists ONE message:
//          [log blocks] [partial tail + ⚠ incomplete] ⚠️ error: <msg>
//          (the ⚠️ line is the BOTTOM line, NOTIFIES, no `⚠ Error` marker,
//          no spinner) — and the message ENDS WITH A `---` divider when it
//          has content beyond the bare ⚠️ line (a tool log / partial answer
//          above the error gets closed off; a bare error stays bare; the
//          ⚠️-aborted bottom never gets one). Only if agent_settled is lost
//          does the grace timer (cfg errorSettleMs) backstop persist the log.
//  - muted:  nothing at all.
// On a pi retry (agent_start again) the carried error moves INTO the log as
// a ⚠️ error: block, so the retried run's m1 carries the whole story.
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

/** the last blank-line-separated part of a composed message */
const lastBlock = (md: string): string => md.trimEnd().split(/\n\n+/).pop() ?? "";

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

test("manual stop: ONE message — log + partial answer + bottom line ⚠️ Request was aborted, SILENT", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "aborted" }));
  await tick();

  // live draft at the stop end: the aborted bottom line, no spinner
  const lastDraft = h.out.calls.filter((c) => c.kind === "sendDraft").pop()?.text ?? "";
  assert.ok(lastDraft.endsWith("⚠️ Request was aborted"), `the draft ends with the aborted bottom line: ${JSON.stringify(lastDraft)}`);
  assert.ok(!lastDraft.includes("<tg-thinking>"), "no spinner in the stopped draft");

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
  assert.equal(lastBlock(text), "⚠️ Request was aborted", "the ⚠️ line is the BOTTOM line (last), not a log line");
  assert.equal(text.split("⚠️ Request was aborted").length - 1, 1, "exactly one ⚠️ line");
  assert.equal(rich[0]?.opts?.disableNotification, true, "D4 is SILENT — no notification");
});

test("manual stop, spinner-only tail: log + aborted bottom line (nothing else to append), SILENT", async () => {
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
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚙ read ✔"), "the log is persisted");
  assert.ok(!text.includes("Completed ✔️"), "no marker");
  assert.equal(lastBlock(text), "⚠️ Request was aborted", "the ⚠️ line is the bottom line");
  assert.equal(rich[0]?.opts?.disableNotification, true, "SILENT");
});

test("error end: agent_end does NOT finalize (pi may retry); agent_settled persists ONE message — log + partial + ⚠ incomplete + ⚠️ error (LAST)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "error", errorMessage: "Provider timeout" }));
  await tick();
  await m.onAgentEnd([]); // the run ended — but the stream may continue (pi retry): no finalize yet
  await tick();
  assert.equal(richCalls(h).length, 0, "agent_end after an error persists nothing (the draft stays alive)");

  await m.onAgentSettled(); // the stream is over (no retry came) — finalize NOW
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, `one persistent send, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚠️ error: Provider timeout"), "the errorMessage is in the message");
  assert.ok(!text.includes("⚠ Error"), "no legacy error marker");
  assert.ok(text.includes("The answer is 42."), "the partial answer is preserved");
  assert.ok(text.includes("⚠ incomplete"), "the incomplete trailer is present");
  // strict order: log → partial answer → ⚠ incomplete → ⚠️ line → divider (LAST)
  const order = [text.indexOf("⚙ read ✔"), text.indexOf("The answer is 42."), text.indexOf("⚠ incomplete"), text.lastIndexOf("⚠️ error:")];
  assert.ok(order.every((i) => i >= 0), `all parts present, got: ${JSON.stringify(text)}`);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]! && order[2]! < order[3]!, `wrong order: ${order}`);
  const blocks = text.trimEnd().split(/\n\n+/);
  assert.equal(blocks[blocks.length - 2], "⚠️ error: Provider timeout", "the ⚠️ line is the bottom line, not a log line");
  assert.equal(blocks[blocks.length - 1], "---", "the persistent error message ENDS with the divider (content beyond the bare ⚠️ line)");
  assert.ok(!rich[0]?.opts?.disableNotification, "D3 NOTIFIES — the error is the final word");
});

test("error end: while the stream is open (a retry may come) the draft shows ⚠️ line, a `---` divider, then the spinner", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = await runWithStreamedCandidate(h, "");
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const lastDraft = h.out.calls.filter((c) => c.kind === "sendDraft").pop()?.text ?? "";
  assert.ok(/<tg-thinking>[^<>]+…<\/tg-thinking>$/.test(lastDraft), `the draft ends with the spinner (pi may still retry): ${JSON.stringify(lastDraft)}`);
  const oErr = lastDraft.lastIndexOf("⚠️ error: 502 status code (no body)");
  const oHr = lastDraft.lastIndexOf("---");
  const oSpin = lastDraft.lastIndexOf("<tg-thinking>");
  assert.ok(oErr >= 0, `the ⚠️ line is in the draft: ${JSON.stringify(lastDraft)}`);
  assert.ok(oErr < oHr && oHr < oSpin, `⚠️ line → divider → spinner, got: ${JSON.stringify(lastDraft)}`);
  assert.ok(!lastDraft.includes("⚠ incomplete"), "no finalize trailer while the stream is open");
});

test("error end, no partial answer: agent_settled persists log + error block only, no marker", async () => {
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

  await m.onAgentSettled(); // the stream is over — finalize NOW
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "one persistent send");
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("⚠️ error: boom"), "error line");
  assert.equal(lastBlock(text), "⚠️ error: boom", "the ⚠️ line is the bottom line");
  assert.ok(!text.includes("---"), "a BARE error (nothing beyond the ⚠️ line) ends with NO divider");
  assert.ok(!text.includes("⚠ Error"), "no legacy error marker");
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
  // the carried ⚠️ line moves INTO the log — it must KEEP the --- after it once the retry starts
  const draftsAfterRetry = h.out.calls.filter((c) => c.kind === "sendDraft");
  const retryDraft = draftsAfterRetry[draftsAfterRetry.length - 1]?.text ?? "";
  assert.ok(retryDraft.includes("⚠️ error: 502 status code (no body)"), "the carried error line is in the retry draft");
  assert.ok(retryDraft.indexOf("---") > retryDraft.indexOf("⚠️ error: 502"), `the divider follows the carried error in the retry draft: ${retryDraft}`);
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The retried answer."));
  await tick();
  await m.onAssistantEnd(textMsg("The retried answer.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `the retried run finalizes normally (m1 + m2), got ${rich.length}`);
  assert.equal(rich[1]?.text, "The retried answer.", "m2 is the retried answer");
  const m1 = rich[0]?.text ?? "";
  const b1 = m1.indexOf("⚠️ error: 502");
  const b2 = m1.indexOf("---");
  const b3 = m1.indexOf("Completed ✔️");
  assert.ok(b1 >= 0 && b1 < b2 && b2 < b3, `m1: carried error → divider → marker, got: ${m1}`);
  assert.ok(rich[0]?.text?.includes("⚠️ error: 502 status code (no body)"), "the failed attempt's error block is CARRIED INTO the retried run's m1 (no wipe of the live log)");

  await m.onAgentSettled(); // after the successful retry — a no-op (already finalized)
  await tick();
  assert.equal(richCalls(h).length, 2, "settled after a clean end persists nothing extra");
});

test("error → retry → error again: the CARRIED log persists exactly once, at the stream's agent_settled", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "first agent_end persists nothing (pi may retry)");

  m.onAgentStart(); // the retry, after the backoff — CARRIES OVER the log (no agent_settled in between)
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" });
  await tick();
  await m.onAgentEnd([]);
  await tick();
  assert.equal(richCalls(h).length, 0, "second agent_end persists nothing (the stream is still open)");

  await m.onAgentSettled(); // the stream is over (retries exhausted) — finalize NOW
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "the combined carried log persists exactly once");
  const text = rich[0]?.text ?? "";
  assert.equal(text.match(/⚠️ error: 502 status code \(no body\)/g)!.length, 2, "both failed attempts' error blocks are in the one message");
  assert.ok(!text.includes("<tg-thinking>"), "no spinner in the persistent message");
  const blocks = text.trimEnd().split(/\n\n+/);
  assert.equal(blocks[blocks.length - 2], "⚠️ error: 502 status code (no body)", "the bottom ⚠️ line is second-to-last");
  assert.equal(blocks[blocks.length - 1], "---", "ends with the divider (content beyond the bare ⚠️ line)");
});

test("muted run: nothing at all — no drafts, no persistent sends", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "mute" });
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
