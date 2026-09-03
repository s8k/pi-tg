// End states (plan §5 table): clean/empty-log, manual stop (partial candidate
// as-is, spinner-only skip), error (⚠ Error + ⚠ incomplete), muted (nothing).
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
const draftCalls = (h: H): Call[] => h.out.calls.filter((c) => c.kind === "sendDraft");

/**
 * A run with one stamped tool block (non-empty log) whose answer message has
 * started streaming `text` into the slot. The final message_end is up to the
 * test (confirm / abort / error).
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
  m.onAssistantUpdate(textMsg(text));
  await tick();
  return m;
}

test("clean end, empty log: m1 skipped (no flip), the answer is message 2", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Just an answer."));
  await tick();
  await m.onAssistantEnd(textMsg("Just an answer.", { stopReason: "stop" }));
  await tick();

  const flips = draftCalls(h).filter((c) => c.text?.includes("Completed ✔️"));
  assert.equal(flips.length, 0, "no flip for an empty log");
  const rich = richCalls(h);
  assert.equal(rich.length, 1, "m1 is skipped; m2 only");
  assert.equal(rich[0]?.text, "Just an answer.");
});

test("manual stop: m1 = log with no bottom marker; m2 = partial candidate as-is", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚙ read a.ts ✔"), "m1 carries the stamped tool block");
  assert.ok(!m1.includes("Completed ✔️"), "no Completed marker on stop");
  assert.ok(!m1.includes("⚠ Error"), "no error marker on stop");
  assert.ok(!m1.includes("<tg-thinking>"), "bottom tag removed (no spinner either)");
  assert.equal(rich[1]?.text, "The answer is 42.", "m2 is the partial candidate as-is, no trailer");
});

test("manual stop, spinner-only slot: m2 is skipped", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "");
  // the answer message produced no text — the slot is at the spinner
  m.onAssistantUpdate(textMsg(""));
  await tick();
  await m.onAssistantEnd(textMsg("", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "m1 only — a spinner-only slot persists nothing");
  assert.ok(rich[0]?.text?.includes("⚙ read a.ts ✔"), "m1 is the log");
});

test("error end: m1 = log + error block + ⚠ Error; m2 = partial candidate + ⚠ incomplete", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithStreamedCandidate(h, "The answer is 42.");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "error", errorMessage: "Provider timeout" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚠ Error"), "m1 ends with the ⚠ Error marker");
  assert.ok(m1.includes("⚠️ error: Provider timeout"), "the errorMessage became an error block in the log");
  assert.equal(rich[1]?.text, "The answer is 42.\n\n⚠ incomplete", "m2 = partial candidate + trailing ⚠ incomplete");
});

test("error end, spinner-only slot: m2 is skipped, m1 still gets the error block + ⚠ Error", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  await m.onAssistantEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" });
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const rich = richCalls(h);
  assert.equal(rich.length, 1, "m1 only");
  const m1 = rich[0]?.text ?? "";
  assert.ok(m1.includes("⚠️ error: boom"), "error block");
  assert.ok(m1.includes("⚠ Error"), "⚠ Error marker");
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
