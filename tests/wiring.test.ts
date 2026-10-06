import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOut, makeTelegramPi, ctxIsAlive, installUiProxy, UI_PROXY_MARKER, type CtxLike, type ClientLike, type PiLike, type UiDialogHost, type UiDialogAnswer } from "../src/wiring.ts";
import { TelegramState } from "../src/state.ts";

test("makeOut: send → addSent + persist, default parseMode HTML", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 777 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return true; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
    sendRichMessage: async () => { throw new Error("unexpected"); },
    editRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegramState();
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
    editRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
  };
  const out = makeOut(client, new TelegramState(), async () => {});
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

test("makeTelegramPi: sendPrompt now/steer mapping", () => {
  const sent: { text: string; opts?: unknown }[] = [];
  const pi: PiLike = {
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
    setSessionName: () => {},
    getSessionName: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => {},
  };
  const t = makeTelegramPi({ pi, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  t.sendPrompt("hi", "now");
  assert.deepEqual(sent[0].opts, { expandPromptTemplates: true });
  t.sendPrompt("hi", "steer");
  assert.deepEqual(sent[1].opts, { deliverAs: "steer", expandPromptTemplates: true });
});

test("makeTelegramPi: session control goes to cmdCtx (preferred over sessionCtx)", async () => {
  let newCalls = 0;
  let switchCalls: string[] = [];
  const cmd = makeFakeCtx({ newSession: async () => { newCalls++; return { cancelled: false }; }, switchSession: async (p) => { switchCalls.push(p); return { cancelled: false }; } });
  const sess = makeFakeCtx({ newSession: async () => { newCalls += 100; return { cancelled: false }; } });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => cmd, getSessionCtx: () => sess, listSessions: async () => [] });
  t.newSession();
  t.switchSession("/x.jsonl");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newCalls, 1);
  assert.deepEqual(switchCalls, ["/x.jsonl"]);
});

test("makeTelegramPi: setModel scoped-first, registry fallback, unknown → false", async () => {
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
  const t = makeTelegramPi({ pi, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(await t.setModel("b"), true);
  assert.equal(await t.setModel("c"), true);
  assert.equal(await t.setModel("zz"), false);
  assert.deepEqual(calledWith, ["b", "c"]);
});

test("makeTelegramPi: messageCount, contextUsage, cwd getter", () => {
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(t.cwd, "/proj");
  assert.equal(t.messageCount(), 2);
  assert.deepEqual(t.contextUsage(), { tokens: 100, contextWindow: 1000, percent: 10 });
  assert.equal(t.currentSessionPath(), "/proj/s.jsonl");
  assert.equal(t.currentModel()?.id, "a");
});

test("makeTelegramPi: compact callbacks map to onDone(ok, detail)", () => {
  let onComplete: ((r: unknown) => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  const ctx = makeFakeCtx({ compact: (o) => { onComplete = o?.onComplete; onError = o?.onError; } });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
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

test("makeTelegramPi: reload → ctx.reload(), forwards ok/error to onDone (fire-and-forget)", async () => {
  let reloadCalls = 0;
  let rejectWith: Error | undefined;
  const ctx = makeFakeCtx({
    reload: async () => {
      reloadCalls++;
      if (rejectWith) throw rejectWith;
    },
  });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
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

test("makeTelegramPi: reload without a live command-capable ctx → throws", () => {
  // sessionCtx is alive but lacks the command-only reload() → loud failure
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => undefined, getSessionCtx: () => makeFakeCtx(), listSessions: async () => [] });
  assert.throws(() => t.reload(() => {}));
});

test("makeTelegramPi: no ctx at all → safe defaults, no throw", () => {
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => undefined, getSessionCtx: () => undefined, listSessions: async () => [] });
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

test("makeTelegramPi: stale cmdCtx (post /new) falls back to live sessionCtx — the /new crash", () => {
  // /new: the /tg internal command captures cmdCtx of the old session, the
  // replacement invalidates it, session_start installs a fresh sessionCtx.
  // The adapter must ignore the stale cmdCtx and serve from sessionCtx.
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => makeStaleCtx(), getSessionCtx: () => makeFakeCtx(), listSessions: async () => [] });
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

test("makeTelegramPi: live cmdCtx still preferred over sessionCtx (capability: newSession/switchSession/waitForIdle)", async () => {
  let newCalls = 0;
  const cmd = makeFakeCtx({ newSession: async () => { newCalls++; return { cancelled: false }; } });
  const sess = makeFakeCtx(); // no newSession
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => cmd, getSessionCtx: () => sess, listSessions: async () => [] });
  t.newSession();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newCalls, 1);
});

test("makeTelegramPi: ALL ctxs stale → safe defaults, no throw (teardown window)", () => {
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => makeStaleCtx(), getSessionCtx: () => makeStaleCtx(), listSessions: async () => [] });
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
    editRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegramState();
  const out = makeOut(client, state, async () => {});
  const id = await out.sendRich(7, [{ type: "paragraph", text: "a table" }]);
  assert.equal(id, 888);
  assert.deepEqual(state.sentIds(), [888]);
  assert.deepEqual(calls[0], ["rich", 7, { blocks: [{ type: "paragraph", text: "a table" }] }]);
});

test("makeOut: sendRich disableNotification → client.sendRichMessage opts (undefined for notifying)", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async (chatId, rich, opts) => { calls.push(["rich", chatId, rich, opts]); return { message_id: 889 }; },
    editRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegramState();
  const out = makeOut(client, state, async () => {});
  await out.sendRich(7, [{ type: "paragraph", text: "silent table" }], { disableNotification: true });
  assert.deepEqual(calls[0], ["rich", 7, { blocks: [{ type: "paragraph", text: "silent table" }] }, { disableNotification: true }]);
  await out.sendRich(7, [{ type: "paragraph", text: "loud table" }]);
  assert.equal(calls[1]?.[3], undefined, "a notifying send passes no opts");
});

test("makeOut: sendDraft → passthrough (draftId + canStop + keepOnStop), no addSent", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async () => { throw new Error("unexpected"); },
    editRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async (chatId, draftId, rich, canStop, keepOnStop) => { calls.push(["draft", chatId, draftId, rich, canStop, keepOnStop]); return true; },
  };
  const state = new TelegramState();
  const out = makeOut(client, state, async () => {});
  assert.equal(await out.sendDraft(7, 3, [{ type: "thinking", text: "working" }], true, true), true);
  assert.deepEqual(calls[0], ["draft", 7, 3, { blocks: [{ type: "thinking", text: "working" }] }, true, true]);
  assert.deepEqual(state.sentIds(), []);
});

test("makeTelegramPi: sessionUsage sums assistant usage across the session branch", () => {
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
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.deepEqual(t.sessionUsage(), { input: 150, output: 275 });
});

// ── TUI dialog mirroring (Option A): installUiProxy ─────────────────────────

function fakeTuiDialog<T = string | undefined>() {
  let opened = 0;
  let resolver: (v?: T) => void = () => {};
  // stable function (the object literal below would capture the initial ref)
  const press = (v?: T) => resolver(v);
  const fn = (_title: string, _args?: unknown, opts?: { signal?: AbortSignal; timeout?: number }) =>
    new Promise<T | undefined>((resolve) => {
      opened++;
      if (opts?.signal?.aborted) return resolve(undefined);
      const onAbort = () => resolve(undefined);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      resolver = (v) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
    });
  return { fn, press, opened: () => opened };
}

function fakeHost(over: { enabled?: () => boolean; showUndef?: boolean; showResult?: number } = {}) {
  const calls = {
    show: 0,
    tuiAnswered: [] as [number, unknown][],
    answers: new Map<number, (a: UiDialogAnswer) => void>(),
  };
  let nextId = 1; // like the real PendingDialogs: one id per shown dialog
  const host: UiDialogHost = {
    enabled: () => (over.enabled ? over.enabled() : true),
    show: async () => {
      calls.show++;
      if (over.showUndef) return undefined;
      if (over.showResult !== undefined) return over.showResult;
      return nextId++;
    },
    answer: (id, resolve) => calls.answers.set(id, resolve),
    tuiAnswered: (id, value) => calls.tuiAnswered.push([id, value]),
  };
  return { host, calls };
}

const uiTick = () => new Promise<void>((r) => setTimeout(r, 0));

test("installUiProxy: patches all four methods, idempotent, returns true", () => {
  const { host } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: () => {}, editor: () => {} };
  assert.equal(installUiProxy(ui as never, host), true);
  assert.ok(ui[UI_PROXY_MARKER as never]);
  assert.notEqual(ui.select, () => {});
  const selectRef = ui.select;
  assert.equal(installUiProxy(ui as never, host), true, "second install is a no-op");
  assert.equal(ui.select, selectRef, "no re-wrap on repeat install");
});

test("installUiProxy: getter-only property → false + warn, no marker", () => {
  const { host } = fakeHost();
  const obj: Record<string, unknown> = {};
  Object.defineProperty(obj, "select", { get: () => () => {} });
  const warns: string[] = [];
  assert.equal(installUiProxy(obj as never, host, (m) => warns.push(m)), false);
  assert.ok(!obj[UI_PROXY_MARKER as never]);
  assert.ok(warns.length >= 1);
});

test("installUiProxy: no dialog methods at all → false + warn", () => {
  const { host } = fakeHost();
  const warns: string[] = [];
  assert.equal(installUiProxy({} as never, host, (m) => warns.push(m)), false);
  assert.ok(warns.length >= 1);
});

test("wrapped select: TG tap wins → resolves the option; TUI dialog gets aborted; no tuiAnswered", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a", "b"]);
  await uiTick(); // the wrapper awaits host.show before opening the TUI dialog
  assert.equal(calls.show, 1);
  assert.equal(sel.opened(), 1);
  calls.answers.get(1)!({ kind: "option", index: 1 });
  assert.equal(await p, "b");
  assert.equal(calls.tuiAnswered.length, 0, "TG side won — no terminal stamp bookkeeping");
  sel.press("a"); // the abort already resolved the fake with undefined — harmless
});

test("wrapped select: terminal key wins → resolves the TUI value; late TG tap ignored; tuiAnswered called", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a", "b"]);
  await uiTick();
  sel.press("a");
  assert.equal(await p, "a");
  assert.deepEqual(calls.tuiAnswered, [[1, "a"]]);
  calls.answers.get(1)!({ kind: "option", index: 1 }); // stale TG tap after the TUI win
  await uiTick();
  assert.equal(calls.tuiAnswered.length, 1, "late TG answer ignored");
});

test("wrapped confirm: TG 'No' → false; TG cancel → false", async () => {
  const sel = fakeTuiDialog<boolean>();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: sel.fn, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p1 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await uiTick();
  calls.answers.get(1)!({ kind: "option", index: 1 });
  assert.equal(await p1, false);
  const p2 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await uiTick();
  calls.answers.get(2)!({ kind: "cancel" });
  assert.equal(await p2, false);
});

test("wrapped confirm: title + message pass through untouched; the abort signal arrives as opts (3rd arg)", async () => {
  const seen: [string, string, { signal?: AbortSignal } | undefined][] = [];
  const fn = (title: string, message: string, opts?: { signal?: AbortSignal }) => {
    seen.push([title, message, opts]);
    return new Promise<string | undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  };
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: fn, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.confirm as (t: string, m: string) => Promise<boolean | undefined>)("Sure?", "the message text");
  await uiTick();
  assert.deepEqual(seen[0]?.slice(0, 2), ["Sure?", "the message text"], "the message is NOT clobbered by the opts object");
  assert.ok(seen[0]?.[2]?.signal instanceof AbortSignal, "the signal arrives as the 3rd arg (opts)");
  calls.answers.get(1)!({ kind: "option", index: 0 }); // TG 'Yes'
  assert.equal(await p, true);
  assert.equal(seen[0]?.[2]?.signal?.aborted, true, "the TG tap aborts the TUI dialog (it closes)");
});

test("wrapped input: placeholder passes through; signal arrives as opts", async () => {
  const seen: [string, string, { signal?: AbortSignal } | undefined][] = [];
  const fn = (title: string, placeholder: string, opts?: { signal?: AbortSignal }) => {
    seen.push([title, placeholder, opts]);
    return new Promise<string | undefined>(() => {});
  };
  const { host } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: fn, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.input as (t: string, ph: string) => Promise<string | undefined>)("Name?", "type here");
  await uiTick();
  assert.deepEqual(seen[0]?.slice(0, 2), ["Name?", "type here"], "the placeholder is NOT clobbered");
  assert.ok(seen[0]?.[2]?.signal instanceof AbortSignal, "the signal arrives as the 3rd arg (opts)");
  void p;
});

test("wrapped confirm with ONE arg (no message): signal still lands in the opts slot — the live /dialogtest2 bug", async () => {
  // pi's signature is confirm(title, message?, opts?). A caller that omits the
  // message must NOT see the injected opts object land in the `message` slot
  // (pi renders the title as `${title} ${message}` → "[object Object]"), and
  // the abort signal must still be wired (or TG taps can never close the TUI
  // dialog — the listener pi registers is `opts?.signal?.addEventListener`).
  const seen: [unknown, unknown, { signal?: AbortSignal } | undefined][] = [];
  const fn = (title: unknown, message: unknown, opts?: { signal?: AbortSignal }) => {
    seen.push([title, message, opts]);
    return new Promise<string | undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  };
  const { host } = fakeHost();
  const ui = { select: () => {}, confirm: fn, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.confirm as (t: string) => Promise<boolean | undefined>)("Are you sure? (probe)");
  await uiTick();
  assert.equal(seen[0]?.[0], "Are you sure? (probe)", "title untouched");
  assert.ok(!(seen[0]?.[1] instanceof Object && seen[0]?.[1] !== null), `the message slot must not receive the opts object (got ${String(seen[0]?.[1])})`);
  assert.ok(seen[0]?.[2]?.signal instanceof AbortSignal, "the signal arrives in the opts slot (3rd arg)");
  const signal = seen[0]![2]!.signal!;
  signal.dispatchEvent(new Event("abort")); // stand-in for ac.abort() in the wrapper
  assert.equal(await p, undefined, "pi's abort path resolves → the TUI dialog closes");
});

test("wrapped input with ONE arg (no placeholder): signal still lands in the opts slot", async () => {
  const seen: [unknown, unknown, { signal?: AbortSignal } | undefined][] = [];
  const fn = (title: unknown, placeholder: unknown, opts?: { signal?: AbortSignal }) => {
    seen.push([title, placeholder, opts]);
    return new Promise<string | undefined>(() => {});
  };
  const { host } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: fn, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.input as (t: string) => Promise<string | undefined>)("Name?");
  await uiTick();
  assert.equal(seen[0]?.[0], "Name?");
  assert.ok(!(seen[0]?.[1] instanceof Object && seen[0]?.[1] !== null), `the placeholder slot must not receive the opts object (got ${String(seen[0]?.[1])})`);
  assert.ok(seen[0]?.[2]?.signal instanceof AbortSignal, "the signal arrives in the opts slot (3rd arg)");
  void p;
});

test("wrapped select: caller-provided opts are merged (both signals honored)", async () => {
  const seen: [string, string[], { signal?: AbortSignal } | undefined][] = [];
  const fn = (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
    seen.push([title, options, opts]);
    return new Promise<string | undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  };
  const { host, calls } = fakeHost();
  const ui = { select: fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const callerSignal = new AbortController().signal;
  const p = (ui.select as (t: string, o: string[], o2?: { signal?: AbortSignal }) => Promise<string | undefined>)("Pick", ["a", "b"], { signal: callerSignal });
  await uiTick();
  assert.ok(seen[0]?.[2] !== undefined, "the opts object is present");
  assert.ok(seen[0]?.[2]?.signal instanceof AbortSignal, "a single merged signal");
  calls.answers.get(1)!({ kind: "option", index: 1 });
  assert.equal(await p, "b");
  assert.equal(seen[0]?.[2]?.signal?.aborted, true);
  assert.equal(callerSignal.aborted, false, "the caller's own signal is untouched (AbortSignal.any)");
});

test("wrapped confirm: TG 'Yes' → true; terminal 'Yes' → true (value passthrough)", async () => {
  const sel = fakeTuiDialog<boolean>();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: sel.fn, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p1 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await uiTick();
  calls.answers.get(1)!({ kind: "option", index: 0 });
  assert.equal(await p1, true);
  const p2 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await uiTick();
  sel.press(true);
  assert.equal(await p2, true);
  assert.deepEqual(calls.tuiAnswered, [[2, true]]);
});

test("wrapped input: TG text → resolves the text; cancel → undefined", async () => {
  const inp = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: inp.fn, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.input as (t: string) => Promise<string | undefined>)("Name");
  await uiTick();
  calls.answers.get(1)!({ kind: "text", text: "hello" });
  assert.equal(await p, "hello");
  const p2 = (ui.input as (t: string) => Promise<string | undefined>)("Name");
  await uiTick();
  calls.answers.get(2)!({ kind: "cancel" });
  assert.equal(await p2, undefined);
});

test("wrapped editor: no opts → TG text answer still resolves (TUI dialog can't be dismissed)", async () => {
  const ed = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: () => {}, editor: ed.fn };
  installUiProxy(ui as never, host);
  const p = (ui.editor as (t: string, prefill?: string) => Promise<string | undefined>)("Notes", "prefill");
  await uiTick();
  calls.answers.get(1)!({ kind: "text", text: "typed on phone" });
  assert.equal(await p, "typed on phone");
});

test("wrapped select: host disabled → plain passthrough (no show, no race)", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost({ enabled: () => false });
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  sel.press("a");
  assert.equal(await p, "a");
  assert.equal(calls.show, 0);
});

test("wrapped select: show → undefined (unpaired) → TUI-only passthrough", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost({ showUndef: true });
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  await uiTick();
  assert.equal(calls.show, 1);
  sel.press("a");
  assert.equal(await p, "a");
  assert.equal(calls.answers.size, 0, "no race registered when the TG dialog never went out");
});

test("wrapped select: caller-provided signal is COMBINED (caller abort still dismisses the TUI dialog)", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const ac = new AbortController();
  const p = (ui.select as (t: string, o: string[], o3?: { signal?: AbortSignal }) => Promise<string | undefined>)("Pick", ["a"], { signal: ac.signal });
  await uiTick();
  ac.abort(); // the calling extension aborts its own dialog
  assert.equal(await p, undefined);
  assert.deepEqual(calls.tuiAnswered, [[1, undefined]]);
});

// ── Fault isolation: pi-tg's machinery must never break pi or the calling
// plugin — every internal failure degrades to the plain TUI call ─────────────

test("wrapper: a hostile title (throwing toString) → plain TUI call, no throw, no TG twin", async () => {
  const sel = fakeTuiDialog<string | undefined>();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const hostile = { toString(): string { throw new Error("boom"); } };
  const p = (ui.select as (t: unknown, o: string[]) => Promise<string | undefined>)(hostile, ["a", "b"]);
  await uiTick();
  sel.press("a");
  assert.equal(await p, "a", "the caller gets the plain TUI result");
  assert.equal(calls.show, 0, "specFor threw before show — no twin");
});

test("wrapper: a throwing host.enabled → plain TUI call, no throw", async () => {
  const sel = fakeTuiDialog<string | undefined>();
  const { host, calls } = fakeHost({ enabled: () => { throw new Error("boom"); } });
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  await uiTick();
  sel.press("a");
  assert.equal(await p, "a");
  assert.equal(calls.show, 0);
});

test("wrapper: a throwing tuiAnswered → the TUI answer still resolves (no unhandled rejection)", async () => {
  const sel = fakeTuiDialog<string | undefined>();
  const { host, calls } = fakeHost();
  const origTui = host.tuiAnswered;
  host.tuiAnswered = (id, v) => {
    origTui(id, v);
    throw new Error("boom");
  };
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  await uiTick();
  sel.press("a");
  assert.equal(await p, "a", "the TUI value wins despite the stamp failure");
});

test("wrapper: a throwing host.answer → the TUI answer still resolves", async () => {
  const sel = fakeTuiDialog<string | undefined>();
  const { host } = fakeHost();
  host.answer = () => {
    throw new Error("boom");
  };
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  await uiTick();
  sel.press("a");
  assert.equal(await p, "a", "the TUI dialog decides the outcome when the race cannot be attached");
});

test("installUiProxy never throws on hostile ui objects (throwing get / throwing symbol set)", () => {
  const { host } = fakeHost();
  const warns: string[] = [];
  // every property read throws → the marker read must be guarded
  const hostileGet = new Proxy(
    {},
    { get: () => { throw new Error("boom"); } },
  );
  assert.doesNotThrow(() => {
    assert.equal(installUiProxy(hostileGet as never, host, (m) => warns.push(m)), false, "degrades to heads-up-only");
  });
  // string-key sets work but the symbol marker set throws → the patch is in
  // place; the failure must not propagate
  const markerHostile = new Proxy(
    { select: () => "x" },
    {
      get: (t, k) => Reflect.get(t, k),
      set: (t, k, v) => {
        if (typeof k === "symbol") throw new Error("boom");
        return Reflect.set(t, k, v);
      },
    },
  );
  assert.doesNotThrow(() => {
    assert.equal(installUiProxy(markerHostile as never, host, (m) => warns.push(m)), true, "the patch is in place");
  });
});
