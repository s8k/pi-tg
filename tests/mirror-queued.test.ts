// Queued-message draft move: when pi DELIVERS a queued (steer/follow-up)
// user message mid-run, the live draft is segmented as a silent persistent
// message and RE-SPAWNED — the fresh draft lands BELOW the segment, i.e., at
// the bottom of the chat, instead of keeping its original position (client-
// controlled: no position parameter, no stop-draft method — same mechanics
// as the post-dialog re-spawn, live-verified 2026-09-27). The run's OWN
// prompt (the run's first user message) never triggers a move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { type TgBlock } from "../src/rich-blocks.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

type H = ReturnType<typeof makeMirrorDeps>;

const draftCalls = (h: H) =>
  h.out.calls.filter((c): c is (typeof h.out.calls)[number] & { kind: "sendDraft" } => c.kind === "sendDraft");

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});
const userMsg = (text = "queued"): MirrorMessage => ({ role: "user", content: [{ type: "text", text }] });

/** A working run with a live draft and a committed tool-carrying message in the log. */
async function seededRun(h: H): Promise<Mirror> {
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(userMsg("initial")); // the run's own prompt
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("working on it"));
  await m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "working on it" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ],
  });
  await tick();
  return m;
}

test("the run's OWN prompt (its first user message) does NOT move the draft", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(userMsg("initial"));
  await tick();
  assert.equal(h.out.calls.filter((c) => c.kind === "sendRich").length, 0, "no segment for the initial prompt");
});

test("a QUEUED user message mid-run → the pre-queue work is segmented and the draft re-spawned at the bottom", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await seededRun(h);
  const before = h.out.calls.length;

  m.onAssistantStart(userMsg("do this instead")); // the queued steer is delivered
  await tick();

  const seg = h.out.calls.slice(before).filter((c) => c.kind === "sendRich");
  assert.equal(seg.length, 1, "the pre-queue work is ONE persistent segment");
  assert.ok((seg[0]?.text ?? "").includes("working on it"), "the segment carries the pre-queue log");
  assert.ok(
    (seg[0]?.text ?? "").includes("⚡️ Processing queued message…"),
    "the segment ends with the queued-message marker",
  );
  assert.ok(!(seg[0]?.text ?? "").includes("Completed ✔️"), "the segment has no run-end marker");
  assert.ok(seg[0]?.opts?.disableNotification, "the segment is silent");

  // the fresh draft (spinner) goes out AFTER the segment → it lands below it
  const after = h.out.calls.slice(before);
  const drafts = after.filter((c) => c.kind === "sendDraft");
  assert.ok(drafts.length > 0, "a fresh draft is re-spawned");
  assert.ok(after.indexOf(drafts[0]!) > after.indexOf(seg[0]!), "the segment lands BEFORE the fresh draft (the draft sits at the bottom)");
  assert.match(drafts[0]?.text ?? "", /^\w+…$/, "the fresh draft is the spinner alone (no stale content)");

  // the continuation streams into the fresh draft with ONLY the post-queue content
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("post-queue"));
  await tick();
  const last = draftCalls(h).at(-1);
  assert.ok((last?.text ?? "").includes("post-queue"), "the continuation streams");
  assert.ok(!(last?.text ?? "").includes("working on it"), "the pre-queue content was segmented out (no duplication)");
});

test("a second queued message moves the draft AGAIN (each delivery re-baselines at the bottom)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await seededRun(h);

  m.onAssistantStart(userMsg("first queued"));
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("mid work"));
  await m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "mid work" },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  await tick();

  const before = h.out.calls.length;
  m.onAssistantStart(userMsg("second queued"));
  await tick();

  const seg = h.out.calls.slice(before).filter((c) => c.kind === "sendRich");
  assert.equal(seg.length, 1, "the post-first-queue work is segmented too");
  assert.ok((seg[0]?.text ?? "").includes("mid work"), "the segment carries the post-first-queue log");
  assert.ok(!(seg[0]?.text ?? "").includes("working on it"), "the earlier segment's content is not duplicated");
  const after = h.out.calls.slice(before);
  assert.ok(after.filter((c) => c.kind === "sendDraft").length > 0, "the draft re-spawns below the new segment");
});

test("a stream event mid-move does NOT re-spawn the draft BEFORE the segment (the pipeline is gated)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await seededRun(h);
  // Park the segment's sendRich until explicitly released
  const releases: Array<() => void> = [];
  const realSendRich = h.out.sendRich;
  h.out.sendRich = async (chatId: number, blocks: TgBlock[], opts?: { disableNotification?: boolean }) => {
    await new Promise<void>((r) => releases.push(r));
    return realSendRich(chatId, blocks, opts);
  };

  m.onAssistantStart(userMsg("queued")); // move starts, segment parked
  await tick();
  // the model starts the next message while the segment is in flight
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("next"));
  await tick();
  const before = h.out.calls.length;
  assert.equal(h.out.calls.slice(before).filter((c) => c.kind === "sendDraft").length, 0, "no draft send while the segment is in flight");

  releases[0]?.(); // segment delivered
  await tick();
  const after = h.out.calls.slice(before);
  const iRich = after.findIndex((c) => c.kind === "sendRich");
  assert.ok(iRich >= 0, "the segment lands");
  const drafts = after.filter((c) => c.kind === "sendDraft");
  assert.ok(drafts.length > 0, "the fresh draft goes out after the segment");
  assert.ok(drafts.every((c) => after.indexOf(c) > iRich), "every draft send is AFTER the segment (the draft sits at the bottom)");
  assert.ok((drafts.at(-1)?.text ?? "").includes("next"), "the in-flight content is not lost");
});

test("no move without a live draft (no run / draft retired) — the next event re-spawns normally", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAssistantStart(userMsg("queued")); // no run at all
  await tick();
  assert.equal(h.out.calls.length, 0, "no segment, no draft, no crash");
});

test("no move for an error-end run — the draft carries retry-carryover semantics (finalization owns it)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(userMsg("initial"));
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("partial"));
  await m.onAssistantEnd(textMsg("partial", { stopReason: "error", errorMessage: "boom" }));
  await tick();
  const before = h.out.calls.length;
  m.onAssistantStart(userMsg("queued"));
  await tick();
  assert.equal(h.out.calls.length, before, "no segment for an error-end draft");
});
