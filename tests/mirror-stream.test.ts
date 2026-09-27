// Single-draft stream (2026-09-03 flow revision): ONE richMessageDraft carries
// everything — the work log, the in-flight message text (tail), and the
// <tg-thinking> spinner. No slot draft, no second id, ever. A tool-carrying
// message's text commits to the log at message_end (the tail clears); the
// confirmed text stays as the answer under the final marker.
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

test("agent_start creates the single draft (id 1) with can_stop + keep_on_stop and a thinking bottom line", async () => {
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

test("the answer text streams into the SAME draft — no second draft is ever created", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("He"));
  m.onAssistantUpdate(textMsg("Hello"));
  await tick();
  assert.deepEqual(draftIds(h), [1], "one draft for the whole run");
  const content = latest(h, 1);
  assert.ok(content.startsWith("Hello\n\n"), `text on top, got: ${JSON.stringify(content)}`);
  assert.match(content, /<tg-thinking>\w+…<\/tg-thinking>$/, "the spinner stays below the streaming text");
});

test("textless candidates never trigger a draft update", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] });
  m.onAssistantUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "hmm, let me think" }] });
  await tick();
  assert.equal(draftCalls(h).length, 1, "the spawn send only — no update for textless parts");
  assert.deepEqual(draftIds(h), [1]);
});

test("a toolCall mid-stream does not wipe the tail — the text keeps showing until the commit", async () => {
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
  assert.ok(latest(h, 1).includes("Let me check the file."), "the text streams into the draft");
  // the tool call arrives in the next chunk — the visible text must stay
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to see the file." },
      { type: "text", text: "Let me check the file." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
    ],
  });
  await tick();
  assert.ok(latest(h, 1).includes("Let me check the file."), "no spinner flash when the toolCall chunk arrives");
  // message_end commits: the text becomes a log block (same place), the tail clears
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
  assert.equal((log.match(/Let me check the file\./g) ?? []).length, 1, "exactly once — committed, not duplicated");
  assert.ok(log.includes("⚙ read …"), log);
  assert.ok(log.includes("💭"), "why line from the thinking stream");
});

test("no flicker across a tool loop: committed text and streamed text are never wiped from the draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Let me check the file."));
  await tick();
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the file." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the file." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "file body" }] });
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Fixed it."));
  await tick();

  const calls = draftCalls(h);
  assert.deepEqual(draftIds(h), [1], "one draft id for the whole loop");
  const all = calls.map((c) => c.text ?? "");
  const firstCommitted = all.findIndex((t) => t.includes("Let me check the file."));
  assert.ok(firstCommitted >= 0, "the text is visible from the first stream chunk");
  for (let i = firstCommitted; i < all.length; i++) {
    assert.ok(all[i]!.includes("Let me check the file."), `committed text stays visible (send ${i}): ${JSON.stringify(all[i])}`);
    assert.ok(all[i]!.includes("<tg-thinking>"), `spinner present while working (send ${i})`);
  }
  const firstFixed = all.findIndex((t) => t.includes("Fixed it."));
  assert.ok(firstFixed > firstCommitted, "the next message's text streams in");
  for (let i = firstFixed; i < all.length; i++) {
    assert.ok(all[i]!.includes("Fixed it."), `new tail stays visible (send ${i})`);
  }
});

test("re-candidate: the next message streams into the SAME draft; tool stamps update the log", async () => {
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
  assert.deepEqual(draftIds(h), [1], "a textless tool message adds nothing");
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "file body" }] });
  await tick();
  assert.ok(latest(h, 1).includes("⚙ read ✔"), latest(h, 1));
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Fixed it."));
  await tick();
  assert.deepEqual(draftIds(h), [1], "still one draft — the next message reuses it");
  assert.ok(latest(h, 1).includes("Fixed it."), "the new message's text streams into the same draft");
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
  // a late event must not touch the draft
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("late"));
  m.onToolEnd("cX", false, {});
  m.onAgentEnd([]);
  await tick();
  assert.equal(draftCalls(h).length, before);
});

test("a 'length' stop WITH a tool call does NOT confirm — the run continues in the same draft", async () => {
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
  // not finalized: the failed tool stamps in and the next candidate streams on
  m.onToolEnd("c2", true, { content: [{ type: "text", text: "not executed: output token limit" }] });
  await tick();
  const log = latest(h, 1);
  assert.ok(log.includes("⚙ bash ✖"), log);
  assert.ok(log.includes("<pre>not executed: output token limit</pre>"), log);
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Retry."));
  await tick();
  assert.deepEqual(draftIds(h), [1], "still the single draft");
  assert.ok(latest(h, 1).includes("Retry."), "the new candidate streams into it");
});

test("spinner-only run: the single draft never gains text", async () => {
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
  const h = makeMirrorDeps({ level: "mute" });
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
  m.onAssistantStart(textMsg("")); // forceNext: the first send of a message breaks the window
  m.onAssistantUpdate(textMsg("A")); // out now
  m.onAssistantUpdate(textMsg("AB")); // gated by the streamEditMs window
  await tick();
  assert.ok(latest(h, 1).includes("A"), `latest shows "A", got: ${JSON.stringify(latest(h, 1))}`);
  assert.ok(!latest(h, 1).includes("AB"), "the fast second update is still queued");
  h.advance(1000);
  await tick();
  assert.ok(latest(h, 1).includes("AB"), "the coalesced update drains at the window edge");
});

test("heartbeat re-sends the live draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, draftHeartbeatMs: 17000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Hi"));
  await tick();
  h.out.calls.length = 0;
  h.advance(17000);
  await tick();
  assert.equal(draftCalls(h).length, 1, "exactly one refresh");
  assert.equal(draftCalls(h)[0]?.draftId, 1);
  assert.ok(draftCalls(h)[0]?.text?.includes("Hi"), "the refresh carries the current content");
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
  assert.ok(log.includes("⚙ bash ✖"), log);
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
  await tick(); // forced send @40: window → 1040 (old drain now "early")
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

// ── mid-run chat learning (post-reload gap) ────────────────────────────────
// A fresh generation (after /reload or restart) may start a run BEFORE the
// owner chat is learned (the owner types in the terminal; the chat arrives
// later with some owner update). The draft must then spawn LATE (when the
// chat becomes known) instead of the run going silent on Telegram.

test("run started without a learned chat: the draft spawns when onChatLearned fires mid-run, and the run finalizes normally", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  let chat: number | undefined; // not learned yet (fresh generation)
  h.deps.getChatId = () => chat;
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  assert.equal(draftCalls(h).length, 0, "no draft — the chat is unknown");
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("working on it"));
  await tick();
  assert.equal(draftCalls(h).length, 0, "still no draft while unlearned");

  chat = 7; // an owner update just taught the chat (index.ts learn path)
  m.onChatLearned();
  await tick();
  assert.equal(draftCalls(h).length, 1, "the draft spawned late");
  assert.equal(draftCalls(h)[0]?.draftId, 1);
  assert.match(draftCalls(h)[0]?.text ?? "", /working on it/);

  await m.onAssistantEnd(textMsg("working on it", { stopReason: "stop" }));
  await tick();
  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 2, "m1 + m2 still go out on the clean end");
});

test("onChatLearned is a no-op: no run in progress / a draft is already live", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  let chat: number | undefined;
  h.deps.getChatId = () => chat;
  const m = new Mirror(h.deps);
  m.onChatLearned(); // no run ever started
  chat = 7;
  m.onChatLearned(); // still no run in progress
  await tick();
  assert.equal(draftCalls(h).length, 0);

  m.onAgentStart(); // chat known now — the draft spawns normally
  await tick();
  assert.equal(draftCalls(h).length, 1);
  m.onChatLearned(); // a live draft exists — no second draft
  await tick();
  assert.deepEqual(draftIds(h), [1]);
});

test("the run draft id is STABLE across runs (always 1) — clients follow one draft per chat", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  // run 1
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("one"));
  m.onAssistantEnd(textMsg("one", { stopReason: "stop" }));
  m.onAgentEnd([]);
  await tick();
  // run 2 — same Mirror instance (same generation): the draft id must not advance
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("two"));
  await tick();
  assert.deepEqual(
    h.out.calls.filter((c) => c.kind === "sendDraft").map((c) => c.draftId),
    [1, 1, 1, 1],
    "every run streams into the same stable draft id 1",
  );
});
