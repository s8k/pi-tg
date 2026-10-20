// Draft id lifecycle (field-verified 2026-10, wire log): a draft id the user
// STOPPED is silently filtered server-side — the API still returns success,
// the client renders nothing, and the state survives reloads/restarts. A
// can_stop=false "reset packet" does NOT clear it (tested in the field). The
// only recovery is a NEW id.
//
// Design under test (the careful Option A):
// - the id is STABLE ACROSS RUNS — clients do not reliably follow a fresh
//   per-run id (the live-verified regression that killed the per-run-id
//   design, ids 1..7);
// - but it is NOT a hardcoded constant: a random id (1..999_999, below the
//   compact lane 1_000_000+seq) is chosen on first spawn — i.e. fresh on
//   every plugin load, so /reload escapes a stuck id;
// - on a native stop (or a "draft no longer exists" false return) the id
//   ROTATES to a new random one for the next stream, and the live draft is
//   retired at once.
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

/** Run-draft ids: positive ints, kept below the compact-draft lane (1_000_000 + seq). */
const assertRunDraftId = (id: number, label: string): void => {
  assert.ok(Number.isInteger(id) && id >= 1 && id < 1_000_000, `${label}: id ${id} is in 1..999_999 (below the compact lane)`);
};

/** Start a run and return its draft stream id (the spawn must go out). */
async function runDraftId(h: ReturnType<typeof makeMirrorDeps>, m: Mirror): Promise<number> {
  m.onAgentStart();
  await tick();
  const last = lastDraft(h.out.calls);
  assert.ok(last, "the run's draft went out");
  return last!.draftId!;
}

/** End the run (stop end) and let finalization settle. */
async function endRun(m: Mirror): Promise<void> {
  await m.onAgentEnd([]);
  await tick();
}

test("the id is a random one on first spawn and stays STABLE across runs (per-run ids were the old regression)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  const id1 = await runDraftId(h, m);
  assertRunDraftId(id1, "run 1");
  await endRun(m);
  const id2 = await runDraftId(h, m);
  assert.equal(id2, id1, "run 2 reuses the SAME id — stable across runs (clients follow one draft per chat)");
  await endRun(m);
  const id3 = await runDraftId(h, m);
  assert.equal(id3, id1, "run 3 reuses it too — the id only changes on a stop, never per run");

  // a different plugin load (fresh mirror) gets a (different) random id
  const h2 = makeMirrorDeps({ streamEditMs: 0 });
  const m2 = new Mirror(h2.deps);
  const fresh = await runDraftId(h2, m2);
  assertRunDraftId(fresh, "fresh load");
  assert.notEqual(fresh, id1, "a fresh load does not reuse the previous load's id (1-in-999999 flake)");
});

test("within a run the live draft keeps its id across updates (same stream = animated refresh)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  const id = await runDraftId(h, m);
  m.onAssistantUpdate(textMsg("a"));
  await tick();
  m.onAssistantUpdate(textMsg("b"));
  await tick();
  assert.ok(drafts(h.out.calls).every((c) => c.draftId === id), "every update in the run stays on the same id");
});

test("onDraftStopped: the stopped id is NEVER reused — the live draft retires at once and the next stream is a fresh id", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  const id1 = await runDraftId(h, m);

  m.onDraftStopped(id1); // the native Stop button (stopped_message_generation)
  await tick();
  assert.equal(m.hasLiveDraft(), false, "the stopped draft is retired immediately");

  // past several heartbeat intervals: NOTHING re-sends the stopped id
  h.advance(60_000);
  assert.equal(drafts(h.out.calls).filter((c) => c.draftId === id1).length, 1, "the stopped id was sent exactly once (its spawn)");

  await endRun(m);
  const id2 = await runDraftId(h, m);
  assertRunDraftId(id2, "run after stop");
  assert.notEqual(id2, id1, "the next run streams on a FRESH id — the stopped one is dead server-side");
});

test("onDraftStopped for a foreign id (the compact draft, 1_000_000 + seq): no-op", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  const id = await runDraftId(h, m);

  m.onDraftStopped(1_000_001); // a compact draft was stopped — not ours
  await tick();
  assert.equal(m.hasLiveDraft(), true, "the run's live draft is untouched");

  await endRun(m);
  const id2 = await runDraftId(h, m);
  assert.equal(id2, id, "the run's stable id is unchanged by a foreign stop");
});

test("sendDraft → false (API: the draft no longer exists): the id rotates, the live draft retires, the next spawn is fresh", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  const id1 = await runDraftId(h, m);

  // the stream died server-side — updates to its id now return false
  const realSendDraft = h.out.sendDraft;
  h.out.sendDraft = async (chatId: number, draftId: number, blocks: TgBlock[], canStop?: boolean, keepOnStop?: boolean): Promise<boolean> => {
    await realSendDraft.call(h.out, chatId, draftId, blocks, canStop, keepOnStop);
    return draftId !== id1; // the dead id fails; fresh ids work
  };

  m.onAssistantUpdate(textMsg("streaming"));
  await tick();
  assert.equal(m.hasLiveDraft(), false, "the dead stream was retired on the false return");

  // the next content event re-spawns on a FRESH id
  m.onAssistantUpdate(textMsg("more"));
  await tick();
  const respawned = lastDraft(h.out.calls);
  assert.ok(respawned && respawned.draftId !== id1, "the re-spawned draft uses a fresh id (the dead one is never reused)");
  assertRunDraftId(respawned!.draftId!, "respawned");

  // and nothing keeps hammering the dead id
  h.out.sendDraft = realSendDraft;
  h.advance(60_000);
  assert.equal(drafts(h.out.calls).filter((c) => c.draftId === id1).length, 2, "the dead id was sent at most twice (spawn + the failing update)");
});
