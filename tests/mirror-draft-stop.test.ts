// Draft stop lifecycle (field report 2026-10 + API guidance): after the user
// presses the native Stop button, Telegram suppresses can_stop=true updates
// for that draft_id until the stop state is handled — re-sending the stable
// draft_id 1 with can_stop=true renders NOTHING (the current AND all later
// runs' drafts were invisible; nothing plugin-side, not even /reload, could
// recover it). The recovery is a one-time RESET packet: the first send after
// the stop goes out can_stop=false (a fresh, non-stoppable generation phase
// — clears the block), then can_stop=true resumes.
//
// Regression guard in the same file: the id itself must stay the stable 1 —
// fresh per-run ids are NOT reliably rendered by clients (live-verified:
// per-run ids 1..7 were invisible while a probe on another id rendered), and
// that is exactly the issue the stable id was introduced to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";
import type { FakeOutCall } from "./fake-pi.ts";
import type { TgBlock } from "../src/rich-blocks.ts";

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});
const drafts = (calls: FakeOutCall[]): FakeOutCall[] => calls.filter((c) => c.kind === "sendDraft");
const lastDraft = (calls: FakeOutCall[]): FakeOutCall | undefined => drafts(calls).at(-1);

/** Start a run and wait for its draft spawn. */
async function startRun(h: ReturnType<typeof makeMirrorDeps>, m: Mirror): Promise<void> {
  m.onAgentStart();
  await tick();
  assert.ok(lastDraft(h.out.calls), "the run's draft went out");
}

/** End the run (stop end) and let finalization settle. */
async function endRun(m: Mirror): Promise<void> {
  await m.onAgentEnd([]);
  await tick();
}

test("regression guard: the run's draft ALWAYS uses the stable draft_id 1 (fresh per-run ids are not rendered by clients)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  for (let run = 1; run <= 3; run++) {
    await startRun(h, m);
    await endRun(m);
  }
  assert.ok(drafts(h.out.calls).length >= 3, "each run spawned its draft");
  assert.ok(drafts(h.out.calls).every((c) => c.draftId === 1), "every draft send used the stable id 1 — never a per-run id");
});

test("onDraftStopped: the next send is a can_stop=false reset packet, then can_stop=true resumes", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  await startRun(h, m);
  assert.equal(lastDraft(h.out.calls)!.canStop, true, "normal streaming sends carry can_stop=true");

  m.onDraftStopped(1); // the native Stop button (stopped_message_generation)
  m.onAssistantUpdate(textMsg("still going?"));
  await tick();
  assert.equal(lastDraft(h.out.calls)!.canStop, false, "the first send after the stop is the can_stop=false RESET packet");

  m.onAssistantUpdate(textMsg("more"));
  await tick();
  assert.equal(lastDraft(h.out.calls)!.canStop, true, "after the reset packet lands, can_stop=true resumes");
});

test("the reset flag survives finalization: the NEXT RUN's first draft send is the reset packet", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  await startRun(h, m);
  m.onDraftStopped(1); // user stopped run 1
  await endRun(m); // run 1 finalizes (aborted)

  await startRun(h, m); // run 2
  const first = lastDraft(h.out.calls)!;
  assert.equal(first.draftId, 1, "run 2 reuses the stable id");
  assert.equal(first.canStop, false, "run 2's first send clears the stop state (can_stop=false reset)");

  m.onAssistantUpdate(textMsg("streaming"));
  await tick();
  assert.equal(lastDraft(h.out.calls)!.canStop, true, "subsequent sends resume can_stop=true");
});

test("onDraftStopped for a foreign id (the compact draft, 1_000_000 + seq): no-op", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  await startRun(h, m);

  m.onDraftStopped(1_000_001); // a compact draft was stopped — not ours
  m.onAssistantUpdate(textMsg("streaming"));
  await tick();
  assert.equal(lastDraft(h.out.calls)!.canStop, true, "no reset packet was armed — normal can_stop=true continues");
});

test("sendDraft → false (API: the draft no longer exists / id blocked): arms the reset packet; the next send is can_stop=false and recovers", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  await startRun(h, m);

  // the id is blocked server-side: the first (can_stop=true) send returns
  // false; once the can_stop=false reset packet goes out, sends land again
  const realSendDraft = h.out.sendDraft;
  let attempts = 0;
  h.out.sendDraft = async (chatId: number, draftId: number, blocks: TgBlock[], canStop?: boolean, keepOnStop?: boolean): Promise<boolean> => {
    await realSendDraft.call(h.out, chatId, draftId, blocks, canStop, keepOnStop);
    attempts++;
    return attempts > 1; // first send blocked, reset packet lands
  };

  m.onAssistantUpdate(textMsg("blocked"));
  await tick();
  assert.equal(attempts, 1, "the blocked send went out once (can_stop=true)");

  m.onAssistantUpdate(textMsg("reset"));
  await tick();
  const reset = lastDraft(h.out.calls)!;
  assert.equal(reset.canStop, false, "the retry after a false is the can_stop=false reset packet");
  assert.equal(attempts, 2, "exactly one retry — no hammering");

  m.onAssistantUpdate(textMsg("streaming"));
  await tick();
  assert.equal(lastDraft(h.out.calls)!.canStop, true, "after the reset packet lands, can_stop=true resumes");
  h.out.sendDraft = realSendDraft;
});
