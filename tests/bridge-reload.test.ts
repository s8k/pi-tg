import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText, type TelegaPi } from "../src/session-bridge.ts";
import type { TgAction } from "../src/router.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

const RELOAD_ACTION: TgAction = { kind: "reload", chatId: 7 };

test("/reload: idle → pendingAction persisted (awaited) BEFORE pi.reload; user notified", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const order: string[] = [];
  const built = pi.build();
  const traced: TelegaPi = { ...built, reload: (cb) => { order.push("reload"); built.reload(cb); } };
  const deps = makeDeps(traced, out);
  deps.persist = async () => { order.push("persist"); };
  const bridge = new SessionBridge(deps);
  await bridge.dispatch(RELOAD_ACTION);
  assert.equal(pi.reloadCalls, 1);
  assert.deepEqual(order, ["persist", "reload"]); // persisted first — the replacement instance reads it
  assert.ok(lastSend(out).includes("Reloading extensions"));
  assert.deepEqual(deps.cfg.pendingAction, { type: "reload", chatId: 7 });
});

test("/reload: busy → refuse, no pendingAction, no pi.reload call", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  const bridge = new SessionBridge(deps);
  await bridge.dispatch(RELOAD_ACTION);
  assert.ok(lastSend(out).includes("send /stop first"));
  assert.equal(pi.reloadCalls, 0);
  assert.equal(persisted, 0);
  assert.equal(deps.cfg.pendingAction, undefined);
});

test("onSessionReplaced: reload pending → NO card, no clear question (reload is not session-related); pendingAction cleared", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out); // askClearOnSwitch defaults to true
  deps.cfg.pendingAction = { type: "reload", chatId: 7 };
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  const bridge = new SessionBridge(deps);
  await bridge.onSessionReplaced(7);
  assert.equal(deps.cfg.pendingAction, undefined);
  assert.equal(persisted, 1);
  assert.equal(out.calls.length, 0); // no card, no "Clear chat history?" — the ✔️ stamp is the confirmation
});

test("reload onDone(true) → stamps the 'Reloading…' message with ✔️ (best effort)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch(RELOAD_ACTION);
  const reloadingId = out.calls.find((c) => c.text?.includes("Reloading extensions"))!.messageId;
  pi.reloadDone!(true);
  await new Promise((r) => setTimeout(r, 10)); // the stamp is fire-and-forget
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit, "the 'Reloading…' message is edited on success");
  assert.equal(edit.messageId, reloadingId);
  assert.equal(edit.text, "🔄 Reloading extensions… ✔️");

  // the message may be gone (e.g. /clear while reloading) — the edit must not throw
  const pi2 = new FakePi();
  const out2 = new FakeOut();
  out2.edit = async () => { throw new Error("message to edit not found"); };
  const b2 = new SessionBridge(makeDeps(pi2.build(), out2));
  await b2.dispatch(RELOAD_ACTION);
  pi2.reloadDone!(true);
  await new Promise((r) => setTimeout(r, 10));
});

test("reload onDone(false, detail) → ⚠️ message; onDone(true) → no extra send", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch(RELOAD_ACTION);
  pi.reloadDone!(true);
  await new Promise((r) => setTimeout(r, 10));
  const sendsAfterFire = out.calls.filter((c) => c.kind === "send").length;
  assert.equal(sendsAfterFire, 1); // only the 'Reloading…' one — the replacement posts nothing (B)
  pi.reloadDone!(false, "extension load failed: syntax error");
  assert.ok(lastSend(out).includes("Reload failed"));
  assert.ok(lastSend(out).includes("extension load failed: syntax error"));
});

test("helpText: lists /reload", () => {
  assert.ok(helpText().includes("/reload"));
});
