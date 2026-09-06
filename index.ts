import { join } from "node:path";
import { SessionManager, getAgentDir, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, getBotToken } from "./src/config.ts";
import { TelegramClient, pollLoop } from "./src/telegram-client.ts";
import type { TgUpdate } from "./src/telegram-client.ts";
import { route } from "./src/router.ts";
import { encodeInternal, parseInternal } from "./src/command-args.ts";
import { TelegaState } from "./src/state.ts";
import { SessionBridge } from "./src/session-bridge.ts";
import { probeGpu } from "./src/gpu.ts";
import type { Out, TelegaPi } from "./src/session-bridge.ts";
import { Mirror, compactTokenDetail } from "./src/mirror.ts";
import type { MirrorMessage } from "./src/mirror.ts";
import { renderQr, qrWidgetFactory, tokenLooksValid, notAuthorizedText } from "./src/onboarding.ts";
import { makeOut, makeTelegaPi, ctxIsAlive, wrapWaitForIdle } from "./src/wiring.ts";
import { runTgCompaction } from "./src/compact.ts";

const CFG = { path: join(getAgentDir(), "pi-telega.json") };
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

export default function piTelega(pi: ExtensionAPI): void {
  let cfg = loadConfig(CFG);
  let state: TelegaState | undefined;
  let bridge: SessionBridge | undefined;
  let client: TelegramClient | undefined;
  let out: Out | undefined;
  let piAdapter: TelegaPi | undefined;
  let ownerChatId: number | undefined;
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
  // T6 auto-compact lane, chosen at session_before_compact (auto): where the
  // result events land — the live run's draft (mirror) or the bridge's
  // standalone draft (bridge). Undefined = nothing to report (muted /
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
    void p?.catch((err) => ui(`pi-telega mirror error: ${String(err)}`, "error"));
  };
  const safeCall = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      ui(`pi-telega mirror error: ${String(err)}`, "error");
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
    piAdapter = makeTelegaPi({
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
      // T6 early draft: the run's draft (spinner) goes out when the prompt is
      // dispatched, before pi's agent_start.
      onPromptAccepted: () => safeCall(() => currentMirror?.onPromptAccepted()),
    };
    bridge = new SessionBridge(deps);
    if (!token) {
      ui("pi-telega: no bot token — run /tg:config <bot_token>", "warning");
      return gen;
    }
    let username: string | undefined;
    try {
      username = (await client.getMe()).username;
    } catch (err) {
      ui(`pi-telega: getMe failed: ${String(err)}`, "error");
      return gen;
    }
    deps.botUsername = username;
    // Set the bot menu (self-healing: runs on every poller start). Best-effort:
    // a failure logs a TUI warning and must never block or stop polling.
    void client.setMyCommands().catch((err) => ui(`pi-telega: setMyCommands failed: ${String(err)}`, "warning"));
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
        void persist();
      },
      onUpdates: async (updates: TgUpdate[]) => {
        for (const u of updates) await handleUpdate(u);
      },
      onError: (err) => ui(`pi-telega poll error: ${String(err)}`, "error"),
      onConflict: () => ui("pi-telega: another client is polling this bot token (409 Conflict) — backing off and retrying", "warning"),
      shouldStop: () => stopping || gen !== pollGen,
      sleep,
      signal: aborter.signal,
    });
    return gen;
  }

  async function handleUpdate(update: TgUpdate): Promise<void> {
    if (!bridge || !out || !state) return;
    const action = route(update, cfg.ownerId);
    if (action.kind === "ignore") return;
    const msg = update.message;
    if (msg && msg.from && cfg.ownerId !== undefined && msg.from.id === cfg.ownerId) {
      ownerChatId = msg.chat.id;
    }
    if (action.kind === "notAuthorized") {
      await out.send(action.chatId, notAuthorizedText(false), { parseMode: null });
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

  function cardLines(): string[] {
    const p = piAdapter;
    if (!p) return ["pi-telega: not ready yet"];
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
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-telega", lines);
    else ctx.ui.notify(lines.join("\n"), "info");
  }

  async function showQr(ctx: ExtensionCommandContext): Promise<void> {
    const token = getBotToken(cfg, CFG);
    if (!token) {
      ctx.ui.notify("pi-telega: no token yet — run /tg:config <bot_token>", "warning");
      return;
    }
    const c = client ?? new TelegramClient(token, {});
    try {
      const me = await c.getMe();
      if (!ctxIsAlive(ctx)) return; // session replaced mid-flight → ctx is stale
      const qr = renderQr(`https://t.me/${me.username}`);
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-telega-qr", qrWidgetFactory(qr)); // factory form: array form is capped at 10 lines
      else ctx.ui.notify(`open https://t.me/${me.username} in Telegram`, "info");
    } catch (err) {
      ui(`pi-telega: getMe failed: ${String(err)}`, "error");
    }
  }

  // ── terminal commands ──

  const TG_USAGE = "Usage: /tg | /tg:config <bot_token> | /tg:pair | /tg:unpair";

  async function runConfig(token: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!tokenLooksValid(token)) {
      ctx.ui.notify("pi-telega: invalid token (expected <digits>:<alnum/ -_>, e.g. 123456:AAH…)", "error");
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
    pollPromise = startPolling().catch((err) => ui(`pi-telega: ${String(err)}`, "error"));
    void pollPromise;
    ctx.ui.notify("pi-telega: token saved, poller restarted. Run /tg:pair to show the QR.", "info");
  }

  async function runPair(ctx: ExtensionCommandContext): Promise<void> {
    if (cfg.ownerId) {
      ctx.ui.notify(`pi-telega: already paired with owner ${cfg.ownerId}. Run /tg:unpair to unpair.`, "info");
      return;
    }
    await showQr(ctx);
  }

  async function runUnpair(ctx: ExtensionCommandContext): Promise<void> {
    if (!cfg.ownerId) {
      ctx.ui.notify("pi-telega: not paired — nothing to unpair.", "info");
      return;
    }
    cfg.ownerId = undefined;
    ownerChatId = undefined; // Mirror must stop posting to the stale chat
    await persist();
    if (!ctxIsAlive(ctx)) return; // session replaced while persisting
    ctx.ui.notify("pi-telega: unpaired. Bot is silent until a new account presses /start (/tg:pair shows the QR).", "info");
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
        else ctx.ui.notify("pi-telega: bad /tg internal payload", "error");
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
    state = new TelegaState(cfg.lastOffset ?? 0);
    state.restoreSentIds(cfg.sentMessageIds ?? []);
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
      // Card + clear question AT arrival (design §8: "the NEW instance's
      // session_start calls onSessionReplaced").
      const pa = cfg.pendingAction;
      if (pa && bridge) await bridge.onSessionReplaced(pa.chatId);
      await loop; // pollPromise lives for the loop's lifetime
    })().catch((err) => ui(`pi-telega: ${String(err)}`, "error"));
    void pollPromise;
  });

  pi.on("session_shutdown", () => {
    stopping = true;
    pollAbort?.abort(); // end the in-flight long poll at once (no 50 s wait)
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
      if (cfg.muted || ownerChatId === undefined) return;
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
    else if (autoCompactLane === "bridge") bridge?.autoCompactFinish(true, detail);
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
      bridge?.autoCompactFinish(false, msg);
    }
    autoCompactLane = undefined;
  });
}
