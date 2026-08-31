import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const assistantMsg = (text: string): MirrorMessage => ({ role: "assistant", content: [{ type: "text", text }] });

test("muted: start events (agent, tool, assistant, ui prompt) post nothing", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, { muted: true });
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onToolStart("t1", "bash", { command: "npm test" });
  await mirror.onAssistantStart(assistantMsg(""));
  await mirror.onUiPromptStart("rm -rf?");
  assert.equal(out.calls.length, 0);
});

test("muted: agent_end for a muted turn is fully silent (no answer, no edit)", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, { muted: true });
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([assistantMsg("the answer")]);
  assert.equal(out.calls.length, 0);
});

test("mute mid-turn: pre-mute working message finalized, answer suppressed, no new tool lines", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, { muted: false });
  const mirror = new Mirror(deps);
  await mirror.onAgentStart(); // posts “🤖 Working…” (id 100)
  deps.cfg.muted = true; // user mutes mid-turn
  await mirror.onToolStart("t1", "bash", "x"); // suppressed
  await mirror.onAgentEnd([assistantMsg("the answer")]);
  assert.deepEqual(out.calls.map((c) => c.kind), ["send", "edit"]); // working msg + its close; no answer
  const edit = out.calls.find((c) => c.kind === "edit")!;
  assert.ok(edit.text!.includes("muted"), `edit text: ${edit.text}`);
});

test("unmute: posting resumes on the next event", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, { muted: true });
  const mirror = new Mirror(deps);
  deps.cfg.muted = false;
  await mirror.onAgentStart();
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].text, "🤖 Working…");
});

test("muted: tool_end without a tracked tool stays a no-op", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out, { muted: true }));
  await mirror.onToolEnd("ghost", false);
  assert.equal(out.calls.length, 0);
});
