
import { SessionManager, getAgentDir, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, getBotToken, configPath } from "./src/config.ts";
import { TelegramClient, pollLoop } from "./src/telegram-client.ts";
import type { TgUpdate } from "./src/telegram-client.ts";
import { route } from "./src/router.ts";
import { encodeInternal, parseInternal } from "./src/command-args.ts";
import { TelegramState } from "./src/state.ts";
import { SessionBridge } from "./src/session-bridge.ts";
import { probeGpu } from "./src/gpu.ts";
import type { Out, TelegramPi } from "./src/session-bridge.ts";
import { Mirror, compactTokenDetail } from "./src/mirror.ts";
import type { MirrorMessage } from "./src/mirror.ts";
import { renderQr, qrWidgetFactory, tokenLooksValid, notAuthorizedBlocks } from "./src/onboarding.ts";
import { makeOut, makeTelegramPi, ctxIsAlive, wrapWaitForIdle, installUiProxy } from "./src/wiring.ts";
import { PendingDialogs } from "./src/ui-dialogs.ts";
import { runTgCompaction } from "./src/compact.ts";
import { mergeCommands, filterCommands, customCommandMatch, toInlineResults, toCustomResult, isListable, dispatchFor, actionForDecision } from "./src/pi-commands.ts";
import type { TgInlineQuery } from "./src/telegram-client.ts";

// pi's agent dir honors PI_CODING_AGENT_DIR (tests point it at a temp dir).
// configPath also runs the one-time migration from the legacy `pi-telega.json`
// filename (token + pairing carry over, no re-pair).
const CFG = { agentDir: getAgentDir() };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The "after" count for the AUTO compact detail (`before → after tokens`).
 * pi computes estimatedTokensAfter = Σ estimateTokens(buildSessionContext()
 * .messages) internally right before it emits session_compact, but only
 * tokensBefore reaches the extension event. The compaction entry is already
 * appended to the session when the event fires, so the public
 * buildSessionContext() returns the POST-compact context — summing pi's own
 * public estimateTokens over its messages reproduces the identical number.
 * `undefined` = unavailable (API drift, stale ctx, …) → the detail degrades
 * to before-only; version-safe against 0.85.0.
 */
const estimatePostCompactTokens = (ctx: ExtensionContext | undefined): number | undefined => {
  try {
    // The ctx type exposes the read-only Pick; at runtime it is the full
    // SessionManager (pi constructs it). If a future pi drops the method
    // from the runtime object, the ?. chain degrades to undefined (before-only).
    const sm = ctx?.sessionManager as SessionManager | undefined;
    const messages = sm?.buildSessionContext?.()?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    let total = 0;
    for (const m of messages) total += estimateTokens(m as never);
    return total;
  } catch {
    return undefined;
  }
};

const listSessionsImpl = async (cwd: string) => {
  const infos = await SessionManager.list(cwd);
  return infos.map((i) => ({
    path: i.path,
    id: i.id,
    cwd: i.cwd,
    name: i.name,
    created: i.created.getTime(),
    modified: i.modified.getTime(),
    messageCount: i.messageCount,
    firstMessage: i.firstMessage,
  }));
};

export default function piTelegram(pi: ExtensionAPI): void {
  let cfg = loadConfig(CFG);
  let state: TelegramState | undefined;
  let bridge: SessionBridge | undefined;
  let client: TelegramClient | undefined;
  let out: Out | undefined;
  let piAdapter: TelegramPi | undefined;
  let ownerChatId: number | undefined;
  let botUsername: string | undefined;
  let cmdCtx: ExtensionCommandContext | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let stopping = false;
  let pollGen = 0;
  /** One AbortController per polling generation: aborting it rejects the
   * in-flight long poll so the dying generation exits in milliseconds and
   * can never overlap a replacement poller on the wire. */
  let pollAbort: AbortController | undefined;
  let pollPromise: Promise<unknown> | undefined;
  let currentMirror: Mirror | undefined;
  /** Mirrored TUI dialogs (one instance per polling generation). */
  let dialogs: PendingDialogs | undefined;
  // T6 auto-compact lane, chosen at session_before_compact (auto): where the
  // result events land — the live run's draft (mirror) or the bridge's
  // standalone draft (bridge). Undefined = nothing to report (mute level /
  // unpaired / manual / no result yet).
  let autoCompactLane: "mirror" | "bridge" | undefined;

  const persist = async (): Promise<void> => {
    await saveConfig(cfg, CFG);
  };

  const ui = (text: string, level: "info" | "warning" | "error" = "info"): void => {
    // During the teardown→replacement window both captured ctxs can be stale;
    // a stale notify would throw, and if it happens inside a .catch callback it
    // becomes an unhandled rejection (process crash). Probe before notifying.
    const c = ctxIsAlive(sessionCtx) ? sessionCtx : ctxIsAlive(cmdCtx) ? cmdCtx : undefined;
    c?.ui.notify(text, level);
  };

  // mirror handlers are fire-and-forget: a transient Telegram error must not
  // become an unhandled rejection (Node ≥15 default = crash the pi process);
  // sync handlers must not throw into pi's emitter at all
  const safe = (p: Promise<unknown> | undefined): void => {
    void p?.catch((err) => ui(`pi-tg mirror error: ${String(err)}`, "error"));
  };
  const safeCall = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      ui(`pi-tg mirror error: ${String(err)}`, "error");
    }
  };

  async function startPolling(): Promise<number> {
    const gen = ++pollGen;
    stopping = false;
    const aborter = new AbortController();
    pollAbort = aborter;
    if (!state) return gen;
    const token = getBotToken(cfg, CFG);
    client = new TelegramClient(token ?? "", {});
    const outAdapter = makeOut(client, state, persist);
    out = outAdapter;
    dialogs = new PendingDialogs({
      out: outAdapter,
      getChatId: () => ownerChatId,
      // Dialogs follow the output level: mute suppresses them (mute = commands
      // in, command responses out — a phone that only gets /reload ✔️ must not
      // also get ❓ dialogs it cannot contextually understand); minimal and
      // full both mirror (otherwise the owner is blocked on a TUI prompt with
      // no idea how to proceed). Live re-read: /level_* takes effect on the
      // very next dialog; already-shown dialogs stay answerable (answering is
      // never gated).
      enabled: () => cfg.mirrorDialogs && cfg.level !== "mute",
      notify: (m, l) => ui(m, l),
      // The mirror's live draft is finalized as a persistent segment BEFORE
      // the dialog message lands, so the dialog + the post-answer draft sit
      // in chronological order (a pre-dialog draft would otherwise keep its
      // original position while streaming — above/below the dialog per client).
      onShown: () => currentMirror?.pauseForDialog(),
    });
    piAdapter = makeTelegramPi({
      pi,
      getCmdCtx: () => cmdCtx,
      getSessionCtx: () => sessionCtx,
      listSessions: listSessionsImpl,
    });
    const deps = {
      pi: piAdapter,
      out: outAdapter,
      state,
      cfg,
      botUsername: undefined as string | undefined,
      persist,
      sleep,
      probeGpu,
      dialogs,
      // T6 early draft: the run's draft (spinner) goes out when the prompt is
      // dispatched, before pi's agent_start.
      onPromptAccepted: () => safeCall(() => currentMirror?.onPromptAccepted()),
    };
    bridge = new SessionBridge(deps);
    if (!token) {
      ui("pi-tg: no bot token — run /tg:config <bot_token>", "warning");
      return gen;
    }
    let username: string | undefined;
    try {
      const me = await client.getMe();
      username = me.username;
      if (me.supports_inline_queries === false) {
        ui(
          "pi-tg: INLINE MODE IS DISABLED for this bot — the ⌨️ picker button and the inline command list will not work. Enable it: @BotFather → /mybots → Bot Settings → API Services → Inline mode (also enable 'Inline feedback' so a tap executes the command). Restart Pi or /tg:reload afterwards.",
          "warning",
        );
      }
    } catch (err) {
      ui(`pi-tg: getMe failed: ${String(err)}`, "error");
      return gen;
    }
    deps.botUsername = username;
    botUsername = username; // outer-scope mirror (route() opts)
    // Set the bot menu (self-healing: runs on every poller start). Best-effort:
    // a failure logs a TUI warning and must never block or stop polling.
    void client.setMyCommands().catch((err) => ui(`pi-tg: setMyCommands failed: ${String(err)}`, "warning"));
    const mirror = new Mirror({
      out: outAdapter,
      state,
      cfg,
      getChatId: () => ownerChatId,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.(); // don't hold the process open if pi exits mid-turn
        return t;
      },
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      notify: (msg, level) => ui(msg, level ?? "error"),
    });
    currentMirror = mirror;
    // The bridge's compact/stop flows await pi.waitForIdle() — extend it so
    // the wait ALSO covers the mirror's run finalization (all persistent
    // sends delivered). pi's extension runner does not await the mirror's
    // fire-and-forget handlers, so the bare wait would resolve before e.g.
    // the aborted run's "⚠️ error: Request was aborted" reached Telegram —
    // and the /compact draft sent in between would be cleared by it.
    wrapWaitForIdle(piAdapter, () => mirror.whenSettled());
    await pollLoop({
      client,
      getOffset: () => state!.getOffset(),
      setOffset: (n) => {
        state!.setOffset(n);
        cfg.lastOffset = n;
        cfg.seenUpdateIds = state!.seenIds(); // persisted with the offset (replay guard)
        void persist();
      },
      onUpdate: (u: TgUpdate) => handleUpdate(u),
      isSeen: (id) => state!.isSeen(id),
      markSeen: (id) => state!.markSeen(id),
      onError: (err) => ui(`pi-tg poll error: ${String(err)}`, "error"),
      onConflict: () => ui("pi-tg: another client is polling this bot token (409 Conflict) — backing off and retrying", "warning"),
      shouldStop: () => stopping || gen !== pollGen,
      sleep,
      signal: aborter.signal,
    });
    return gen;
  }

  async function handleUpdate(update: TgUpdate): Promise<void> {
    if (!bridge || !out || !state) return;
    // Inline picker: the owner's inline search — answer with the (filtered)
    // session-command table. No action here: execution arrives LATER as
    // chosen_inline_result (the tapped card) — that update requires
    // BotFather's "Inline feedback" to be enabled.
    if (update.inline_query) {
      await handleInlineQuery(update.inline_query);
      return;
    }
    // Answer EVERY callback query (silent, no toast): Telegram keeps a loading
    // animation on a tapped button until the callback is answered. Best-effort
    // — a failure must never block the action itself (the button just animates
    // a bit longer).
    const cbId = update.callback_query?.id;
    if (cbId && client) void client.answerCallbackQuery(cbId).catch(() => {});
    const action = route(
      update,
      cfg.ownerId,
      {
        isDialogMessage: (id) => dialogs?.isDialogMessage(id) ?? false,
        plainAnswer: (t) => dialogs?.plainAnswerFor(t),
        ownerChatId,
        // Typed `@bot /<name> args` for a name the TG switch doesn't know:
        // consult the LIVE session-command table (only its names are legal —
        // an unknown name keeps the old unknown/prompt behavior).
        sessionCommand: (name, rest, chatId) => {
          const d = dispatchFor(name, rest, mergeCommands(piAdapter?.getCommands() ?? []));
          return d ? actionForDecision(d, chatId) : undefined;
        },
        // The ⌨️ entry button inserts "@<bot> /…" into the input field — text
        // sent from inline mode carries the mention; the router strips it so
        // `@pi-tg /mcp serve …` routes like `/mcp serve …`.
        botUsername,
      },
    );
    if (action.kind === "ignore") return;
    const msg = update.message;
    if (msg && msg.from && cfg.ownerId !== undefined && msg.from.id === cfg.ownerId) {
      if (ownerChatId !== msg.chat.id) {
        ownerChatId = msg.chat.id;
        cfg.ownerChatId = msg.chat.id;
        void persist(); // survive the next reload/restart
        // A run that started while the chat was unknown (fresh generation +
        // TUI prompt) never spawned its draft — spawn it now.
        safeCall(() => currentMirror?.onChatLearned());
      }
    }
    if (action.kind === "notAuthorized") {
      await out.sendRich(action.chatId, notAuthorizedBlocks(false));
      return;
    }
    if (action.kind === "unknown") {
      await out.send(action.chatId, `I didn’t understand that — send /help for the command list.`, { parseMode: null });
      return;
    }
    if (action.kind === "prompt") {
      await bridge.dispatch(action);
      return;
    }
    const encoded = encodeInternal(action);
    if (encoded === null) return;
    pi.sendUserMessage(`/tg ${encoded}`, { expandPromptTemplates: true });
  }

  /**
   * The inline command picker (Bot API inline_query): the owner searches the
   * session-command table (built-ins + extension commands + prompt templates
   * + skills). Each result's id is `c<nonce>` — the nonce is registered in
   * the bridge's pending-runs map (32 entries, oldest evicts; an evicted tap
   * is a silent no-op), so a later chosen_inline_result executes this
   * result. Non-owner: an empty answer (nothing leaks — the table is the
   * session's command menu).
   */
  async function handleInlineQuery(q: TgInlineQuery): Promise<void> {
    if (!client) return;
    const isOwner = cfg.ownerId !== undefined && q.from.id === cfg.ownerId;
    const c = client; // stable binding for the answer closure (narrowing)
    // The client spins a loader until the query is answered — and blocks the
    // input field while it does. So if the primary answer fails, an EMPTY
    // fallback answer MUST still be attempted: it is the API's "no results"
    // signal, it clears the spinner, and it lets the user press Enter and
    // send the raw text (e.g. "/mcp serve …") as an ordinary message.
    const answer = async (results: unknown[]): Promise<void> => {
      try {
        // is_personal: the table is THIS session's command menu — a shared
        // server-side cache (the default) could serve it to a non-owner who
        // types the same query in any chat, without us ever seeing their query.
        await c.answerInlineQuery(q.id, results, { isPersonal: true });
      } catch (err) {
        ui(`pi-tg: answerInlineQuery failed: ${String(err)}`, "error");
        // ALWAYS retry an empty answer — even when the primary was already
        // empty: a rejected call means Telegram never received ANY answer,
        // so the client's spinner is still spinning and only another
        // (empty) answer can clear it. One cheap extra call in a rare path.
        try {
          await c.answerInlineQuery(q.id, [], { isPersonal: true });
        } catch (err2) {
          ui(`pi-tg: empty fallback answerInlineQuery also failed: ${String(err2)}`, "error");
        }
      }
    };
    if (!isOwner) {
      await answer([]); // nothing leaks — the table is the session's command menu
      return;
    }
    const table = mergeCommands(piAdapter?.getCommands() ?? []);
    // "<command> <args>" while typing arguments → a SINGLE run-as-typed
    // result: the tap/Enter auto-sends the full text, the router executes it.
    // t-id: NOT registered in pendingRuns (the chosen update is ignored —
    // the auto-sent message is the execution, exactly once).
    const custom = customCommandMatch(table, q.query);
    if (custom) {
      const base = Date.now().toString(36);
      await answer([toCustomResult(custom, () => base + "a")]);
      return;
    }
    // Pre-filter to what is LISTABLE so results[i] and listable[i] stay
    // 1:1 aligned — the nonce→name registration below depends on it
    // (toInlineResults would drop terminal-only/duplicate rows internally
    // and desynchronize the two arrays).
    const listable = filterCommands(table, q.query).filter(isListable);
    // base36 timestamp + per-answer counter: unique ≤10-char nonces
    // (result_id `c<nonce>` fits 64 bytes).
    let n = 0;
    const base = Date.now().toString(36);
    const results = toInlineResults(listable, () => `${base}${(n++).toString(36)}`, q.query);
    for (let i = 0; i < results.length; i++) bridge?.registerRun(results[i]!.id.slice(1), listable[i]!.name);
    await answer(results);
  }

  function cardLines(): string[] {
    const p = piAdapter;
    if (!p) return ["pi-tg: not ready yet"];
    const model = p.currentModel();
    const usage = p.contextUsage();
    const thinking = p.currentThinking();
    return [
      `📌 ${p.getSessionName() ?? "(unnamed session)"}`,
      `📁 ${p.cwd}`,
      `🤖 ${model?.name ?? "no model"}${thinking ? ` · thinking: ${thinking}` : ""}`,
      `💬 ${p.messageCount()} messages`,
      usage?.percent != null ? `🧠 ${usage.percent}% context` : "🧠 context: n/a",
      `📄 ${p.currentSessionPath()}`,
    ];
  }

  function showCard(ctx: ExtensionCommandContext): void {
    const lines = cardLines();
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-tg", lines);
    else ctx.ui.notify(lines.join("\n"), "info");
  }

  async function showQr(ctx: ExtensionCommandContext): Promise<void> {
    const token = getBotToken(cfg, CFG);
    if (!token) {
      ctx.ui.notify("pi-tg: no token yet — run /tg:config <bot_token>", "warning");
      return;
    }
    const c = client ?? new TelegramClient(token, {});
    try {
      const me = await c.getMe();
      if (!ctxIsAlive(ctx)) return; // session replaced mid-flight → ctx is stale
      const qr = renderQr(`https://t.me/${me.username}`);
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-tg-qr", qrWidgetFactory(qr)); // factory form: array form is capped at 10 lines
      else ctx.ui.notify(`open https://t.me/${me.username} in Telegram`, "info");
    } catch (err) {
      ui(`pi-tg: getMe failed: ${String(err)}`, "error");
    }
  }

  // ── terminal commands ──

  const TG_USAGE = "Usage: /tg | /tg:config <bot_token> | /tg:pair | /tg:unpair";

  async function runConfig(token: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!tokenLooksValid(token)) {
      ctx.ui.notify("pi-tg: invalid token (expected <digits>:<alnum/ -_>, e.g. 123456:AAH…)", "error");
      return;
    }
    cfg.botToken = token;
    await persist();
    const old = pollPromise;
    stopping = true;
    pollAbort?.abort(); // end the old in-flight long poll at once
    if (old) await old.catch(() => {});
    // A session replacement can happen while we were waiting above — in that
    // case this handler's ctx is stale and must not be used any more.
    if (!ctxIsAlive(ctx)) return;
    pollPromise = startPolling().catch((err) => ui(`pi-tg: ${String(err)}`, "error"));
    void pollPromise;
    ctx.ui.notify("pi-tg: token saved, poller restarted. Run /tg:pair to show the QR.", "info");
  }

  async function runPair(ctx: ExtensionCommandContext): Promise<void> {
    if (cfg.ownerId) {
      ctx.ui.notify(`pi-tg: already paired with owner ${cfg.ownerId}. Run /tg:unpair to unpair.`, "info");
      return;
    }
    await showQr(ctx);
  }

  async function runUnpair(ctx: ExtensionCommandContext): Promise<void> {
    if (!cfg.ownerId) {
      ctx.ui.notify("pi-tg: not paired — nothing to unpair.", "info");
      return;
    }
    cfg.ownerId = undefined;
    cfg.ownerChatId = undefined;
    ownerChatId = undefined; // Mirror must stop posting to the stale chat
    await persist();
    if (!ctxIsAlive(ctx)) return; // session replaced while persisting
    ctx.ui.notify("pi-tg: unpaired. Bot is silent until a new account presses /start (/tg:pair shows the QR).", "info");
  }

  // One entry per command in pi's `/` completion list (see pi extensions docs).
  // `tg:config` / `tg:pair` use colon names the same way skills use /skill:name.
  pi.registerCommand("tg", {
    description: "Show session card (model, context usage, session path)",
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "internal", label: "internal", description: "machine dispatch (poller → TUI)" }];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "internal") {
        // Machine-only path: the Telegram poller injects these.
        const action = parseInternal(args.trim());
        if (action && bridge) await bridge.dispatch(action);
        else ctx.ui.notify("pi-tg: bad /tg internal payload", "error");
        return;
      }
      if (sub !== "") {
        ctx.ui.notify(TG_USAGE, "error");
        return;
      }
      showCard(ctx);
    },
  });

  pi.registerCommand("tg:config", {
    // Format matches pi's built-in completion lines, e.g. /thinking:
    // `<args> — Description` (the extension API exposes no argumentHint).
    description: "<bot_token> — Save Telegram bot token, restart poller",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      await runConfig(args.trim(), ctx);
    },
  });

  pi.registerCommand("tg:pair", {
    description: "Show pairing QR (only while unpaired)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      await runPair(ctx);
    },
  });

  pi.registerCommand("tg:unpair", {
    description: "Unpair the phone (bot silent until a new /start)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      await runUnpair(ctx);
    },
  });

  // ── lifecycle ──

  pi.on("session_start", (event, ctx) => {
    sessionCtx = ctx;
    // Every previously captured ctx belongs to the torn-down session (pi caches
    // extension instances across replacements but invalidates the old
    // ExtensionRunner) — drop the command ctx so nothing stale can shadow the
    // fresh sessionCtx. See pi docs: “reestablish any in-memory state in session_start”.
    cmdCtx = undefined;
    autoCompactLane = undefined; // the old instance's lane choice is stale
    cfg = loadConfig(CFG);
    state = new TelegramState(cfg.lastOffset ?? 0);
    state.restoreSentIds(cfg.sentMessageIds ?? []);
    state.restoreSeenIds(cfg.seenUpdateIds ?? [], cfg.lastOffset ?? 0);
    // In-process generation swaps ("reload") restore the persisted owner chat
    // so the mirror keeps working seamlessly. A fresh process ("startup") must
    // NOT: after a pi restart the bot stays silent on Telegram until the owner
    // sends a message first (the learn path then sets + persists the chat).
    if (event.reason === "reload")
      ownerChatId = cfg.ownerId !== undefined ? cfg.ownerChatId : undefined;
    // A failure here (e.g. in onSessionReplaced) must surface as a TUI notice,
    // never as an unhandled rejection that kills the pi process.
    pollPromise = (async () => {
      // Stop the previous generation BEFORE starting the new one. With its
      // long poll still in flight, the new poller's first getUpdates would
      // 409 (one poller per token) — and on pre-fix code that killed the NEW
      // loop while the old one died on its generation check: no poller left,
      // bot deaf. abort() is synchronous (the in-flight fetch rejects and the
      // old loop's shouldStop flag is set), so the old loop can never issue
      // ANOTHER getUpdates — no overlap on the wire. We deliberately do NOT
      // await the old generation: it may be mid-update-batch (minutes), and
      // a late 409 (server still sees the dying connection) is survivable —
      // the loop backs off and retries instead of dying.
      stopping = true;
      pollAbort?.abort();
      // startPolling's sync setup (client/out/bridge) is done by the time this
      // line runs — only its long-poll loop is still pending.
      const loop = startPolling();
      // TUI dialog mirroring (Option A): patch the NEW runner's shared ctx.ui
      // object. Every runner swap (new session / reload) creates a fresh
      // wrapped object, so this re-runs each session_start; the marker makes a
      // repeat on the same object a no-op. Non-tui modes (rpc/print) have no
      // TUI dialogs to mirror.
      if (dialogs && ctx.mode === "tui" && ctx.hasUI) {
        try {
          installUiProxy(ctx.ui as unknown as Record<PropertyKey, unknown>, dialogs, (m) => ui(m, "warning"));
        } catch (err) {
          // installUiProxy is defensive and should never throw — this is the
          // final backstop: a hostile ctx.ui must not abort the rest of
          // session_start (pendingAction card, the poll loop await).
          ui(`pi-tg: dialog patch failed: ${String(err)}`, "warning");
        }
      }
      // Card + clear question AT arrival for /new and session switches (design
      // §8: "the NEW instance's session_start calls onSessionReplaced"). A
      // /reload posts nothing — the old instance's ✔️ stamp is the confirmation.
      const pa = cfg.pendingAction;
      if (pa && bridge) await bridge.onSessionReplaced(pa.chatId);
      await loop; // pollPromise lives for the loop's lifetime
    })().catch((err) => ui(`pi-tg: ${String(err)}`, "error"));
    void pollPromise;
  });

  pi.on("session_shutdown", () => {
    stopping = true;
    pollAbort?.abort(); // end the in-flight long poll at once (no 50 s wait)
    dialogs?.cancelAll(); // stamp + release any pending dialogs (their TUI twins die with the runner)
  });

  // ── mirror events ──

  pi.on("agent_start", () => {
    safeCall(() => currentMirror?.onAgentStart());
  });
  pi.on("agent_end", (event) => {
    safe(currentMirror?.onAgentEnd(event.messages as unknown as MirrorMessage[]));
  });
  pi.on("agent_settled", () => {
    // The stream is really over (no auto-retry/compaction/continuation will
    // run) — NOT where error ends persist: the retry's agent_start arrives
    // right after this and carries the log over; the mirror's grace timer
    // persists an error log only if no continuation arrives.
    safe(currentMirror?.onAgentSettled());
  });
  pi.on("message_start", (event) => {
    safeCall(() => currentMirror?.onAssistantStart(event.message as unknown as MirrorMessage));
  });
  pi.on("message_update", (event) => {
    safeCall(() => currentMirror?.onAssistantUpdate(event.message as unknown as MirrorMessage));
  });
  pi.on("message_end", (event) => {
    safe(currentMirror?.onAssistantEnd(event.message as unknown as MirrorMessage));
  });
  pi.on("tool_execution_start", (event) => {
    safeCall(() => currentMirror?.onToolStart(event.toolCallId, event.toolName, event.args));
  });
  pi.on("tool_execution_end", (event) => {
    safeCall(() => currentMirror?.onToolEnd(event.toolCallId, event.isError, event.result));
  });
  pi.on("ui_prompt_start", (event) => {
    // A mirrored dialog is the notification itself — the “⚠️ terminal prompt”
    // work-log line would be a redundant duplicate. TUI-only prompts (custom,
    // mirroring disabled, send failed) keep the line.
    const title = typeof event.title === "string" ? event.title : undefined;
    if (title && dialogs?.hasActive(title)) return;
    safeCall(() => currentMirror?.onUiPromptStart(event.title));
  });

  // ── stoppable manual compaction ──
  // pi runs ctx.compact()'s summarization with an internal abort controller
  // that is NOT exposed to extensions (checked 0.84.4: no abortCompaction,
  // no isCompacting on the context) — a Telegram Stop button could never
  // cancel it. So for TG-initiated /compact the bridge calls ctx.compact()
  // (which aborts any in-flight run and fires THIS hook) and replays pi's
  // default summarization here — with the bridge's own AbortController, so
  // the Stop button (session-bridge case "stop") cancels the in-flight LLM
  // call and the hook returns {cancel: true} ("Compaction cancelled").
  // Auto-compaction (threshold/overflow) and TUI /compact keep pi's default.
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "manual") {
      // AUTO-compaction (0.84.4: "threshold" | "overflow"; 0.85.0: "auto") →
      // pi's default path runs; we only CHOOSE THE LANE for the result
      // events: lane 2 = the live run's draft renders the status inside it
      // (the mirror), lane 1 = a standalone draft (the bridge). Muted /
      // unpaired → no messaging at all (lane undefined → the results no-op).
      if (cfg.level === "mute" || ownerChatId === undefined) return;
      autoCompactLane = currentMirror?.hasLiveDraft() ? "mirror" : "bridge";
      if (autoCompactLane === "mirror") safeCall(() => currentMirror?.onAutoCompactStart());
      else bridge?.autoCompactStart(ownerChatId);
      return;
    }
    autoCompactLane = undefined; // a manual compact owns its own result path (onDone)
    const handle = bridge?.manualCompact();
    if (!handle) return; // not TG-initiated (e.g. TUI /compact) → pi's default
    const model = ctx.model;
    if (!model) return; // no model → let pi's default report the failure
    return (async () => {
      if (handle.stopRequested || handle.controller.signal.aborted) return { cancel: true };
      try {
        const result = await runTgCompaction({
          preparation: {
            ...event.preparation,
            // src/compact.ts is pi-free (tests/boundary.test.ts) — convert the
            // session messages here with pi's own converter, and pass the
            // already-converted LLM messages in.
            messagesToSummarize: convertToLlm(event.preparation.messagesToSummarize),
            turnPrefixMessages: convertToLlm(event.preparation.turnPrefixMessages),
          },
          model,
          thinkingLevel: ctx.thinkingLevel,
          customInstructions: event.customInstructions,
          signal: handle.controller.signal,
          complete: (model, context, options) =>
            ctx.modelRegistry.complete(
              model as Parameters<typeof ctx.modelRegistry.complete>[0],
              context as Parameters<typeof ctx.modelRegistry.complete>[1],
              options as Parameters<typeof ctx.modelRegistry.complete>[2],
            ),
        });
        if ("aborted" in result) return { cancel: true };
        return { compaction: result.compaction };
      } catch (err) {
        if (handle.stopRequested || handle.controller.signal.aborted) return { cancel: true };
        throw err; // the runner catches it → pi's default compaction runs as a fallback
      }
    })();
  });

  // ── auto-compaction results (T6 lanes) ──
  // pi emits session_compact / session_compact_failed for EVERY compaction
  // (manual included). Manual results are already reported by the bridge's
  // compact onDone callback (ctx.compact) — only the AUTO lane chosen above
  // is handled here. The auto detail is `before → after tokens`: pi does
  // not pass the "after" number on the event, so it is re-derived from the
  // public API (estimatePostCompactTokens) — before-only when unavailable.
  pi.on("session_compact", (event) => {
    if (event.reason === "manual") return;
    const tokensBefore = event.compactionEntry?.tokensBefore;
    const detail = compactTokenDetail(tokensBefore, estimatePostCompactTokens(sessionCtx));
    if (autoCompactLane === "mirror") safeCall(() => currentMirror?.onAutoCompactDone(detail));
    else if (autoCompactLane === "bridge")
      // Await the bridge's stamp + persistent send BEFORE respawning the
      // live run's spinner — the persistent send clears every ephemeral
      // draft in the chat, so a spinner sent first would be wiped.
      void (async () => {
        try {
          if (bridge) await bridge.autoCompactFinish(true, detail);
          safeCall(() => currentMirror?.onLane1CompactDone());
        } catch (err) {
          ui(`pi-tg mirror error: ${String(err)}`, "error");
        }
      })();
    autoCompactLane = undefined;
  });

  pi.on("session_compact_failed", (event) => {
    if (event.reason === "manual") return;
    if (event.aborted && !event.errorMessage) {
      autoCompactLane = undefined; // teardown / cancel — nothing to report
      return;
    }
    const msg = event.errorMessage ?? "compaction failed";
    if (autoCompactLane === "mirror") {
      // C3: the live draft carries on (spinner / error line) — the failure
      // is a standalone notification. pi already prefixes errorMessage
      // ("Auto-compaction failed: …") — verbatim, plain text (no double ⚠️).
      safeCall(() => currentMirror?.onAutoCompactFailed());
      if (out && ownerChatId !== undefined) void out.send(ownerChatId, `⚠️ ${msg}`, { parseMode: null }).catch(() => {});
    } else if (autoCompactLane === "bridge") {
      void (async () => {
        try {
          if (bridge) await bridge.autoCompactFinish(false, msg);
          safeCall(() => currentMirror?.onLane1CompactDone());
        } catch (err) {
          ui(`pi-tg mirror error: ${String(err)}`, "error");
        }
      })();
    }
    autoCompactLane = undefined;
  });
}
