// T6 lane 1: pi auto-compacts when NO run draft is live (post-run threshold /
// overflow without retry). The bridge posts a standalone EPHEMERAL draft
// (🗜 Auto-compacting… — the compact draft id namespace, NO Stop button: there
// is no bot-side controller that could cancel it) and stamps + persists the
// result. The state is deliberately SEPARATE from the manual /compact state:
// a /stop during an auto-compact must hit the plain idle branch (A2 — "the
// session is idle"), never a stuck ⏹️ Stopping… draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { blocksToPlainText } from "../src/rich-blocks.ts";
import { makeDeps } from "./helpers.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("autoCompactStart: a standalone ephemeral draft (no Stop button); finish(ok, detail) stamps it, then sends the same text", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));

  bridge.autoCompactStart(7);
  await tick();
  const spawn = out.calls[0]!;
  assert.equal(spawn.kind, "sendDraft");
  assert.equal(spawn.text, "🗜 Auto-compacting…"); // thinking block's plain rendering
  assert.equal(spawn.canStop, false, "no Stop button — nothing bot-side can cancel an auto-compact");
  assert.ok(spawn.draftId !== undefined && spawn.draftId >= 1_000_000, "shares the compact draft id namespace");

  bridge.autoCompactFinish(true, "128,432 → 21,904 tokens");
  await tick();
  const tail = out.calls.slice(-2);
  assert.equal(tail[0]?.kind, "sendDraft", "the draft is stamped…");
  assert.equal(tail[0]?.draftId, spawn.draftId, "…on the same draft…");
  assert.equal(tail[0]?.text, "🗜 Context auto-compacted ✔️ 128,432 → 21,904 tokens", "space-joined, no em dash");
  assert.equal(tail[1]?.kind, "send", "…then the result is persisted");
  assert.equal(tail[1]?.text, "🗜 Context auto-compacted ✔️ 128,432 → 21,904 tokens");
  assert.equal(tail[1]?.opts?.parseMode, null, "plain text — no parse mode");
});

test("autoCompactFinish failure: stamp + send `⚠️ <pi message>` (pi's prefix kept verbatim — no double ⚠️)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));

  bridge.autoCompactStart(7);
  await tick();
  bridge.autoCompactFinish(false, "Auto-compaction failed: model exploded");
  await tick();
  const tail = out.calls.slice(-2);
  assert.equal(tail[0]?.kind, "sendDraft");
  assert.equal(tail[0]?.text, "⚠️ Auto-compaction failed: model exploded");
  assert.equal(tail[1]?.kind, "send");
  assert.equal(tail[1]?.text, "⚠️ Auto-compaction failed: model exploded");
});

test("autoCompactFinish without a detail: success → the bare done text; failure → ⚠️ compaction failed", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  bridge.autoCompactStart(7);
  await tick();
  bridge.autoCompactFinish(true);
  await tick();
  assert.equal(out.calls.at(-1)?.text, "🗜 Context auto-compacted ✔️");

  const out2 = new FakeOut();
  const bridge2 = new SessionBridge(makeDeps(new FakePi().build(), out2));
  bridge2.autoCompactStart(7);
  await tick();
  bridge2.autoCompactFinish(false);
  await tick();
  assert.equal(out2.calls.at(-1)?.text, "⚠️ compaction failed");
});

test("a second autoCompactStart while one is in flight: no second draft; a duplicate finish: no double send", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));

  bridge.autoCompactStart(7);
  await tick();
  bridge.autoCompactStart(7);
  await tick();
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 1, "one draft only");

  bridge.autoCompactFinish(true, "100 tokens");
  await tick();
  bridge.autoCompactFinish(true, "100 tokens"); // duplicate (a raced event)
  await tick();
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 1, "one persistent send");
});

test("/stop during a lane-1 auto-compact: the plain idle branch answers (A2), the auto draft is untouched", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  bridge.autoCompactStart(7);
  await tick();

  await bridge.dispatch({ kind: "stop", chatId: 7 });

  assert.equal(pi.abortCalls, 0, "nothing to abort — the session is idle");
  assert.equal(out.calls.at(-1)?.kind, "send");
  assert.equal(out.calls.at(-1)?.text, "Nothing to stop — session is idle.");
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 1, "the auto draft is untouched by the stop");
});

test("the draft never went up: finish still attempts the stamp (harmless) and sends the result", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  // the draft never lands (the fake still records the attempts)
  out.sendDraft = async (chatId, draftId, blocks, canStop, keepOnStop) => {
    out.calls.push({ kind: "sendDraft", chatId, blocks, text: blocksToPlainText(blocks), draftId, canStop, keepOnStop });
    return false;
  };
  const bridge = new SessionBridge(makeDeps(pi.build(), out));

  bridge.autoCompactStart(7);
  await tick();
  bridge.autoCompactFinish(true, "50 tokens");
  await tick();
  // the draft id is claimed optimistically (it is ours), so a finish that
  // races a never-landed draft still attempts the stamp — the attempt fails
  // harmlessly, and the persistent result goes out regardless.
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 2, "the spawn attempt + the stamp attempt");
  assert.equal(drafts[1]?.text, "🗜 Context auto-compacted ✔️ 50 tokens", "the stamp carried the result (space-joined)");
  assert.equal(out.calls.at(-1)?.kind, "send");
  assert.equal(out.calls.at(-1)?.text, "🗜 Context auto-compacted ✔️ 50 tokens");
});
