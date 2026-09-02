// Per-turn streaming: the rich draft lifecycle (same draft_id, throttled,
// heartbeat via the injected fake timer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, THINKING_WORDS, thinkingPlaceholder } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

/** Assert the draft text is the thinking label with a word from the list. */
function assertThinkingLabel(text: string): void {
  const m = /^<tg-thinking>(\w+)…<\/tg-thinking>$/.exec(text);
  assert.ok(m, `thinking label shape: ${JSON.stringify(text)}`);
  assert.ok(THINKING_WORDS.includes(m[1]), `word from list: ${m[1]}`);
}

test("agent_start creates a draft (draft_id 1, can_stop) with the thinking label", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1);
  assert.equal(drafts[0].canStop, true);
  assertThinkingLabel(drafts[0].text!);
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
  assertThinkingLabel(drafts[0].text!);
});

/** Extract the word from a <tg-thinking>WORD…</tg-thinking> label. */
function wordOf(label: string): string {
  return /^<tg-thinking>(\w+)…<\/tg-thinking>$/.exec(label)?.[1] ?? label;
}

test("thinking label: word re-rolls at most every 5s (heartbeat within the window keeps it)", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps();
  const m = new Mirror(deps);
  const orig = Math.random;
  let pick = 0;
  try {
    // pick #1 → index 0 ("Pondering"), pick #2 → index 1 ("Deliberating")
    Math.random = () => (pick++ === 0 ? 0 : 0.04);
    await m.onAgentStart(); // t=0: word #1
    const drafts = () => out.calls.filter((c) => c.kind === "sendDraft");
    const w1 = wordOf(drafts()[0].text!);
    assert.equal(w1, THINKING_WORDS[0]);
    advance(3000);
    fireTimer(); // heartbeat at t=3000, still empty → same word (within 5s)
    await new Promise((r) => setTimeout(r, 0)); // let the in-flight draft settle
    const w2 = wordOf(drafts()[1].text!);
    assert.equal(w2, w1, "no re-roll within the 5s window");
    assert.equal(pick, 1, "no new word picked within the window");
    advance(2001);
    fireTimer(); // t=5001, past the window → a new word
    await new Promise((r) => setTimeout(r, 0));
    const w3 = wordOf(drafts()[2].text!);
    assert.equal(w3, THINKING_WORDS[1], "re-rolled after the 5s window");
  } finally {
    Math.random = orig;
  }
});

test("thinking label: a new turn started within 5s reuses the current word", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const m = new Mirror(deps);
  const orig = Math.random;
  let pick = 0;
  try {
    Math.random = () => (pick++ === 0 ? 0 : 0.04);
    await m.onAgentStart(); // t=0 — word #1 picked
    advance(1000);
    await m.onAgentEnd([{ role: "assistant", content: "done" }]);
    advance(1000); // t=2000 — only 2s after the last word
    await m.onAgentStart(); // new draft message, same mirror instance
    const drafts = out.calls.filter((c) => c.kind === "sendDraft");
    const last = drafts[drafts.length - 1].text!;
    assert.equal(wordOf(last), THINKING_WORDS[0], "no re-roll within 5s across turns");
    assert.equal(pick, 1, "no new word picked within the window");
  } finally {
    Math.random = orig;
  }
});

test("thinkingPlaceholder: random word from the list, single-char … ellipsis", () => {
  const orig = Math.random;
  try {
    Math.random = () => 0; // first word
    assert.equal(thinkingPlaceholder(), `<tg-thinking>${THINKING_WORDS[0]}…</tg-thinking>`);
    Math.random = () => 0.999999999; // last word
    assert.equal(
      thinkingPlaceholder(),
      `<tg-thinking>${THINKING_WORDS[THINKING_WORDS.length - 1]}…</tg-thinking>`,
    );
  } finally {
    Math.random = orig;
  }
  assert.ok(THINKING_WORDS.length >= 25, `list is rich (${THINKING_WORDS.length} words)`);
  assert.ok(!THINKING_WORDS.includes("working"), "old static label is gone");
  for (const w of THINKING_WORDS) assert.ok(/^[A-Z][a-z]+$/.test(w), `word shape: ${w}`);
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
