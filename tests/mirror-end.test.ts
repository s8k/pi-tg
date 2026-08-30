import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { TG_MAX_LEN } from "../src/markdown.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const m = (t: string, stopReason?: string): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
  stopReason,
});

test("agent_end ok: working → ✅ Done (button cleared), answer posted as HTML chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  const big = "x".repeat(5000);
  await mirror.onAgentEnd([m("mid", "toolUse"), m(big, "stop")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.includes("✅ Done"));
  assert.deepEqual(edit?.opts?.replyMarkup, { inline_keyboard: [] }); // Stop button gone
  const sends = out.calls.filter((c) => c.kind === "send" && typeof c.text === "string" && c.text !== "🤖 Working…");
  assert.ok(sends.length >= 2, `expected chunked answer, got ${sends.length}`);
  for (const s of sends) assert.ok(s.text!.length <= TG_MAX_LEN);
  assert.equal(sends[0].opts?.parseMode, "HTML");
  assert.equal(deps.state.getWorking(), undefined);
});

test("agent_end aborted: ⏹ interrupted + partial text posted", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("partial answer here", "aborted")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.equal(edit?.text, "⏹ interrupted");
  const answer = out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…");
  assert.equal(answer.length, 1);
  assert.ok(answer[0].text!.includes("partial answer here"));
});

test("agent_end error: ⚠️ error note, no answer chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("", "error"), { role: "assistant", content: [], error: { message: "boom <x>" } }]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.startsWith("⚠️ error:"));
  assert.equal(out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…").length, 0);
});

test("agent_end no reply text: Done (no reply text), no chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("", "stop")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.includes("no reply text"));
  assert.equal(out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…").length, 0);
});

test("agent_end clears tool msg ids", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onToolStart("t1", "bash", "x");
  await mirror.onAgentEnd([m("hi", "stop")]);
  assert.equal(deps.state.getToolMsg("t1"), undefined);
});

test("no chatId: agent_end still clears state, sends nothing", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, {}, null); // null = no chat yet (helper sentinel)
  const mirror = new Mirror(deps);
  deps.state.setWorking(5);
  await mirror.onAgentEnd([m("hi", "stop")]);
  assert.equal(out.calls.length, 0);
  assert.equal(deps.state.getWorking(), undefined);
});

test("onUiPromptStart: notes the blocking terminal prompt", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onUiPromptStart("allow bash?");
  const t = out.calls[0].text as string;
  assert.ok(t.includes("permission prompt"));
  assert.ok(t.includes("allow bash?"));
});
