// Slot state machine (message 2 — the answer candidate slot): candidate →
// demote → re-candidate → confirm; one slot per run; textless candidates
// never create the slot; demotion clears content but keeps the draft id;
// one-way switch once finalized.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

type H = ReturnType<typeof makeMirrorDeps>;
type DraftCall = { draftId?: number; text?: string; canStop?: boolean; keepOnStop?: boolean };

const draftCalls = (h: H): DraftCall[] =>
  h.out.calls.filter((c): c is (typeof h.out.calls)[number] & { kind: "sendDraft" } => c.kind === "sendDraft");
const draftIds = (h: H): number[] => [...new Set(draftCalls(h).map((c) => c.draftId).filter((d): d is number => d !== undefined))];
const latest = (h: H, draftId: number): string => {
  const calls = draftCalls(h).filter((c) => c.draftId === draftId);
  return calls[calls.length - 1]?.text ?? "";
};

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

test("agent_start creates the work-log draft (id 1) with can_stop + keep_on_stop and a thinking bottom line", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  const calls = draftCalls(h);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.draftId, 1);
  assert.equal(calls[0]?.canStop, true);
  assert.equal(calls[0]?.keepOnStop, true);
  assert.match(calls[0]?.text ?? "", /^<tg-thinking>\w+…<\/tg-thinking>$/);
});

test("candidate text streams into the slot (second draft id); the work-log draft never shows it", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("He"));
  m.onAssistantUpdate(textMsg("Hello"));
  await tick();
  const ids = draftIds(h);
  assert.equal(ids.length, 2, `draft ids: ${ids.join(",")}`);
  const slotId = ids.find((id) => id !== 1)!;
  assert.equal(latest(h, slotId), "Hello");
  for (const c of draftCalls(h).filter((c) => c.draftId === 1)) assert.ok(!c.text?.includes("Hello"), c.text ?? "");
});

test("textless candidates never create the slot draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] });
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "hmm, let me think" }] });
  await tick();
  assert.deepEqual(draftIds(h), [1]);
});

test("demotion: a toolCall clears the slot (same draft id) and moves its text into the work log", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to see the file." },
      { type: "text", text: "Let me check the file." },
    ],
  });
  await tick();
  const slotId = draftIds(h).find((id) => id !== 1)!;
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to see the file." },
      { type: "text", text: "Let me check the file." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
    ],
  });
  await tick();
  // the slot is cleared back to the spinner — no new draft id appears
  assert.deepEqual(draftIds(h), [1, slotId]);
  assert.match(latest(h, slotId), /<tg-thinking>\w+…<\/tg-thinking>/);
  // the work log carries the demoted text + pending tool block after commit
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to see the file." },
      { type: "text", text: "Let me check the file." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  const log = latest(h, 1);
  assert.equal((log.match(/Let me check the file\./g) ?? []).length, 1, log);
  assert.ok(log.includes("⚙ read src/app.ts …"), log);
  assert.ok(log.includes("💭"), "why line from the thinking stream");
});

test("re-candidate: the next message streams into the SAME slot draft; tool stamps update the log", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] });
  m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
    stopReason: "toolUse",
  });
  await tick();
  assert.deepEqual(draftIds(h), [1], "a textless tool message never creates the slot");
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "file body" }] });
  await tick();
  assert.ok(latest(h, 1).includes("⚙ read a.ts ✔"), latest(h, 1));
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Fixed it."));
  await tick();
  const ids = draftIds(h);
  assert.equal(ids.length, 2, "the slot is created once, for the run");
  const slot = ids.find((id) => id !== 1)!;
  assert.equal(latest(h, slot), "Fixed it.");
});

test("confirm (stop, no tools): no further draft updates after (one-way switch)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();
  const before = draftCalls(h).length;
  // a late event must not touch either draft
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("late"));
  m.onToolEnd("cX", false, {});
  m.onAgentEnd([]);
  await tick();
  assert.equal(draftCalls(h).length, before);
});

test("a 'length' stop WITH a tool call does NOT confirm — the run continues", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [{ type: "text", text: "Trying." }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "text", text: "Trying." }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }],
    stopReason: "length",
  });
  await tick();
  // not finalized: the failed tool stamps in and a new candidate still streams
  m.onToolEnd("c2", true, { content: [{ type: "text", text: "not executed: output token limit" }] });
  await tick();
  const log = latest(h, 1);
  assert.ok(log.includes("⚙ bash ls ✖"), log);
  assert.ok(log.includes("<pre>not executed: output token limit</pre>"), log);
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Retry."));
  await tick();
  const slot = draftIds(h).find((id) => id !== 1);
  assert.ok(slot !== undefined, "the slot exists for the new candidate");
  assert.equal(latest(h, slot), "Retry.");
});

test("spinner-only slot: a thinking-only run never creates the slot draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "…" }] });
  m.onAssistantEnd({ role: "assistant", content: [{ type: "thinking", thinking: "…" }], stopReason: "stop" });
  await tick();
  assert.deepEqual(draftIds(h), [1]);
});

test("muted: no draft calls of any kind", async () => {
  const h = makeMirrorDeps({ muted: true });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("secret"));
  m.onAgentEnd([]);
  await tick();
  assert.equal(h.out.calls.length, 0, JSON.stringify(h.out.calls));
});

test("shared throttle: a fast second update is coalesced and drained at streamEditMs", async () => {
  const h = makeMirrorDeps({ streamEditMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick(); // let the spawn pump settle (it owns the throttle window)
  h.out.calls.length = 0;
  m.onAssistantStart(textMsg("")); // resets the throttle window
  m.onAssistantUpdate(textMsg("A")); // slot created, "A" out now
  m.onAssistantUpdate(textMsg("AB")); // gated by the shared streamEditMs window
  await tick();
  const slot = draftIds(h).find((id) => id !== 1)!;
  assert.equal(latest(h, slot), "A");
  h.advance(1000);
  await tick();
  assert.equal(latest(h, slot), "AB");
});

test("heartbeat re-sends both live drafts (log + slot)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, draftHeartbeatMs: 17000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Hi"));
  await tick();
  const slot = draftIds(h).find((id) => id !== 1)!;
  h.out.calls.length = 0;
  h.advance(17000);
  await tick();
  assert.ok(draftCalls(h).some((c) => c.draftId === 1), "log draft refreshed");
  assert.ok(draftCalls(h).some((c) => c.draftId === slot), "slot draft refreshed");
  assert.equal(latest(h, 1).length > 0, true);
});

test("tool end ✖: error text visible in a <pre>, HTML-escaped and capped at 400 chars", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [{ type: "text", text: "x" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "boom" } }],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "text", text: "x" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "boom" } }],
    stopReason: "toolUse",
  });
  await tick();
  const errText = "a <b> error ".repeat(40); // 480 chars
  m.onToolEnd("c1", true, errText);
  await tick();
  const log = latest(h, 1);
  assert.ok(log.includes("⚙ bash boom ✖"), log);
  const pre = /<pre>([\s\S]*?)<\/pre>/.exec(log);
  assert.ok(pre, log);
  const inner = pre[1];
  assert.ok(inner.includes("a &lt;b&gt; error"), "HTML-escaped");
  assert.ok(inner.length <= 401, `errorText capped, got ${inner.length}`);
  assert.ok(inner.endsWith("…"), "cap marked with an ellipsis");
});


test("a drain firing early (window extended after arming) does not kill the pipeline", async (t) => {
  // Real-clock scenario the fake clock usually masks: the spawn pump arms the
  // drain at the OLD window edge, then a forced send (the next message start)
  // extends the window. The old drain now fires while the window is still
  // closed — its pump body completes synchronously (gate → re-arm → return).
  // If that path leaves the inflight flag stuck (settled promise), every
  // later pump is a no-op and the draft pipeline dies until the run ends.
  const h = makeMirrorDeps({ streamEditMs: 1000 });
  const m = new Mirror(h.deps);
  const draftCalls = () => h.out.calls.filter((c) => c.kind === "sendDraft");

  m.onAgentStart();
  await tick(); // spawn @0: window → 1000, drain armed @1000
  assert.equal(draftCalls().length, 1);

  h.advance(40);
  m.onAssistantStart({ role: "assistant", content: [] }); // forceNext
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "text", text: "mid" }] });
  await tick(); // forced demote send @40: window → 1040 (old drain now "early")
  const p = m.onAssistantEnd({
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  await tick(); // commit @40
  m.onToolEnd("c1", true, { content: [{ type: "text", text: "boom" }] });
  await tick(); // stamp @40

  h.advance(960); // now = 1000: the old drain fires early (window is 1040)
  await tick();
  assert.equal(draftCalls().length, 2, "the stamped update waits for the re-armed window");
  h.advance(40); // now = 1040: the re-armed drain fires → the stamped update goes out
  await tick();
  assert.equal(draftCalls().length, 3, "the pipeline survived the early drain");
  assert.ok(String(draftCalls()[2]!.text).includes("boom"), "the stamped content was delivered");
  p.catch((e) => {
    throw e;
  });
});
