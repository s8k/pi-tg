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
/** Raw config reader mirroring the app's decode: base64 at rest, plaintext in memory. */
const readCfg = (): Cfg => {
  const c = JSON.parse(readFileSync(cfgFile, "utf-8")) as Cfg;
  if (typeof c.botToken === "string" && !c.botToken.includes(":")) {
    const decoded = Buffer.from(c.botToken, "base64").toString("utf-8");
    if (decoded !== "") c.botToken = decoded;
  }
  return c;
};

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

// Regression: on a token change the new bot's existing update backlog used to
// be re-read and re-answered (an unpaired bot replied "not paired" to every
// stale message — incident: ~10 identical replies at once). The drain in
// runConfig advances lastOffset past the backlog and marks it seen WITHOUT
// processing, so the fresh bot neither re-answers stale messages nor re-reads
// them — but still receives genuinely NEW updates (it is not deaf).
test("token change drains the new bot's backlog: no stale replies, new updates still delivered", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let notAuthSends = 0;
  let c1006 = 0;
  const msg = (id: number, mid: number) => ({
    update_id: id,
    message: {
      message_id: mid, date: 1, chat: { id: 42, type: "private" },
      from: { id: 123456, is_bot: false, first_name: "O" }, text: "hello",
    },
  });
  const backlog = [1001, 1002, 1003, 1004, 1005].map((id) => msg(id, 5000 + id));
  const newMsg = msg(1007, 6001);
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    const sig = init?.signal as AbortSignal | undefined;
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true }); }
  });
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "getMe") return ok({ id: 1, is_bot: true, first_name: "B", username: "b" });
    if (method === "getUpdates") {
      const off = Number(body.offset ?? 0);
      if (off === 500) return hang(init);          // old bot's poller (aborted on /tg:config)
      if (off === 0) return ok(backlog);           // drain: read the new bot's backlog
      if (off === 1006) {
        c1006++;
        if (c1006 === 1) return ok([]);            // drain: empty → done
        if (c1006 === 2) return ok([newMsg]);      // new poller: the fresh update
        return hang(init);
      }
      return hang(init);                            // new poller long-poll (offset 1008+)
    }
    if (method !== "getMe" && String(JSON.stringify(body)).includes("Not paired")) notAuthSends++;
    return ok({ message_id: 99999 });
  }) as typeof fetch;

  // old bot, paired, at offset 500
  writeFileSync(cfgFile, JSON.stringify({ botToken: "111:AAOLD0000000000000000", ownerId: 123456, ownerChatId: 42, lastOffset: 500 }));
  const { handlers, config } = await boot("cfgDrain");
  t.after(() => handlers.get("session_shutdown")!());
  handlers.get("session_start")!({}, { cwd: "/tmp", mode: "rpc", hasUI: false, isIdle: () => true, ui: { notify: () => {} }, sessionManager: {} } as never);

  // switch to a brand-new bot that already has a backlog of 5 stale messages
  await config("222:AAbrandnewbot0000000000");

  // the fresh (unpaired) bot must reply "not paired" to the ONE new message
  // (proof it is not deaf) — and to NONE of the 5 stale backlog messages.
  await waitFor(() => notAuthSends >= 1, "the new message got a 'not paired' reply");
  await sleep(150); // give any (buggy) stale replies a chance to land
  assert.equal(notAuthSends, 1, "backlog drained: only the new message is answered, not the 5 stale ones");
  assert.ok((readCfg().lastOffset ?? 0) >= 1006, "lastOffset advanced past the drained backlog");
});

// The same protection on the STARTUP path (a reload goes through session_start,
// not runConfig): an unpaired bot with a backlog of messages that piled up while
// it was offline must not spam one "not paired" reply per stale message.
test("unpaired startup drains the backlog: no stale replies, new updates still delivered", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let notAuthSends = 0;
  let c1006 = 0;
  const msg = (id: number, mid: number) => ({
    update_id: id,
    message: {
      message_id: mid, date: 1, chat: { id: 42, type: "private" },
      from: { id: 123456, is_bot: false, first_name: "O" }, text: "hello",
    },
  });
  const backlog = [1001, 1002, 1003, 1004, 1005].map((id) => msg(id, 5000 + id));
  const newMsg = msg(1007, 6001);
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    const sig = init?.signal as AbortSignal | undefined;
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true }); }
  });
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "getMe") return ok({ id: 1, is_bot: true, first_name: "B", username: "b" });
    if (method === "getUpdates") {
      const off = Number(body.offset ?? 0);
      if (off === 0) return ok(backlog);       // drain: read the backlog
      if (off === 1006) {
        c1006++;
        if (c1006 === 1) return ok([]);        // drain: empty → done
        if (c1006 === 2) return ok([newMsg]);  // new poller: the fresh update
        return hang(init);
      }
      return hang(init);                        // new poller long-poll (1008+)
    }
    if (method !== "getMe" && String(JSON.stringify(body)).includes("Not paired")) notAuthSends++;
    return ok({ message_id: 99999 });
  }) as typeof fetch;

  // unpaired bot, no lastOffset (offset 0), with a backlog of 5 stale messages
  writeFileSync(cfgFile, JSON.stringify({ botToken: "111:AAOLD0000000000000000" }));
  const { handlers } = await boot("cfgStartupDrain");
  t.after(() => handlers.get("session_shutdown")!());
  handlers.get("session_start")!({}, { cwd: "/tmp", mode: "rpc", hasUI: false, isIdle: () => true, ui: { notify: () => {} }, sessionManager: {} } as never);

  // the fresh (unpaired) bot must reply "not paired" to the ONE new message
  // (proof it is not deaf) — and to NONE of the 5 stale backlog messages.
  await waitFor(() => notAuthSends >= 1, "the new message got a 'not paired' reply");
  await sleep(150); // give any (buggy) stale replies a chance to land
  assert.equal(notAuthSends, 1, "startup backlog drained: only the new message is answered, not the 5 stale ones");
  assert.ok((readCfg().lastOffset ?? 0) >= 1006, "lastOffset advanced past the drained backlog");
});
