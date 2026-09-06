import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOut, makeTelegaPi, ctxIsAlive, type CtxLike, type ClientLike, type PiLike } from "../src/wiring.ts";
import { TelegaState } from "../src/state.ts";

test("makeOut: send → addSent + persist, default parseMode HTML", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 777 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return true; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
    sendRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegaState();
  let persists = 0;
  const out = makeOut(client, state, async () => { persists++; });
  const id = await out.send(7, "hello");
  assert.equal(id, 777);
  assert.deepEqual(state.sentIds(), [777]);
  assert.equal(persists, 1);
  assert.deepEqual(calls[0][3], { parseMode: "HTML", replyToId: undefined, replyMarkup: undefined, disableNotification: undefined });
});

test("makeOut: explicit parseMode null survives; edit/delete passthrough", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 1 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return false; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
    sendRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
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
  // detail is a SHORT token note — never the full summary (4096-char limit)
  onComplete!({ tokensBefore: 12345, estimatedTokensAfter: 1024 });
  assert.deepEqual(results, [[true, "12,345 → 1,024 tokens"]]);
  t.compact((ok, detail) => results.push([ok, detail]));
  onComplete!({ summary: "no token info in the result" });
  assert.deepEqual(results[1], [true, undefined]);
  t.compact((ok, detail) => results.push([ok, detail]));
  onError!(new Error("boom"));
  assert.deepEqual(results[2], [false, "boom"]);
});

test("makeTelegaPi: reload → ctx.reload(), forwards ok/error to onDone (fire-and-forget)", async () => {
  let reloadCalls = 0;
  let rejectWith: Error | undefined;
  const ctx = makeFakeCtx({
    reload: async () => {
      reloadCalls++;
      if (rejectWith) throw rejectWith;
    },
  });
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  const results: [boolean, string?][] = [];
  t.reload((ok, detail) => results.push([ok, detail]));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reloadCalls, 1);
  assert.deepEqual(results, [[true, undefined]]);
  rejectWith = new Error("boom");
  t.reload((ok, detail) => results.push([ok, detail]));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(results[1], [false, "boom"]);
});

test("makeTelegaPi: reload without a live command-capable ctx → throws", () => {
  // sessionCtx is alive but lacks the command-only reload() → loud failure
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => undefined, getSessionCtx: () => makeFakeCtx(), listSessions: async () => [] });
  assert.throws(() => t.reload(() => {}));
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

/**
 * Mimics a pi ctx after session replacement: pi invalidates the session’s
 * ExtensionRunner, so EVERY property/method access on a captured ctx throws.
 */
function makeStaleCtx(): CtxLike {
  const stale = new Error("This extension ctx is stale after session replacement or reload.");
  const boom = () => {
    throw stale;
  };
  return {
    get cwd(): string { throw stale; },
    get mode(): string { throw stale; },
    get hasUI(): boolean { throw stale; },
    isIdle: boom,
    abort: boom,
    shutdown: boom,
    compact: boom,
    getContextUsage: boom,
    get model(): CtxLike["model"] { throw stale; },
    get thinkingLevel(): CtxLike["thinkingLevel"] { throw stale; },
    get scopedModels(): CtxLike["scopedModels"] { throw stale; },
    get modelRegistry(): CtxLike["modelRegistry"] { throw stale; },
    get sessionManager(): CtxLike["sessionManager"] { throw stale; },
    get ui(): CtxLike["ui"] { throw stale; },
  };
}

test("ctxIsAlive: live ctx passes, stale (throwing) ctx fails, undefined fails", () => {
  assert.equal(ctxIsAlive(makeFakeCtx()), true);
  assert.equal(ctxIsAlive(makeStaleCtx()), false);
  assert.equal(ctxIsAlive(undefined), false);
});

test("makeTelegaPi: stale cmdCtx (post /new) falls back to live sessionCtx — the /new crash", () => {
  // /new: the /tg internal command captures cmdCtx of the old session, the
  // replacement invalidates it, session_start installs a fresh sessionCtx.
  // The adapter must ignore the stale cmdCtx and serve from sessionCtx.
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => makeStaleCtx(), getSessionCtx: () => makeFakeCtx(), listSessions: async () => [] });
  assert.equal(t.cwd, "/proj");
  assert.equal(t.isIdle(), true);
  assert.equal(t.currentModel()?.id, "a");
  assert.equal(t.currentThinking(), undefined);
  assert.equal(t.messageCount(), 2);
  assert.deepEqual(t.contextUsage(), { tokens: 100, contextWindow: 1000, percent: 10 });
  assert.equal(t.currentSessionPath(), "/proj/s.jsonl");
  assert.equal(t.scopedModels().length, 1);
  assert.equal(t.allModels().length, 2);
});

test("makeTelegaPi: live cmdCtx still preferred over sessionCtx (capability: newSession/switchSession/waitForIdle)", async () => {
  let newCalls = 0;
  const cmd = makeFakeCtx({ newSession: async () => { newCalls++; return { cancelled: false }; } });
  const sess = makeFakeCtx(); // no newSession
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => cmd, getSessionCtx: () => sess, listSessions: async () => [] });
  t.newSession();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newCalls, 1);
});

test("makeTelegaPi: ALL ctxs stale → safe defaults, no throw (teardown window)", () => {
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => makeStaleCtx(), getSessionCtx: () => makeStaleCtx(), listSessions: async () => [] });
  assert.equal(t.cwd, "");
  assert.equal(t.isIdle(), true);
  assert.equal(t.currentModel(), undefined);
  assert.equal(t.messageCount(), 0);
  assert.deepEqual(t.allModels(), []);
  assert.throws(() => t.abort()); // requireCtx: loud, but contained by the bridge’s dispatch wrapper
});

test("makeOut: sendRich → client.sendRichMessage + addSent + persist", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async (chatId, rich) => { calls.push(["rich", chatId, rich]); return { message_id: 888 }; },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegaState();
  const out = makeOut(client, state, async () => {});
  const id = await out.sendRich(7, "a table");
  assert.equal(id, 888);
  assert.deepEqual(state.sentIds(), [888]);
  assert.deepEqual(calls[0], ["rich", 7, { markdown: "a table" }]);
});

test("makeOut: sendRich disableNotification → client.sendRichMessage opts (undefined for notifying)", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async (chatId, rich, opts) => { calls.push(["rich", chatId, rich, opts]); return { message_id: 889 }; },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegaState();
  const out = makeOut(client, state, async () => {});
  await out.sendRich(7, "silent table", { disableNotification: true });
  assert.deepEqual(calls[0], ["rich", 7, { markdown: "silent table" }, { disableNotification: true }]);
  await out.sendRich(7, "loud table");
  assert.equal(calls[1]?.[3], undefined, "a notifying send passes no opts");
});

test("makeOut: sendDraft → passthrough (draftId + canStop + keepOnStop), no addSent", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async (chatId, draftId, rich, canStop, keepOnStop) => { calls.push(["draft", chatId, draftId, rich, canStop, keepOnStop]); return true; },
  };
  const state = new TelegaState();
  const out = makeOut(client, state, async () => {});
  assert.equal(await out.sendDraft(7, 3, "working", true, true), true);
  assert.deepEqual(calls[0], ["draft", 7, 3, { markdown: "working" }, true, true]);
  assert.deepEqual(state.sentIds(), []);
});

test("makeTelegaPi: sessionUsage sums assistant usage across the session branch", () => {
  const ctx = makeFakeCtx({
    sessionManager: {
      getSessionFile: () => "/proj/s.jsonl",
      getSessionName: () => undefined,
      getBranch: () => [
        { type: "message", message: { role: "user", content: "hi" } },
        { type: "message", message: { role: "assistant", usage: { input: 100, output: 200 } } },
        { type: "message", message: { role: "assistant", usage: { input: 50, output: 75 } } },
        { type: "message", message: { role: "assistant" } }, // pending — no usage yet
        { type: "compaction" },
      ],
    },
  });
  const t = makeTelegaPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.deepEqual(t.sessionUsage(), { input: 150, output: 275 });
});
