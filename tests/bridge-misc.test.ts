import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

const modelA = { id: "a", name: "Alpha", provider: "p", reasoning: false };
const modelB = { id: "b", name: "Beta", provider: "p", reasoning: true, thinkingLevelMap: { off: "0" } };

test("/models: unscoped → allModels; scoped wins; ★ current; cached ids", async () => {
  const pi = new FakePi({ allModels: [modelA, modelB], model: modelA });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "modelList", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].text, "★ Alpha");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "m:1");

  await bridge.dispatch({ kind: "modelSet", chatId: 7, index: 1 });
  assert.deepEqual(pi.setModels, ["b"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Model set to Beta"));

  // scoped list wins over allModels
  const pi2 = new FakePi({ scopedModels: [{ model: modelB }], model: modelB });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "modelList", chatId: 7 });
  const kb2 = out2.calls[out2.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb2.inline_keyboard.length, 1);

  // unknown model id rejected
  const pi3 = new FakePi({ allModels: [modelA], modelSetResult: false });
  const out3 = new FakeOut();
  const b3 = new SessionBridge(makeDeps(pi3.build(), out3));
  await b3.dispatch({ kind: "modelList", chatId: 7 });
  await b3.dispatch({ kind: "modelSet", chatId: 7, index: 0 });
  assert.ok(out3.calls[out3.calls.length - 1].text?.includes("Unknown model"));

  // expired index
  const out4 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out4)).dispatch({ kind: "modelSet", chatId: 7, index: 9 });
  assert.ok(out4.calls[out4.calls.length - 1].text?.includes("List expired"));
});

test("/thinking: levels from model map; ★ current; set confirms", async () => {
  const pi = new FakePi({ model: modelB, thinking: "off" });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "thinkingList", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const labels = kb.inline_keyboard.map((r) => r[0].text);
  assert.deepEqual(labels, ["★ off", "minimal", "low", "medium", "high"]);
  await bridge.dispatch({ kind: "thinkingSet", chatId: 7, index: 2 });
  assert.deepEqual(pi.setThinkings, ["low"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Thinking: low"));

  // no model
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out2)).dispatch({ kind: "thinkingList", chatId: 7 });
  assert.ok(out2.calls[out2.calls.length - 1].text?.includes("No model selected"));
});

test("/kill: ask → confirm buttons; No keeps running; Yes shuts down", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "killAsk", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].callback_data, "k:1");
  assert.equal(kb.inline_keyboard[0][1].callback_data, "k:0");
  await bridge.dispatch({ kind: "kill", chatId: 7, yes: false });
  assert.equal(pi.shutdownCalls, 0);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("keeps running"));
  await bridge.dispatch({ kind: "kill", chatId: 7, yes: true });
  assert.equal(pi.shutdownCalls, 1);
});

test("clear: Keep → no deletes; Clear → drains tracker, deletes each, throttled, summarizes", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  const bridge = new SessionBridge(deps);
  deps.state.addSent(11);
  deps.state.addSent(12);
  deps.state.addSent(13);
  let sleeps = 0;
  deps.sleep = async () => { sleeps++; };

  await bridge.dispatch({ kind: "clear", chatId: 7, doIt: false });
  assert.equal(out.calls.filter((c) => c.kind === "delete").length, 0);
  assert.equal(deps.state.sentIds().length, 3);

  await bridge.dispatch({ kind: "clear", chatId: 7, doIt: true });
  const dels = out.calls.filter((c) => c.kind === "delete");
  assert.deepEqual(dels.map((d) => d.messageId), [13, 12, 11]); // newest first
  assert.equal(sleeps, 3);
  assert.equal(deps.state.sentIds().length, 0);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Cleared 3/3"));
});

test("compact: spinner draft (canStop, keepOnStop) + stamped persistent result", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  const draft = out.calls[0]!;
  assert.equal(draft.kind, "sendDraft"); // the in-progress state is an EPHEMERAL draft, never a message
  assert.equal(draft.text, "<tg-thinking>🗜 Compacting context…</tg-thinking>");
  assert.equal(draft.canStop, true); // the native Stop button cancels the compaction
  assert.equal(draft.keepOnStop, true);
  assert.ok(draft.draftId! >= 1_000_000, "compact drafts live in their own id namespace");
  pi.compactDone?.(true, "12,345 → 1,024 tokens");
  await new Promise((r) => setTimeout(r, 0));
  const stamp = out.calls[out.calls.length - 2]!;
  assert.equal(stamp.kind, "sendDraft", "the draft is stamped with the final state first");
  assert.equal(stamp.text, "🗜 Context compacted ✔️ 12,345 → 1,024 tokens");
  const last = out.calls[out.calls.length - 1]!;
  assert.equal(last.kind, "send"); // "stamp and save": a normal persistent message (also clears the draft)
  assert.equal(last.text, "🗜 Context compacted ✔️ 12,345 → 1,024 tokens");
  assert.equal(last.opts?.parseMode, null); // detail is free text — no HTML parse
});

test("compact callback: a failed result send must not produce an unhandled rejection", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  out.sendFailsWith = new Error("network down");
  const unhandled: unknown[] = [];
  const onRej = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onRej);
  try {
    pi.compactDone?.(true, "ok");
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onRej);
  }
  assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join("; ")}`);
});
