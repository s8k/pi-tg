import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOut, makeTelegaPi, type CtxLike, type ClientLike, type PiLike } from "../src/wiring.ts";
import { TelegaState } from "../src/state.ts";

test("makeOut: send → addSent + persist, default parseMode HTML", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 777 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return true; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
  };
  const state = new TelegaState();
  let persists = 0;
  const out = makeOut(client, state, async () => { persists++; });
  const id = await out.send(7, "hello");
  assert.equal(id, 777);
  assert.deepEqual(state.sentIds(), [777]);
  assert.equal(persists, 1);
  assert.deepEqual(calls[0][3], { parseMode: "HTML", replyToId: undefined, replyMarkup: undefined });
});

test("makeOut: explicit parseMode null survives; edit/delete passthrough", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 1 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return false; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
  };
  const out = makeOut(client, new TelegaState(), async () => {});
  await out.send(7, "plain", { parseMode: null });
  assert.equal((calls[0][3] as { parseMode?: "HTML" | null }).parseMode, null);
  const edited = await out.edit(7, 8, "x", { parseMode: null });
  assert.equal(edited, false);
  // edit pushes ["edit", chatId, messageId, text, opts] → opts at index 4 (plan said 3)
  assert.equal((calls[1][4] as { parseMode?: "HTML" | null }).parseMode, null);
  await out.delete(7, 9);
  assert.deepEqual(calls[2], ["del", 7, 9]);
});

function makeFakeCtx(over: Partial<CtxLike> = {}): CtxLike {
  return {
    cwd: "/proj",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    abort: () => {},
    shutdown: () => {},
    compact: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    model: { id: "a", name: "A", provider: "p", reasoning: false },
    thinkingLevel: undefined,
    scopedModels: [{ model: { id: "a", name: "A", provider: "p", reasoning: false } }],
    modelRegistry: { getAvailable: () => [{ id: "a", name: "A", provider: "p", reasoning: false }, { id: "b", name: "B", provider: "p", reasoning: true }] },
    sessionManager: { getSessionFile: () => "/proj/s.jsonl", getSessionName: () => undefined, getBranch: () => [{ type: "message" }, { type: "custom" }, { type: "message" }] },
    ui: { notify: () => {} },
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    ...over,
  };
}

test("makeTelegaPi: sendPrompt now/steer mapping", () => {
  const sent: { text: string; opts?: unknown }[] = [];
  const pi: PiLike = {
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
    setSessionName: () => {},
    getSessionName: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => {},
  };
  const t = makeTelegaPi({ pi, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  t.sendPrompt("hi", "now");
  assert.deepEqual(sent[0].opts, { expandPromptTemplates: true });
  t.sendPrompt("hi", "steer");
  assert.deepEqual(sent[1].opts, { deliverAs: "steer", expandPromptTemplates: true });
});

test("makeTelegaPi: session control goes to cmdCtx (preferred over sessionCtx)", async () => {
  let newCalls = 0;
  let switchCalls: string[] = [];
  const cmd = makeFakeCtx({ newSession: async () => { newCalls++; return { cancelled: false }; }, switchSession: async (p) => { switchCalls.push(p); return { cancelled: false }; } });
  const sess = makeFakeCtx({ newSession: async () => { newCalls += 100; return { cancelled: false }; } });
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => cmd, getSessionCtx: () => sess, listSessions: async () => [] });
  t.newSession();
  t.switchSession("/x.jsonl");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newCalls, 1);
  assert.deepEqual(switchCalls, ["/x.jsonl"]);
});

test("makeTelegaPi: setModel scoped-first, registry fallback, unknown → false", async () => {
  let calledWith: string[] = [];
  const pi: PiLike = {
    sendUserMessage: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setModel: async (m) => { calledWith.push(m.id); return true; },
    setThinkingLevel: () => {},
  };
  const scopedB = { id: "b", name: "B", provider: "p", reasoning: true, thinkingLevelMap: { xhigh: "9000" } };
  const ctx = makeFakeCtx({ scopedModels: [{ model: scopedB }], modelRegistry: { getAvailable: () => [{ id: "c", name: "C", provider: "p", reasoning: false }, scopedB] } });
  const t = makeTelegaPi({ pi, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(await t.setModel("b"), true);
  assert.equal(await t.setModel("c"), true);
  assert.equal(await t.setModel("zz"), false);
  assert.deepEqual(calledWith, ["b", "c"]);
});

test("makeTelegaPi: messageCount, contextUsage, cwd getter", () => {
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(t.cwd, "/proj");
  assert.equal(t.messageCount(), 2);
  assert.deepEqual(t.contextUsage(), { tokens: 100, contextWindow: 1000, percent: 10 });
  assert.equal(t.currentSessionPath(), "/proj/s.jsonl");
  assert.equal(t.currentModel()?.id, "a");
});

test("makeTelegaPi: compact callbacks map to onDone(ok, detail)", () => {
  let onComplete: ((r: unknown) => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  const ctx = makeFakeCtx({ compact: (o) => { onComplete = o?.onComplete; onError = o?.onError; } });
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  const results: [boolean, string?][] = [];
  t.compact((ok, detail) => results.push([ok, detail]));
  onComplete!({ summary: "summarized 12 msgs" });
  assert.deepEqual(results, [[true, "summarized 12 msgs"]]);
  t.compact((ok, detail) => results.push([ok, detail]));
  onError!(new Error("boom"));
  assert.deepEqual(results[1], [false, "boom"]);
});

test("makeTelegaPi: no ctx at all → safe defaults, no throw", () => {
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => undefined, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(t.cwd, "");
  assert.equal(t.isIdle(), true);
  assert.throws(() => t.abort()); // no ctx → loud failure (bridge’s dispatch wrapper contains it)
  assert.equal(t.contextUsage(), undefined);
  assert.equal(t.messageCount(), 0);
  assert.equal(t.currentModel(), undefined);
  assert.deepEqual(t.allModels(), []);
});
