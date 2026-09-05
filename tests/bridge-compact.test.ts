// The bridge's /compact flow: ephemeral spinner draft (canStop/keepOnStop) +
// "stamp and save" persistent result, busy-session ordering (the aborted
// run's error must land before the draft), Stop-during-compaction, and the
// duplicate-compaction guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, COMPACT_DRAFT_MD } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("compact (idle): spinner draft first, then the stamped persistent result", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(pi.compactCalls, 1, "pi.compact is called (idle: after the draft)");
  const draft = out.calls[0]!;
  assert.equal(draft.kind, "sendDraft");
  assert.equal(draft.text, COMPACT_DRAFT_MD);
  assert.equal(draft.canStop, true);
  assert.equal(draft.keepOnStop, true);
  assert.equal(draft.draftId, 1_000_001, "ids are base + increasing seq");

  pi.compactDone?.(true, "12,345 → 1,024 tokens");
  await tick();
  // the draft is STAMPED with the final state before the persistent send
  // (which clears the draft): the stamped state lands in place first
  const stamp = out.calls[out.calls.length - 2]!;
  assert.equal(stamp.kind, "sendDraft", "the draft is stamped before the send");
  assert.equal(stamp.draftId, 1_000_001);
  assert.equal(stamp.text, "🗜 Context compacted ✔️ — 12,345 → 1,024 tokens");
  const last = out.calls[out.calls.length - 1]!;
  assert.equal(last.kind, "send");
  assert.equal(last.text, "🗜 Context compacted ✔️ — 12,345 → 1,024 tokens");
  assert.equal(last.opts?.parseMode, null);

  // the state is cleared — a new /compact starts fresh (next draft id)
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(out.calls[out.calls.length - 1]?.draftId, 1_000_002);
  pi.compactDone?.(false, "Compaction cancelled");
  await tick();
  assert.equal(out.calls[out.calls.length - 1]?.text, "⚠️ Compaction cancelled");
});

test("compact (busy): compact is triggered FIRST, the draft waits for waitForIdle (mirror settlement)", async () => {
  const pi = new FakePi({ busy: true });
  const adapter = pi.build();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(adapter, out));

  // Gate the (wrapped) idle wait — resolves only when the test says so.
  let resolveIdle: (() => void) | undefined;
  adapter.waitForIdle = () =>
    new Promise<void>((r) => {
      resolveIdle = r;
    });

  const d = bridge.dispatch({ kind: "compact", chatId: 7 });
  await tick();
  assert.equal(pi.compactCalls, 1, "pi.compact called immediately (aborts the in-flight run)");
  assert.equal(out.calls.length, 0, "NO draft yet — the aborted run's persistent error must land first");

  resolveIdle!(); // the run ended AND the mirror flushed (wrapWaitForIdle)
  await d;
  const draft = out.calls[0]!;
  assert.equal(draft.kind, "sendDraft");
  assert.equal(draft.text, COMPACT_DRAFT_MD);
  assert.equal(draft.canStop, true);
  assert.equal(draft.keepOnStop, true);

  pi.compactDone?.(true, "9,000 → 800 tokens");
  await tick();
  const stamp = out.calls[out.calls.length - 2]!;
  assert.equal(stamp.kind, "sendDraft", "the draft is stamped before the send");
  assert.equal(stamp.text, "🗜 Context compacted ✔️ — 9,000 → 800 tokens");
  assert.equal(out.calls[out.calls.length - 1]?.kind, "send");
  assert.equal(out.calls[out.calls.length - 1]?.text, "🗜 Context compacted ✔️ — 9,000 → 800 tokens");
});

test("compact (busy) → Stop while waiting for the run to settle: no draft, plain cancellation stamp", async () => {
  const pi = new FakePi({ busy: true });
  const adapter = pi.build();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(adapter, out));
  let resolveIdle: (() => void) | undefined;
  adapter.waitForIdle = () =>
    new Promise<void>((r) => {
      resolveIdle = r;
    });
  const d = bridge.dispatch({ kind: "compact", chatId: 7 });
  await tick();
  assert.equal(pi.compactCalls, 1);

  await bridge.dispatch({ kind: "stop", chatId: 7 }); // Stop before the draft is up
  assert.equal(pi.abortCalls, 1, "the stop also aborts the in-flight run");
  assert.ok(!out.calls.some((c) => c.kind === "sendDraft"), "no draft was ever shown");

  resolveIdle!();
  await d;
  assert.ok(!out.calls.some((c) => c.kind === "sendDraft"), "the draft is skipped once Stop landed");

  pi.compactDone?.(false, "Compaction cancelled");
  await tick();
  assert.equal(out.calls[out.calls.length - 1]?.text, "⚠️ Compaction cancelled");
});

test("Stop during compaction (A3): draft 🗜 Compacting context… → ⏹️ Stopping… → ⏹️ Stopping… ✔️, then the cancellation message", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  const spawn = out.calls[0]!;
  assert.equal(spawn.kind, "sendDraft");

  await bridge.dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi.abortCalls, 1, "Stop during compaction calls pi.abort() too (pre-compaction settle)");
  const update = out.calls[out.calls.length - 1]!;
  assert.equal(update.kind, "sendDraft");
  assert.equal(update.draftId, spawn.draftId, "same draft id");
  assert.equal(update.text, "⏹️ Stopping…");
  assert.equal(update.canStop, false, "no Stop button on the stopping state");

  // the hook returns {cancel: true} → pi reports the cancellation via onError:
  // the draft stamps the Stop ack, then the cancellation message lands
  pi.compactDone?.(false, "Compaction cancelled");
  await tick();
  const stamp = out.calls[out.calls.length - 2]!;
  assert.equal(stamp.kind, "sendDraft", "the draft stamps the Stop ack");
  assert.equal(stamp.draftId, spawn.draftId);
  assert.equal(stamp.text, "⏹️ Stopping… ✔️");
  const last = out.calls[out.calls.length - 1]!;
  assert.equal(last.kind, "send");
  assert.equal(last.text, "⚠️ Compaction cancelled");
});

test("duplicate /compact while one is in progress → notice, no second compact", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(pi.compactCalls, 1);
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(pi.compactCalls, 1, "no second pi.compact");
  assert.equal(out.calls[out.calls.length - 1]?.text, "🗜 Compaction already in progress — use the Stop button to abort");
  assert.ok(!out.calls.slice(1).some((c) => c.kind === "sendDraft"), "no second draft");
});

test("compact: a failed draft send does not block the compaction (no draft, result still stamped)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  // Make the draft send reject (e.g. bot not allowed to edit) — compact must continue.
  const realSendDraft = out.sendDraft.bind(out);
  let n = 0;
  out.sendDraft = async (...args: Parameters<typeof realSendDraft>) => {
    n++;
    if (n === 1) throw new Error("draft 400");
    return realSendDraft(...args);
  };
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(pi.compactCalls, 1);
  pi.compactDone?.(true, "1,000 → 100 tokens");
  await tick();
  // the draft never went up (draftId 0) — no stamp, only the persistent send
  const sends = out.calls.filter((c) => c.kind === "send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.text, "🗜 Context compacted ✔️ — 1,000 → 100 tokens");
});

test("compact: fast onDone during the draft send — no crash, result still stamped once", async () => {
  const pi = new FakePi();
  const adapter = pi.build();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(adapter, out));
  // Synchronous completion: onDone fires while the draft send is in flight.
  adapter.compact = (onDone) => {
    pi.compactCalls++;
    void onDone(true, "500 → 50 tokens");
  };
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  await tick(); // finishCompact (async) completes its stamp+send chain
  const sends = out.calls.filter((c) => c.kind === "send");
  assert.equal(sends.length, 1, "exactly one stamped result");
  assert.equal(sends[0]!.text, "🗜 Context compacted ✔️ — 500 → 50 tokens");
  // a later duplicate callback must be a no-op
  pi.compactDone?.(true, "again");
  await tick();
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 1);
});

test("compact heartbeat: the draft is re-sent every draftHeartbeatMs and cleared on completion", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out, { draftHeartbeatMs: 10 }));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  const spawn = out.calls[0]!;
  await new Promise((r) => setTimeout(r, 45)); // several heartbeat ticks (10 ms period)
  const heartbeats = out.calls.filter((c) => c.kind === "sendDraft" && c.draftId === spawn.draftId);
  assert.ok(heartbeats.length >= 3, `spawn + heartbeats (got ${heartbeats.length})`);
  assert.equal(heartbeats[1]!.text, COMPACT_DRAFT_MD);
  assert.equal(heartbeats[1]!.canStop, true, "the Stop button stays available during the heartbeat");

  pi.compactDone?.(true, "1,000 → 100 tokens");
  await tick();
  const after = out.calls.length;
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(out.calls.length, after, "no heartbeats after completion");
});

test("compact: pi.compact throwing synchronously → failure stamp, state finalized (no leak)", async () => {
  const pi = new FakePi();
  const adapter = pi.build();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(adapter, out));
  adapter.compact = () => {
    throw new Error("no active pi context");
  };
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(bridge.manualCompact(), undefined, "the state must be cleared");
  assert.equal(out.calls[out.calls.length - 1]?.text, "⚠️ Compaction Failed: no active pi context");
  // and a fresh /compact works again
  adapter.compact = (onDone) => {
    pi.compactCalls++;
    pi.compactDone = onDone;
  };
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.equal(pi.compactCalls, 1);
});

test("manualCompact(): undefined when no compaction is pending, set during one (the hook's gate)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  assert.equal(bridge.manualCompact(), undefined);
  const d = bridge.dispatch({ kind: "compact", chatId: 7 });
  const handle = bridge.manualCompact();
  assert.ok(handle, "the session_before_compact hook sees the pending TG compaction");
  assert.equal(handle!.stopRequested, false);
  assert.equal(handle!.controller.signal.aborted, false);
  await d;
  pi.compactDone?.(true);
  await tick();
  assert.equal(bridge.manualCompact(), undefined, "cleared once finished");
});

// B6 — a text prompt arriving while a MANUAL compaction is in flight.
// pi's prompt() throws in that window ("Cannot submit a prompt while
// compaction is in progress") and isIdle() is still true there, so without
// the gate the prompt would be silently lost and the early draft would
// orphan forever. The bridge must reject it with the B6 message before
// accepting (no early draft, nothing sent to pi).
test("prompt while manual compact in progress → rejected (B6); nothing sent to pi", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  let accepted = 0;
  deps.onPromptAccepted = () => {
    accepted++;
  };
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "compact", chatId: 7 }); // in flight: compactDone never called
  assert.equal(pi.compactCalls, 1);
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "hello" });
  assert.equal(accepted, 0, "no early draft: onPromptAccepted not called");
  assert.equal(pi.sentPrompts.length, 0, "prompt NOT sent to pi");
  const last = out.calls[out.calls.length - 1]!;
  assert.equal(last.kind, "send", "plain persistent send (notifies), not a draft");
  assert.equal(last.text, "🗜 Compaction already in progress — resend your prompt after it finishes");
});

test("prompt while busy-compact (post-abort) in progress → rejected (B6) too", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 }); // B2: aborts the run, then compacts
  assert.equal(pi.compactCalls, 1);
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "next" });
  assert.equal(pi.sentPrompts.length, 0, "prompt NOT sent to pi");
  assert.equal(
    lastSend(out),
    "🗜 Compaction already in progress — resend your prompt after it finishes"
  );
});

test("prompt after the compact finished → normal path (B6 gate lifted)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  pi.compactDone?.(true, "10,000 → 1,000 tokens");
  await tick();
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "hi" });
  assert.deepEqual(pi.sentPrompts, [{ text: "hi", deliverAs: "now" }]);
});
