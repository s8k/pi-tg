// Reload fidelity: gen2 runs on a FRESH index.ts module instance (imported
// with a query-string cache-buster — exactly what pi's /reload produces: a
// new module scope, so the module-level ownerChatId closure is undefined
// again). A second session_start on the SAME instance would pass for the
// wrong reason — the previous generation's in-memory chat id would leak
// through the closure.
//
// Scenario (the user's live bug): gen1 learns the owner chat from a live
// message; /reload happens (gen2 = fresh module, ownerChatId undefined);
// the owner types in the TERMINAL — no new Telegram message arrives. The
// dialog asked on gen2 must still be mirrored to the learned chat, because
// the chat id was persisted in the config and restored at generation start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-telega-reload-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "pi-telega.json"), JSON.stringify({ botToken: "TEST-TOKEN", ownerId: 123456 }));

type Handler = (...a: unknown[]) => unknown;
function boot(mod: { default: (pi: unknown) => void }, handlers: Map<string, Handler>): void {
  mod.default({
    registerCommand: () => {},
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendUserMessage: () => {},
  } as never);
}

const modA = await import("../index.ts");
const handlersA = new Map<string, Handler>();
boot(modA as { default: (pi: unknown) => void }, handlersA);

const fakeUi = () => ({
  notify: () => {},
  select: (_t?: string, _o?: string[]) => new Promise<string | undefined>(() => {}),
  confirm: () => Promise.resolve(false),
  input: () => Promise.resolve(undefined),
  editor: () => Promise.resolve(undefined),
});
const freshCtx = () => ({ cwd: "/tmp", mode: "tui", hasUI: true, isIdle: () => true, ui: fakeUi(), sessionManager: {} });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await sleep(10);
  }
}

test("owner chat survives a reload: gen2 (fresh module) mirrors a dialog to the learned chat with no new owner message", async (t) => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let handlersBRef: Map<string, Handler> | undefined;
  t.after(() => handlersBRef?.get("session_shutdown")!()); // stop this test's poller (it would otherwise race the next test's fake fetch)
  let batch = 0;
  let msgId = 500;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      batch++;
      if (batch === 1)
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, from: { id: 123456, is_bot: false, first_name: "O" }, text: "hi" } },
            ],
          }),
          { status: 200 },
        );
      // later polls hang (the owner types in the terminal — nothing on the wire)
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
        void resolve;
      });
    }
    if (method === "sendMessage")
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // gen 1 (module A): the owner's "hi" teaches the chat (id 42) — the fix persists it
  handlersA.get("session_start")!({}, freshCtx());
  await waitFor(
    () => {
      try {
        return (JSON.parse(readFileSync(join(agentDir, "pi-telega.json"), "utf-8")) as { ownerChatId?: number }).ownerChatId === 42;
      } catch {
        return false;
      }
    },
    "ownerChatId persisted by gen1",
  );

  // /reload: pi shuts down the old runner and loads a FRESH module instance
  handlersA.get("session_shutdown")!();
  // @ts-expect-error -- query-string import: fresh module instance (the /reload equivalent)
  const modB = await import("../index.ts?reload");
  const handlersB = new Map<string, Handler>();
  handlersBRef = handlersB;
  boot(modB, handlersB);
  const ctx2 = freshCtx();
  handlersB.get("session_start")!({ reason: "reload" }, ctx2);

  // a dialog asked on gen2 must go out to the LEARNED chat (42) — before the
  // fix, a fresh generation had ownerChatId undefined and the dialog stayed TUI-only
  const p = ctx2.ui.select("Post-reload dialog", ["x", "y"]);
  void p;
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 42 && JSON.stringify(c.body.reply_markup ?? "").includes("da:1:0")),
    "gen2 dialog mirrored to the learned chat (no new owner message)",
  );
});

test("run started before the chat was learned: the draft appears when the owner message lands mid-run", async (t) => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let handlersCRef: Map<string, Handler> | undefined;
  t.after(() => handlersCRef?.get("session_shutdown")!()); // stop this test's poller
  let batch = 0;
  let msgId = 900;
  let resolveLongPoll: ((updates: unknown[]) => void) | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      batch++;
      if (batch === 1)
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }); // NO owner message — chat unknown
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
        resolveLongPoll = (updates) => resolve(new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }));
      });
    }
    if (method === "sendMessage" || method === "sendRichMessage")
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // The previous test's generation persisted ownerChatId into the shared temp
  // config file — wipe it to recreate the real gap: a fresh generation whose
  // config has NO learned chat (the pre-fix state the upgrade lands in).
  writeFileSync(join(agentDir, "pi-telega.json"), JSON.stringify({ botToken: "TEST-TOKEN", ownerId: 123456 }));

  // fresh module: ownerChatId starts undefined (no ownerChatId in the config file)
  // @ts-expect-error -- query-string import: fresh module instance (the /reload equivalent)
  const modC = await import("../index.ts?reload2");
  const handlersC = new Map<string, Handler>();
  handlersCRef = handlersC;
  boot(modC as { default: (pi: unknown) => void }, handlersC);
  const ctx = freshCtx();
  handlersC.get("session_start")!({}, ctx);
  await waitFor(() => calls.filter((c) => c.method === "getUpdates").length >= 1, "gen polling");

  // a TUI prompt starts the run — no owner Telegram message has arrived yet
  handlersC.get("agent_start")!({}, ctx);
  handlersC.get("message_start")!({ message: { role: "assistant", content: [{ type: "text", text: "" }] } }, ctx);
  handlersC.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }, ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.filter((c) => c.method === "sendRichMessageDraft").length, 0, "no draft while the chat is unknown");

  // an owner message lands mid-run — the learn path must spawn the draft
  resolveLongPoll!([
    { update_id: 2, message: { message_id: 2, date: 2, chat: { id: 42, type: "private" }, from: { id: 123456, is_bot: false, first_name: "O" }, text: "hey" } },
  ]);
  await waitFor(() => calls.some((c) => c.method === "sendRichMessageDraft" && c.body.chat_id === 42), "draft spawned mid-run after the chat was learned");

  // the run ends cleanly — the final messages go out too
  handlersC.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "working on it" }], stopReason: "stop" } }, ctx);
  handlersC.get("agent_settled")!({}, ctx);
  await waitFor(() => calls.filter((c) => c.method === "sendRichMessage" && c.body.chat_id === 42).length >= 1, "final message sent after mid-run chat learning");
});

test("process start (reason startup): the persisted chat is NOT restored — the phone must speak first", async (t) => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let handlersDRef: Map<string, Handler> | undefined;
  t.after(() => handlersDRef?.get("session_shutdown")!()); // stop this test's poller (it would otherwise race the next test's fake fetch)
  let msgId = 1500;
  let inFlight = 0;
  let seenOffset = 0;
  let resolveLongPoll: ((updates: unknown[]) => void) | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      inFlight++;
      seenOffset = Math.max(seenOffset, Number(body.offset ?? 0));
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => { inFlight--; reject(new DOMException("Aborted", "AbortError")); };
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
        resolveLongPoll = (updates) => { inFlight--; resolve(new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 })); };
      });
    }
    if (method === "sendMessage" || method === "sendRichMessage")
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // the config DOES carry a persisted chat (left by a previous process)
  writeFileSync(join(agentDir, "pi-telega.json"), JSON.stringify({ botToken: "TEST-TOKEN", ownerId: 123456, ownerChatId: 42 }));

  // @ts-expect-error -- query-string import: fresh module instance
  const modD = await import("../index.ts?reload3");
  const handlersD = new Map<string, Handler>();
  handlersDRef = handlersD;
  boot(modD as { default: (pi: unknown) => void }, handlersD);
  const ctx = freshCtx();
  handlersD.get("session_start")!({ reason: "startup" }, ctx);

  // a dialog asked right after a process start must stay TUI-only — the bot
  // must not post to Telegram until the owner speaks first
  const p = ctx.ui.select("Post-startup dialog", ["x"]);
  void p;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.filter((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes("da:1:0")).length, 0, "no TG dialog before the owner speaks");

  // the owner speaks — the chat is learned (+ persisted) and dialogs mirror from then on
  resolveLongPoll!([
    { update_id: 3, message: { message_id: 3, date: 3, chat: { id: 42, type: "private" }, from: { id: 123456, is_bot: false, first_name: "O" }, text: "hi" } },
  ]);
  // wait until the poller has PROCESSED the owner message (its next getUpdates
  // carries the advanced offset — the file-based check is vacuous because this
  // test's setup pre-wrote ownerChatId to the config file)
  await waitFor(() => seenOffset >= 4, "poller processed the owner message");
  const p2 = ctx.ui.select("Post-learning dialog", ["y"]);
  void p2;
  // (note: the TUI-only first dialog consumed no id — the mirrored one is id 1)
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 42 && String(c.body.text ?? "").includes("Post-learning dialog")),
    "dialog mirrored after the owner spoke first",
  );
});
