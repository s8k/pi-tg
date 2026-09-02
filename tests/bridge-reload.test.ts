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

test("onSessionReplaced: reload pending → card posted, NO clear question (session unchanged)", async () => {
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
  const texts = out.calls.map((c) => c.text).filter(Boolean) as string[];
  assert.equal(texts.length, 1); // card only — no "Clear chat history?"
  assert.ok(texts[0].startsWith("📌"));
});

test("reload onDone(false, detail) → ⚠️ message; onDone(true) → silence", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch(RELOAD_ACTION);
  const afterFire = out.calls.length;
  pi.reloadDone!(true); // success: the replacement instance posts the card, old stays silent
  assert.equal(out.calls.length, afterFire);
  pi.reloadDone!(false, "extension load failed: syntax error");
  assert.ok(lastSend(out).includes("Reload failed"));
  assert.ok(lastSend(out).includes("extension load failed: syntax error"));
});

test("helpText: lists /reload", () => {
  assert.ok(helpText().includes("/reload"));
});
