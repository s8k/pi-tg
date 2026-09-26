import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, type DialogsPort } from "../src/session-bridge.ts";
import { FakePi, FakeOut } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

test("dialogAnswer / dialogCancel / dialogText dispatch to the dialogs port; stale/orphan are silent", async () => {
  const calls: unknown[] = [];
  const port: DialogsPort = {
    tgAnswer: (id, input) => {
      calls.push(["tg", id, input]);
      return true;
    },
    dialogIdForMessage: (m) => (m === 100 ? 7 : undefined),
  };
  const out = new FakeOut();
  const bridge = new SessionBridge({ ...makeDeps(new FakePi().build(), out), dialogs: port });
  await bridge.dispatch({ kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 1 });
  await bridge.dispatch({ kind: "dialogCancel", chatId: 42, dialogId: 3 });
  await bridge.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 100, text: "hello" });
  await bridge.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 999, text: "orphan" });
  assert.deepEqual(calls, [
    ["tg", 3, { kind: "option", index: 1 }],
    ["tg", 3, { kind: "cancel" }],
    ["tg", 7, { kind: "text", text: "hello" }],
  ]);
  assert.equal(out.calls.length, 0, "dialog dispatches never send their own messages (stamps come from PendingDialogs)");
});

test("no dialogs port (flag off at wiring) → dialog actions are silent no-ops", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.dispatch({ kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 0 });
  await bridge.dispatch({ kind: "dialogCancel", chatId: 42, dialogId: 3 });
  await bridge.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 1, text: "x" });
  assert.equal(out.calls.length, 0, "no crash, no noise");
});
