// /tg:config pairing hygiene (the user's live bug): configuring a NEW bot
// token must NOT carry over the previous bot's pairing (ownerId/ownerChatId).
// ownerId is the global Telegram user id (identical across bots) and the
// router authorizes EVERY update from it — so a stale pairing let the new
// bot accept the old owner's account with no fresh /start.
//
// We boot FRESH index.ts module instances (query-string cache-buster — the
// same trick index-reload.test.ts uses) so each case starts from a known
// cfg: the module snapshots getAgentDir() at load time, so PI_CODING_AGENT_DIR
// must point at a temp dir BEFORE the first import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-config-pair-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// No env token: getBotToken must fall back to the STORED token so the
// token-change detection in runConfig compares what the poller actually uses.
delete process.env.PI_TELEGRAM_BOT_TOKEN;

const cfgFile = join(agentDir, "pi-telegram.json");
type Cfg = {
  botToken?: string;
  ownerId?: number;
  ownerChatId?: number;
  lastOffset?: number;
  sentMessageIds?: number[];
  seenUpdateIds?: number[];
};
const readCfg = (): Cfg => JSON.parse(readFileSync(cfgFile, "utf-8")) as Cfg;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await sleep(10);
  }
}

/**
 * Fake wire for the config handler: getMe → ok; getUpdates → long-poll that
 * hangs forever (runConfig restarts the poller fire-and-forget; we only care
 * about the config file it writes). getMe is hit both by the poller and by
 * runConfig's one-shot supports_inline_queries probe.
 */
const wire = (t: { after: (fn: () => void) => void }): void => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates")
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
};

type Handler = (...a: unknown[]) => unknown;

type TgCmd = { handler: (args: string, ctx: unknown) => Promise<void> };

/** Boot a fresh module instance; return its command handlers + config/unpair. */
async function boot(query: string): Promise<{
  handlers: Map<string, Handler>;
  config: (args: string) => Promise<void>;
  unpair: () => Promise<void>;
}> {
  // query-string import: a fresh module instance (unresolvable to TS → any)
  const mod = await import(`../index.ts?${query}`);
  const handlers = new Map<string, Handler>();
  let cfgCmd: TgCmd | undefined;
  let unpairCmd: TgCmd | undefined;
  mod.default({
    registerCommand: (name: string, def: unknown) => {
      if (name === "tg:config") cfgCmd = def as TgCmd;
      if (name === "tg:unpair") unpairCmd = def as TgCmd;
    },
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendUserMessage: () => {},
  } as never);
  assert.ok(cfgCmd, "the /tg:config command is registered");
  assert.ok(unpairCmd, "the /tg:unpair command is registered");
  const noopCtx = { ui: { notify: () => {} } };
  return {
    handlers,
    config: (args: string) => cfgCmd!.handler(args, noopCtx),
    unpair: () => unpairCmd!.handler("", noopCtx),
  };
}

test("/tg:config with a DIFFERENT bot token clears the stale pairing", async (t) => {
  wire(t);
  // bot api1 is paired to owner 123456 (chat 42)
  writeFileSync(cfgFile, JSON.stringify({ botToken: "111:AAOLD", ownerId: 123456, ownerChatId: 42 }));
  const { handlers, config } = await boot("cfgA");
  t.after(() => handlers.get("session_shutdown")!()); // stop this instance's poller

  // switch to a brand-new bot token (the user's step 4)
  await config("222:AAbrandnewbot0000000000");
  const c = readCfg();
  assert.equal(c.botToken, "222:AAbrandnewbot0000000000", "the new token is saved");
  assert.equal(c.ownerId, undefined, "the stale ownerId is cleared on a bot change");
  assert.equal(c.ownerChatId, undefined, "the stale ownerChatId is cleared on a bot change");
});

test("/tg:config re-saving the SAME token preserves the pairing", async (t) => {
  wire(t);
  // a bot that is already paired
  writeFileSync(cfgFile, JSON.stringify({ botToken: "222:AAbrandnewbot0000000000", ownerId: 555, ownerChatId: 42 }));
  const { handlers, config } = await boot("cfgB");
  t.after(() => handlers.get("session_shutdown")!());

  // re-save the identical token (e.g. re-pasting it) — must NOT unpair
  await config("222:AAbrandnewbot0000000000");
  const c = readCfg();
  assert.equal(c.botToken, "222:AAbrandnewbot0000000000", "the token is saved");
  assert.equal(c.ownerId, 555, "re-saving the same token keeps the pairing");
  assert.equal(c.ownerChatId, 42, "re-saving the same token keeps the learned chat");
});

test("first /tg:config (no prior token) does not error and stays unpaired", async (t) => {
  wire(t);
  writeFileSync(cfgFile, JSON.stringify({}));
  const { handlers, config } = await boot("cfgC");
  t.after(() => handlers.get("session_shutdown")!());

  await config("333:AAbotc0000000000000000");
  const c = readCfg();
  assert.equal(c.botToken, "333:AAbotc0000000000000000", "the token is saved");
  assert.equal(c.ownerId, undefined, "a fresh config has no pairing to carry");
});

test("token change resets the bot-scoped pollers: the new bot is NOT deafened by a carried-over offset", async (t) => {
  // The user's latent bug: lastOffset/sentMessageIds/seenUpdateIds are PER-BOT.
  // A fresh bot starts its update_id sequence near 1, but getUpdates drops every
  // update with update_id < offset — so a carried-over high offset from the old
  // bot makes the new bot deaf (it never sees /start or any message).
  // We prove the fix by driving a REAL poller: session_start boots the OLD bot's
  // poller (offset 999999), then /tg:config switches bots and the NEW poller's
  // first getUpdates must use offset 0 (not 999999).
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const offsets: number[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      offsets.push(Number(body.offset));
      // long-poll: hangs until aborted (a bot swap) — never resolves here, so no
      // poll advances the offset and the persisted file stays at the reset state.
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // bot api1: paired, high offset, with per-bot id trackers
  writeFileSync(cfgFile, JSON.stringify({
    botToken: "111:AAOLD0000000000000000", ownerId: 123456, ownerChatId: 42,
    lastOffset: 999999, sentMessageIds: [1, 2, 3], seenUpdateIds: [10, 11],
  }));
  const { handlers, config } = await boot("cfgDeaf");
  t.after(() => handlers.get("session_shutdown")!()); // stop this instance's poller

  // boot the OLD bot's poller (session_start builds state from cfg.lastOffset)
  handlers.get("session_start")!({}, { cwd: "/tmp", mode: "rpc", hasUI: false, isIdle: () => true, ui: { notify: () => {} }, sessionManager: {} });
  await waitFor(() => offsets.includes(999999), "the old bot polls at the carried-over offset 999999");

  // switch to a brand-new bot
  await config("222:AAbrandnewbot0000000000");

  // the bot-scoped pollers are reset in the persisted file (no poll has returned,
  // so nothing has re-advanced the offset since the reset)
  const c = readCfg();
  assert.equal(c.lastOffset, undefined, "lastOffset is reset (a high offset would deaf the new bot)");
  assert.deepEqual(c.sentMessageIds, [], "sentMessageIds is reset (they are the old bot's messages)");
  assert.deepEqual(c.seenUpdateIds, [], "seenUpdateIds is reset (they are the old bot's update ids)");

  // THE KEY PROOF: the new bot's poller starts at offset 0, so its fresh low
  // update_ids are NOT dropped — the bot is not deaf.
  await waitFor(() => offsets.includes(0), "the new bot polls at offset 0 (not deafened by the old offset)");
});

test("/tg:unpair clears the chat-scoped sentMessageIds but keeps the bot-scoped offset + seenUpdateIds", async (t) => {
  wire(t);
  // a paired bot with chat-scoped sent ids AND bot-scoped poller state
  writeFileSync(cfgFile, JSON.stringify({
    botToken: "111:AAOLD0000000000000000", ownerId: 123456, ownerChatId: 42,
    sentMessageIds: [1, 2, 3], lastOffset: 500, seenUpdateIds: [600],
  }));
  const { handlers, unpair } = await boot("cfgUnpair");
  t.after(() => handlers.get("session_shutdown")!()); // stop this instance's poller

  // session_start builds the live state (sentMessageIds [1,2,3], offset 500,
  // seen [600] — kept because 600 > offset 500), so unpair's state reset is
  // actually exercised (persist() re-syncs cfg.sentMessageIds from state).
  handlers.get("session_start")!({}, { cwd: "/tmp", mode: "rpc", hasUI: false, isIdle: () => true, ui: { notify: () => {} }, sessionManager: {} });

  await unpair();
  const c = readCfg();
  assert.equal(c.ownerId, undefined, "unpair clears ownerId");
  assert.equal(c.ownerChatId, undefined, "unpair clears ownerChatId");
  assert.deepEqual(c.sentMessageIds, [], "unpair clears the chat-scoped sentMessageIds");
  assert.equal(c.lastOffset, 500, "unpair KEEPS the bot-scoped lastOffset (same bot)");
  assert.deepEqual(c.seenUpdateIds, [600], "unpair KEEPS the bot-scoped seenUpdateIds (same bot)");
});
