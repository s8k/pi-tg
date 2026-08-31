import { join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, getBotToken } from "./src/config.ts";
import { TelegramClient, pollLoop } from "./src/telegram-client.ts";
import type { TgUpdate } from "./src/telegram-client.ts";
import { route } from "./src/router.ts";
import { encodeInternal, parseInternal } from "./src/command-args.ts";
import { TelegaState } from "./src/state.ts";
import { SessionBridge } from "./src/session-bridge.ts";
import type { Out, TelegaPi } from "./src/session-bridge.ts";
import { Mirror } from "./src/mirror.ts";
import type { MirrorMessage } from "./src/mirror.ts";
import { renderQr, qrWidgetFactory, tokenLooksValid, notAuthorizedText } from "./src/onboarding.ts";
import { makeOut, makeTelegaPi, ctxIsAlive } from "./src/wiring.ts";

const CFG = { path: join(getAgentDir(), "pi-telega.json") };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  let pollPromise: Promise<void> | undefined;
  let currentMirror: Mirror | undefined;

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
  // become an unhandled rejection (Node ≥15 default = crash the pi process)
  const safe = (p: Promise<unknown> | undefined): void => {
    void p?.catch((err) => ui(`pi-telega mirror error: ${String(err)}`, "error"));
  };

  async function startPolling(): Promise<void> {
    const gen = ++pollGen;
    stopping = false;
    if (!state) return;
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
    };
    bridge = new SessionBridge(deps);
    if (!token) {
      ui("pi-telega: no bot token — run /tg config <token>", "warning");
      return;
    }
    let username: string | undefined;
    try {
      username = (await client.getMe()).username;
    } catch (err) {
      ui(`pi-telega: getMe failed: ${String(err)}`, "error");
      return;
    }
    deps.botUsername = username;
    const mirror = new Mirror({ out: outAdapter, state, cfg, getChatId: () => ownerChatId, now: () => Date.now() });
    currentMirror = mirror;
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
      shouldStop: () => stopping || gen !== pollGen,
      sleep,
    });
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
      ctx.ui.notify("pi-telega: no token yet — run /tg config <token>", "warning");
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

  // ── terminal command ──

  pi.registerCommand("tg", {
    description: "Drive pi from Telegram — /tg (card) | /tg config <token> | /tg pair | /tg internal …",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "";
      if (sub === "internal") {
        const action = parseInternal(args.trim());
        if (action && bridge) await bridge.dispatch(action);
        else ctx.ui.notify("pi-telega: bad /tg internal payload", "error");
        return;
      }
      if (sub === "") {
        showCard(ctx);
        return;
      }
      if (sub === "config") {
        const token = parts.slice(1).join(" ").trim();
        if (!tokenLooksValid(token)) {
          ctx.ui.notify("pi-telega: invalid token (expected <digits>:<alnum/ -_>, e.g. 123456:AAH…)", "error");
          return;
        }
        cfg.botToken = token;
        await persist();
        const old = pollPromise;
        stopping = true;
        if (old) await old.catch(() => {});
        // A session replacement can happen while we were waiting above — in that
        // case this handler's ctx is stale and must not be used any more.
        if (!ctxIsAlive(ctx)) return;
        pollPromise = startPolling().catch((err) => ui(`pi-telega: ${String(err)}`, "error"));
        void pollPromise;
        ctx.ui.notify("pi-telega: token saved, poller restarted. Run /tg pair to show the QR.", "info");
        return;
      }
      if (sub === "pair") {
        if (cfg.ownerId) {
          ctx.ui.notify(`pi-telega: already paired with owner ${cfg.ownerId}. Delete ${CFG.path} to re-pair.`, "info");
          return;
        }
        await showQr(ctx);
        return;
      }
      ctx.ui.notify("Usage: /tg | /tg config <token> | /tg pair", "info");
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
    cfg = loadConfig(CFG);
    state = new TelegaState(cfg.lastOffset ?? 0);
    state.restoreSentIds(cfg.sentMessageIds ?? []);
    // A failure here (e.g. in onSessionReplaced) must surface as a TUI notice,
    // never as an unhandled rejection that kills the pi process.
    pollPromise = (async () => {
      await startPolling();
      const pa = cfg.pendingAction;
      if (pa && bridge) await bridge.onSessionReplaced(pa.chatId);
    })().catch((err) => ui(`pi-telega: ${String(err)}`, "error"));
    void pollPromise;
  });

  pi.on("session_shutdown", () => {
    stopping = true;
  });

  // ── mirror events ──

  pi.on("agent_start", () => {
    safe(currentMirror?.onAgentStart());
  });
  pi.on("agent_end", (event) => {
    safe(currentMirror?.onAgentEnd(event.messages as unknown as MirrorMessage[]));
  });
  pi.on("message_start", (event) => {
    safe(currentMirror?.onAssistantStart(event.message as unknown as MirrorMessage));
  });
  pi.on("message_update", (event) => {
    safe(currentMirror?.onAssistantUpdate(event.message as unknown as MirrorMessage));
  });
  pi.on("message_end", (event) => {
    safe(currentMirror?.onAssistantEnd(event.message as unknown as MirrorMessage));
  });
  pi.on("tool_execution_start", (event) => {
    safe(currentMirror?.onToolStart(event.toolCallId, event.toolName, event.args));
  });
  pi.on("tool_execution_end", (event) => {
    safe(currentMirror?.onToolEnd(event.toolCallId, event.isError));
  });
  pi.on("ui_prompt_start", (event) => {
    safe(currentMirror?.onUiPromptStart(event.title));
  });
}
