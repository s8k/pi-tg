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
  assert.ok(latest.includes("<tg-thinking>"), `the <tg-thinking> bottom line is present: ${JSON.stringify(latest)}`);
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
