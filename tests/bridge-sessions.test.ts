import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, type TelegramPi } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

const NOW = Date.now();
const other = { path: "/proj/other.jsonl", id: "o", cwd: "/proj", created: NOW - 9000, modified: NOW - 1000, messageCount: 5, firstMessage: "hello world" };
const older = { path: "/proj/older.jsonl", id: "d", cwd: "/proj", created: NOW - 9000, modified: NOW - 2000, messageCount: 2, name: "Older", firstMessage: "an older session" };

test("/new: pendingAction persisted (awaited) BEFORE newSession; user notified", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const order: string[] = [];
  const built = pi.build();
  const traced: TelegramPi = { ...built, newSession: () => { order.push("newSession"); built.newSession(); } };
  const deps = makeDeps(traced, out);
  deps.persist = async () => {
    await new Promise((r) => setTimeout(r, 0)); // simulate the real async disk save
    order.push("persist");
  };
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "new", chatId: 7 });
  assert.equal(pi.newSessionCalls, 1);
  assert.deepEqual(order, ["persist", "newSession"]); // persisted first — the replacement instance reads it
  const ack = out.calls.find((c) => c.kind === "send")!;
  assert.ok(ack.text?.includes("Creating new session"));
  // the ack message's id is persisted with the pending action (A7: the
  // replacement instance edit-stamps it)
  assert.deepEqual(deps.cfg.pendingAction, { type: "new", chatId: 7, ackMsgId: ack.messageId });
});

test("onSessionReplaced: the /new ack is edit-stamped ✔️ BEFORE the session card (A7)", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  deps.cfg.pendingAction = { type: "new", chatId: 7, ackMsgId: 42 };
  const bridge = new SessionBridge(deps);
  await bridge.onSessionReplaced(7);

  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit, "the ack message is edited");
  assert.equal(edit!.messageId, 42);
  assert.equal(edit!.text, "🔄 Creating new session… ✔️");
  const cardIdx = out.calls.findIndex((c) => c.text?.startsWith("📌"));
  assert.ok(out.calls.indexOf(edit!) < cardIdx, "the stamp lands BEFORE the session card");
  assert.equal(deps.cfg.pendingAction, undefined, "the pending action is still cleared");
});

test("onSessionReplaced: posts card + clear question, clears pendingAction", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  deps.cfg.pendingAction = { type: "new", chatId: 7 };
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  const bridge = new SessionBridge(deps);
  await bridge.onSessionReplaced(7);
  assert.equal(deps.cfg.pendingAction, undefined);
  assert.equal(persisted, 1);
  const texts = out.calls.map((c) => c.text).filter(Boolean) as string[];
  assert.equal(texts.length, 2);
  assert.ok(texts[0].startsWith("📌")); // the STATUS card (not the old session card)
  assert.ok(texts[0].includes("📨 messages:"));
  assert.ok(texts[1].includes("Clear chat history?"));
  const markup = out.calls[out.calls.length - 1].opts?.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(markup.inline_keyboard[0][0].text, "🧹 Clear");
  assert.match(markup.inline_keyboard[0][0].callback_data, /^c:1:.+/, "the Clear button carries a one-shot nonce");
  assert.match(markup.inline_keyboard[0][1].callback_data, /^c:0:.+/, "the Keep button carries a one-shot nonce");
});

test("onSessionReplaced: no pendingAction → no-op", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.onSessionReplaced(7);
  assert.equal(out.calls.length, 0);
});

test("/sessions: newest-first, ★ on current, buttons cached for later callbacks", async () => {
  const pi = new FakePi({ sessions: [older, other] });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "sessions", chatId: 7 });
  const last = out.calls[out.calls.length - 1];
  const kb = last.opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, "hello world — 5 msgs, 1s ago"); // other (modified 2000) first; 'xc' cancel not here
  assert.equal(rows[0][0].callback_data, "s:0");
  assert.equal(rows[1][0].text, "Older — 2 msgs, 2s ago");
  assert.equal(rows[1][0].callback_data, "s:1");
  // current session marked
  const pi2 = new FakePi({ sessions: [other], sessionPath: "/proj/other.jsonl" });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "sessions", chatId: 7 });
  const kb2 = out2.calls[out2.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.ok(kb2.inline_keyboard[0][0].text.startsWith("★ "));
});

test("/sessions: empty → note", async () => {
  const out = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out)).dispatch({ kind: "sessions", chatId: 7 });
  assert.ok(out.calls[out.calls.length - 1].text?.includes("No sessions"));
});

test("activate: current → 'Already active'; idle → switch; busy → refuse; expired → hint", async () => {
  // idle switch
  const pi = new FakePi({ sessions: [other] });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "sessions", chatId: 7 }); // populate cache
  await bridge.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  assert.deepEqual(pi.switchSessions, ["/proj/other.jsonl"]);
  assert.deepEqual(deps.cfg.pendingAction, { type: "activate", chatId: 7, path: "/proj/other.jsonl" });
  assert.ok(out.calls.some((c) => c.text?.includes("Switching session")));

  // current
  const pi2 = new FakePi({ sessions: [other], sessionPath: "/proj/other.jsonl" });
  const out2 = new FakeOut();
  const b2 = new SessionBridge(makeDeps(pi2.build(), out2));
  await b2.dispatch({ kind: "sessions", chatId: 7 });
  await b2.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  assert.equal(pi2.switchSessions.length, 0);
  assert.ok(out2.calls[out2.calls.length - 1].text?.includes("Already active"));

  // busy → plain refusal (no confirm button — a switch cannot wait for the
  // current turn; the user must /stop first)
  const pi3 = new FakePi({ sessions: [other], busy: true });
  const out3 = new FakeOut();
  const b3 = new SessionBridge(makeDeps(pi3.build(), out3));
  await b3.dispatch({ kind: "sessions", chatId: 7 });
  await b3.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  const last3 = out3.calls[out3.calls.length - 1];
  assert.equal(last3.text, "Agent is busy — send /stop first.");
  assert.equal(last3.opts?.replyMarkup, undefined, "no confirm button — a plain refusal");
  assert.equal(pi3.switchSessions.length, 0, "no switch was made");

  // expired
  const out4 = new FakeOut();
  const b4 = new SessionBridge(makeDeps(new FakePi().build(), out4));
  await b4.dispatch({ kind: "sessionActivate", chatId: 7, index: 3 });
  assert.ok(out4.calls[out4.calls.length - 1].text?.includes("List expired"));
});

test("/name: empty → usage; else renames + confirms", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "nameSet", chatId: 7, name: "" });
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Usage"));
  await bridge.dispatch({ kind: "nameSet", chatId: 7, name: "My Session" });
  assert.deepEqual(pi.setNames, ["My Session"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("My Session"));
});
