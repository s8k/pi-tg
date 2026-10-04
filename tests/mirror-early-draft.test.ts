// T6 early draft: the run's draft (thinking spinner) appears at prompt-ACCEPT
// time — before pi's agent_start (which can lag behind the first model token)
// — and the run's agent_start takes over the SAME draft (no second spawn, no
// log wipe). A steer into a live run (prompt while working) is a no-op: that
// run already owns its draft.
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

const drafts = (calls: FakeOutCall[]): FakeOutCall[] => calls.filter((c) => c.kind === "sendDraft");
const rich = (calls: FakeOutCall[]): FakeOutCall[] => calls.filter((c) => c.kind === "sendRich");

test("onPromptAccepted: the draft spawns BEFORE agent_start, and agent_start takes over the same draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  assert.equal(m.hasLiveDraft(), false, "no live draft before any prompt");

  m.onPromptAccepted();
  await tick();
  const spawn = drafts(h.out.calls).at(-1);
  assert.ok(spawn, "the early draft went out without any agent event");
  assert.equal(spawn!.canStop, true, "the early draft is stoppable");
  assert.ok(spawn!.blocks?.some((b) => b.type === "thinking"), `spinner in the early draft: ${spawn!.text}`);
  assert.equal(m.hasLiveDraft(), true);

  m.onAgentStart(); // the run starts: takes over the SAME draft
  await tick();
  assert.equal(drafts(h.out.calls).length, 1, "agent_start must not spawn a second draft");
  assert.equal(drafts(h.out.calls)[0]!.draftId, spawn!.draftId, "the takeover keeps the same draft id");
});

test("onPromptAccepted while a run is live (steer): no-op — the run already owns its draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  const before = h.out.calls.length;
  m.onPromptAccepted(); // steer into the live run
  await tick();
  assert.equal(h.out.calls.length, before, "no draft activity for a steer");
});

test("onPromptAccepted after finalization: a fresh draft with a clean log", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("old answer"));
  await m.onAssistantEnd(textMsg("old answer", { stopReason: "stop" }));
  await tick();
  assert.ok(rich(h.out.calls).length >= 1, "the run finalized");
  assert.equal(rich(h.out.calls).at(-1)?.text, "old answer", "the answer was posted");
  assert.equal(m.hasLiveDraft(), false, "no live draft after finalization");
  const beforeDrafts = drafts(h.out.calls).length;
  const beforeTotal = h.out.calls.length;

  m.onPromptAccepted(); // the next prompt
  await tick();
  const ds = drafts(h.out.calls);
  assert.equal(ds.length, beforeDrafts + 1, "a new draft for the new run");
  assert.equal(h.out.calls.length, beforeTotal + 1, "exactly one draft update (no persistent activity)");
  const last = ds.at(-1)!;
  assert.ok(!last.text!.includes("old answer"), "the previous run's answer is not carried");
  assert.ok(last.blocks?.some((b) => b.type === "thinking"), "the new draft shows the spinner");
  assert.equal(m.hasLiveDraft(), true);
});
