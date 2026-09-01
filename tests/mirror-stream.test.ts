// Per-turn streaming: the rich draft lifecycle (same draft_id, throttled,
// heartbeat via the injected fake timer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("agent_start creates a draft (draft_id 1, can_stop) with the thinking label", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1);
  assert.equal(drafts[0].canStop, true);
  assert.equal(drafts[0].text, "<tg-thinking>working…</tg-thinking>");
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0, "no legacy Working… message");
});

test("assistant updates refresh the same draft, throttled by streamEditMs", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  await m.onAssistantUpdate({ role: "assistant", content: "Hello" });
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 0, "throttled at t=0 (draft just sent)");
  advance(1500);
  await m.onAssistantUpdate({ role: "assistant", content: "Hello world" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1, "same draft_id refreshed, not a new draft");
  assert.equal(drafts[0].text, "Hello world");
});

test("assistant_start of a NEW message resets the throttle window", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantStart({ role: "assistant" });
  out.calls.length = 0;
  await m.onAssistantUpdate({ role: "assistant", content: "first words" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1, "first update of a new message is not throttled");
  assert.equal(drafts[0].text, "first words");
});

test("multiple assistant messages in one turn: draft shows the LATEST text", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantStart({ role: "assistant" });
  advance(1600);
  await m.onAssistantUpdate({ role: "assistant", content: "first message" });
  await m.onAssistantEnd({ role: "assistant" });
  await m.onAssistantStart({ role: "assistant" });
  await m.onAssistantUpdate({ role: "assistant", content: "second message" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts[drafts.length - 1].text, "second message");
  assert.equal(drafts.every((d) => d.draftId === 1), true, "one draft for the whole turn");
});

test("heartbeat re-sends the same draft_id every draftHeartbeatMs", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  advance(17000);
  fireTimer();
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1);
  assert.equal(drafts[0].text, "<tg-thinking>working…</tg-thinking>");
});

test("heartbeat stops at agent_end; a new turn gets a new draft_id", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "done" }]);
  out.calls.length = 0;
  advance(17000);
  fireTimer();
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 0, "no heartbeat after agent_end");
  await m.onAgentStart();
  const last = out.calls.filter((c) => c.kind === "sendDraft").at(-1);
  assert.equal(last?.draftId, 2, "fresh draft_id per turn");
});
