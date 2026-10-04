// Output levels (2026-09-06 design): the level is a render filter over the
// existing single-draft pipeline — mute = nothing, minimal = visible text
// only (narration + answer) with the SAME bottom line, full = today's
// behavior (regression-covered by the existing mirror-* test files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, blocksForLevel, type LogBlock, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

const LOG: LogBlock[] = [
  { type: "narration", text: "Let me check." },
  { type: "tool", id: "c1", name: "read", argsJson: '{"path":"a.ts"}', state: "✔" },
  { type: "prompt", text: "⚠️ terminal prompt — answer there" },
  { type: "agentError", text: "⚠️ error: 502" },
  { type: "narration", text: "Done thinking." },
];

test("blocksForLevel: full keeps everything (same array, no copy)", () => {
  assert.equal(blocksForLevel("full", LOG), LOG);
});

test("blocksForLevel: mute keeps nothing", () => {
  assert.deepEqual(blocksForLevel("mute", LOG), []);
});

test("blocksForLevel: minimal keeps narration only", () => {
  assert.deepEqual(blocksForLevel("minimal", LOG), [
    { type: "narration", text: "Let me check." },
    { type: "narration", text: "Done thinking." },
  ]);
});

test("minimal draft: visible text only, same bottom line, no tool/thinking lines", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  // message 1: thinking + narration + tool call (committed at message_end)
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
  // message 2: the answer starts streaming (the partial answer is visible text)
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is"));
  await tick();

  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  assert.ok(drafts.length > 0, "the draft is spawned at minimal");
  const latest = drafts[drafts.length - 1]?.text ?? "";
  assert.ok(latest.includes("Let me check."), `committed narration is in the draft: ${JSON.stringify(latest)}`);
  assert.ok(latest.includes("The answer is"), `the partial answer streams in: ${JSON.stringify(latest)}`);
  assert.ok(!latest.includes("⚙ read"), `no tool line: ${JSON.stringify(latest)}`);
  assert.ok(!latest.includes("check it"), `no thinking text: ${JSON.stringify(latest)}`);
  const call = h.out.calls.filter((c) => c.kind === "sendDraft").at(-1)!;
  assert.ok((call.blocks ?? []).some((b) => b.type === "thinking"), `the thinking bottom line is present: ${JSON.stringify(latest)}`);
});

test("full draft: unchanged — tool line AND narration both render (regression)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 }); // level defaults to full
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  const latest = drafts[drafts.length - 1]?.text ?? "";
  assert.ok(latest.includes("⚙ read ✔"), `full keeps the stamped tool line: ${JSON.stringify(latest)}`);
  assert.ok(latest.includes("Let me check."), `full keeps the narration: ${JSON.stringify(latest)}`);
});

// ── finalize: minimal = exactly ONE persistent message per run ──

test("minimal clean end: ONE persistent message (no m1/m2 split, no pre-edit), notifies", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  // message 1: narration + tool (committed to the log — invisible at minimal)
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  // message 2: the answer — confirms the run
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  await tick();
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `exactly one persistent message, got ${rich.length}: ${JSON.stringify(rich.map((r) => r.text))}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Let me check."), `visible narration is in the message: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("⚙ read"), `no tool line: ${JSON.stringify(text)}`);
  assert.ok(text.includes("Completed ✔️"), `the completion marker: ${JSON.stringify(text)}`);
  assert.ok(text.includes("The answer is 42."), `the answer: ${JSON.stringify(text)}`);
  const order = [text.indexOf("Let me check."), text.indexOf("Completed ✔️"), text.indexOf("The answer is 42.")];
  assert.ok(order.every((i) => i >= 0), `all parts present: ${JSON.stringify(text)}`);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `narration → marker → answer: ${JSON.stringify(text)}`);
  assert.ok(!rich[0]?.opts?.disableNotification, "the one message notifies");
  // the completed-state draft pre-edit (full's step 1) must NOT happen at minimal
  const preEdits = h.out.calls.filter((c) => c.kind === "sendDraft" && (c.text ?? "").includes("Completed"));
  assert.equal(preEdits.length, 0, "no completed-state draft pre-edit at minimal");
});

test("minimal error end: ONE message — visible text + ⚠ incomplete + error footer, notifies", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Working on it…"));
  await tick();
  await m.onAssistantEnd(textMsg("Working on it…", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentSettled(); // the stream is over — the error end persists now
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `one persistent message, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Working on it…"), `visible text so far: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠ incomplete"), `the incomplete flag: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠️ error: 502 status code (no body)"), `the error footer: ${JSON.stringify(text)}`);
  assert.ok(!rich[0]?.opts?.disableNotification, "the error end notifies");
});

test("minimal stop end: ONE message, SILENT (D4)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Halfway there."));
  await tick();
  await m.onAssistantEnd(textMsg("Halfway there.", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]); // the stream is over — the stop end persists now
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `one persistent message, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Halfway there."), `visible text: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠️ Request was aborted"), `the stopped footer: ${JSON.stringify(text)}`);
  assert.equal(rich[0]?.opts?.disableNotification, true, "the stop end is silent");
});

test("full clean end: still TWO messages (m1 silent + m2 notifies) — regression guard", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 }); // default level = full
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Just an answer."));
  await tick();
  await m.onAssistantEnd(textMsg("Just an answer.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  assert.equal(rich[0]?.opts?.disableNotification, true, "m1 is silent");
  assert.ok(!rich[1]?.opts?.disableNotification, "m2 notifies");
});
