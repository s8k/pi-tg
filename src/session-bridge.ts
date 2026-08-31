import type { TgAction } from "./router.ts";
import { CB } from "./router.ts";
import type { TelegaConfig } from "./config.ts";
import type { TelegaState, SessionListItem } from "./state.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import { supportedThinkingLevels } from "./thinking.ts";
import { pairWelcome, notAuthorizedText } from "./onboarding.ts";
import { escapeHtml } from "./markdown.ts";

export interface PiModelInfo {
  model: PiModel;
  thinkingLevel?: PiThinkingLevel;
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: number; // epoch ms (converted from pi’s Date by the adapter)
  modified: number; // epoch ms
  messageCount: number;
  firstMessage: string;
}

/** Structural view of the pi extension context — implemented by index.ts only. */
export interface TelegaPi {
  cwd: string;
  isIdle(): boolean;
  abort(): void;
  sendPrompt(text: string, deliverAs: "now" | "steer"): void;
  newSession(): void; // triggers instance replacement
  switchSession(path: string): void; // triggers instance replacement
  waitForIdle(): Promise<void>;
  compact(onDone: (ok: boolean, detail?: string) => void): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
  currentModel(): PiModel | undefined;
  currentThinking(): PiThinkingLevel | undefined;
  scopedModels(): PiModelInfo[]; // [] = unscoped
  allModels(): PiModel[];
  setModel(modelId: string): Promise<boolean>; // pi.setModel is async and takes a Model object
  setThinkingLevel(level: PiThinkingLevel): void;
  contextUsage(): PiContextUsage | undefined;
  messageCount(): number;
  listSessions(): Promise<PiSessionInfo[]>;
  currentSessionPath(): string;
  notifyUi(text: string, level?: "info" | "warning" | "error"): void;
  shutdown(): void;
}

/** Telegram send primitives (implemented by index.ts over TelegramClient). */
export interface Out {
  send(
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown }
  ): Promise<number | undefined>;
  edit(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }
  ): Promise<boolean>; // false = text unchanged (not an error)
  delete(chatId: number, messageId: number): Promise<void>; // idempotent
}

export interface BridgeDeps {
  pi: TelegaPi;
  out: Out;
  state: TelegaState;
  cfg: TelegaConfig;
  botUsername: string | undefined;
  persist: () => Promise<void>; // save cfg (offset/sentIds/pendingAction/ownerId)
  sleep: (ms: number) => Promise<void>;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function helpText(): string {
  return [
    "<b>pi-telega</b> — drive this pi session from Telegram",
    "Plain text → prompt (busy → ⚡ queued steer)",
    "<b>/new</b> — start a new session",
    "<b>/sessions</b> — list &amp; switch sessions",
    "<b>/models</b> — pick a model",
    "<b>/thinking</b> — pick the thinking level",
    "<b>/status</b> — session info",
    "<b>/stop</b> — Esc (abort the current turn)",
    "<b>/mute</b> — stop agent output (commands still work)",
    "<b>/unmute</b> — resume agent output",
    "<b>/compact</b> — compact the history",
    "<b>/name &lt;text&gt;</b> — rename this session",
    "<b>/kill</b> — shut down pi",
    "<b>/help</b> — this text",
  ].join("\n");
}

export class SessionBridge {
  private deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** Top-level entry: never throws; failures become a ⚠ message + TUI notice. */
  async dispatch(action: TgAction): Promise<void> {
    if (action.kind === "ignore") return;
    try {
      await this.handle(action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.pi.notifyUi(`telega: ${msg}`, "error");
      const chatId = "chatId" in action ? (action as { chatId: number }).chatId : undefined;
      if (chatId !== undefined) {
        try {
          await this.deps.out.send(chatId, `⚠️ ${escapeHtml(msg)}`);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Called by the REPLACEMENT instance on session_start (design §8). */
  async onSessionReplaced(chatId: number): Promise<void> {
    const { cfg, out } = this.deps;
    const pa = cfg.pendingAction;
    if (!pa) return;
    cfg.pendingAction = undefined;
    await this.deps.persist();
    if (pa.chatId !== chatId) return;
    await out.send(chatId, this.sessionCardText());
    if (cfg.askClearOnSwitch) {
      await out.send(chatId, "Clear chat history?", {
        replyMarkup: {
          inline_keyboard: [[{ text: "🧹 Clear", callback_data: CB.clear(true) }, { text: "Keep", callback_data: CB.clear(false) }]],
        },
      });
    }
  }

  private sessionCardText(): string {
    const { pi } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    return [
      `📌 <b>${escapeHtml(name)}</b>`,
      `<code>${escapeHtml(pi.cwd)}</code>`,
      `${model ? escapeHtml(model.name) : "no model"} · thinking: ${pi.currentThinking() ?? "default"}`,
      `${pi.messageCount()} messages${usage?.percent != null ? ` · context ${usage.percent}%` : ""}`,
    ].join("\n");
  }

  private statusText(): string {
    const { pi, cfg } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    return [
      `📊 <b>${escapeHtml(name)}</b> — ${pi.isIdle() ? "idle" : "busy"}${cfg.muted ? " · 🔇 muted" : ""}`, 
      `<code>${escapeHtml(pi.cwd)}</code>`,
      `model: ${model ? escapeHtml(model.name) : "n/a"} · thinking: ${pi.currentThinking() ?? "default"}`,
      `context: ${usage?.percent != null ? `${usage.percent}%` : "n/a"}${usage?.tokens != null ? ` (${usage.tokens}/${usage.contextWindow})` : ""}`,
      `messages: ${pi.messageCount()}`,
    ].join("\n");
  }

  private async sendCardAndHelp(chatId: number): Promise<void> {
    await this.deps.out.send(chatId, this.sessionCardText());
    await this.deps.out.send(chatId, helpText());
  }

  private async handle(action: TgAction): Promise<void> {
    const { out, pi, cfg } = this.deps;
    switch (action.kind) {
      case "notAuthorized":
        await out.send(action.chatId, notAuthorizedText(cfg.ownerId !== undefined));
        return;
      case "pair":
        cfg.ownerId = action.fromId;
        await this.deps.persist();
        await out.send(action.chatId, pairWelcome(this.deps.botUsername, action.fromId));
        await this.sendCardAndHelp(action.chatId);
        return;
      case "start":
        await this.sendCardAndHelp(action.chatId);
        return;
      case "help":
        await out.send(action.chatId, helpText());
        return;
      case "unknown":
        await out.send(action.chatId, `Unknown command ${escapeHtml(action.text)} — see /help`);
        return;
      case "prompt": {
        const busy = !pi.isIdle();
        pi.sendPrompt(action.text, busy ? "steer" : "now");
        if (busy) await out.send(action.chatId, "⚡ queued (applies after current tool step)");
        return;
      }
      case "status":
        await out.send(action.chatId, this.statusText());
        return;
      case "stop":
        if (pi.isIdle()) await out.send(action.chatId, "Nothing to stop — session is idle.");
        else {
          pi.abort();
          await out.send(action.chatId, "⏹ Stopping…");
        }
        return;
      case "mute":
        cfg.muted = true;
        await this.deps.persist();
        await out.send(action.chatId, "🔇 Muted — I won’t post agent output (progress, tools, answers) until you send /unmute. Commands still work.");
        return;
      case "unmute":
        cfg.muted = false;
        await this.deps.persist();
        await out.send(action.chatId, "🔊 Unmuted — agent output is back on.");
        return;
      case "compact":
        await out.send(action.chatId, "🗜 Compacting history… (may take a moment)");
        pi.compact((ok, detail) => {
          // fire-and-forget result: a failed send must not become an unhandled rejection
          void out.send(
            action.chatId,
            ok ? `✓ Compacted${detail ? ` — ${detail}` : "."}` : `⚠️ Compact failed${detail ? `: ${detail}` : "."}`
          ).catch(() => { /* best effort — compact itself already ran */ });
        });
        return;
      case "new":
        cfg.pendingAction = { type: "new", chatId: action.chatId };
        await this.deps.persist();
        await out.send(action.chatId, "🔄 Creating new session…");
        pi.newSession();
        return;
      case "sessions":
        await this.handleSessions(action.chatId);
        return;
      case "sessionActivate":
        await this.handleSessionActivate(action);
        return;
      case "switchOk":
        await this.handleSwitchOk(action);
        return;
      case "modelList":
        await this.handleModelList(action.chatId);
        return;
      case "modelSet":
        await this.handleModelSet(action);
        return;
      case "thinkingList":
        await this.handleThinkingList(action.chatId);
        return;
      case "thinkingSet":
        await this.handleThinkingSet(action);
        return;
      case "nameSet":
        if (!action.name) {
          await out.send(action.chatId, "Usage: /name <text>");
          return;
        }
        pi.setSessionName(action.name);
        await out.send(action.chatId, `📌 Renamed to <b>${escapeHtml(action.name)}</b>.`);
        return;
      case "killAsk":
        await out.send(action.chatId, "⚠️ This terminates the pi process — the bot goes silent until pi restarts. Sure?", {
          replyMarkup: {
            inline_keyboard: [[{ text: "☠ Yes, kill", callback_data: CB.kill(true) }, { text: "No", callback_data: CB.kill(false) }]],
          },
        });
        return;
      case "kill":
        if (!action.yes) {
          await out.send(action.chatId, "OK — pi keeps running.");
          return;
        }
        await out.send(action.chatId, "👋 Shutting down pi… (bot goes silent)");
        pi.shutdown();
        return;
      case "clear":
        await this.handleClear(action);
        return;
    }
  }

  private async handleSessions(chatId: number): Promise<void> {
    const { out, pi, cfg, state } = this.deps;
    const infos = await pi.listSessions();
    const sorted = [...infos].sort((a, b) => b.modified - a.modified).slice(0, cfg.maxSessionList);
    const items: SessionListItem[] = sorted.map((s) => ({
      path: s.path,
      id: s.id,
      name: s.name,
      firstMessage: s.firstMessage,
      modified: s.modified,
      messageCount: s.messageCount,
    }));
    state.setSessionList(items);
    if (items.length === 0) {
      await out.send(chatId, "No sessions for this project yet.");
      return;
    }
    const current = pi.currentSessionPath();
    const keyboard = items.map((it, i) => {
      const raw = it.name ?? (it.firstMessage ? it.firstMessage.slice(0, 40) : it.id.slice(0, 8));
      const star = it.path === current ? "★ " : "";
      return [{ text: `${star}${escapeHtml(raw)} — ${it.messageCount} msgs, ${timeAgo(it.modified)}`, callback_data: CB.session(i) }];
    });
    await out.send(chatId, `Sessions for this project (newest first) — tap to switch:`, {
      replyMarkup: { inline_keyboard: keyboard },
    });
  }

  private async handleSessionActivate(action: Extract<TgAction, { kind: "sessionActivate" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const item = state.sessionAt(action.index);
    if (!item) {
      await out.send(action.chatId, "⚠️ List expired — send /sessions again.");
      return;
    }
    if (item.path === pi.currentSessionPath()) {
      await out.send(action.chatId, "Already active.");
      return;
    }
    if (pi.isIdle()) {
      await this.doSwitch(action.chatId, item.path);
      return;
    }
    await out.send(action.chatId, "Agent is running — switch when the current turn ends?", {
      replyMarkup: {
        inline_keyboard: [[{ text: "⏳ OK", callback_data: CB.sessionOk(action.index) }, { text: "Cancel", callback_data: "xc" }]],
      },
    });
  }

  private async handleSwitchOk(action: Extract<TgAction, { kind: "switchOk" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const item = state.sessionAt(action.index);
    if (!item) {
      await out.send(action.chatId, "⚠️ List expired — send /sessions again.");
      return;
    }
    await out.send(action.chatId, "⏳ Waiting for the current turn to end…");
    await pi.waitForIdle();
    await this.doSwitch(action.chatId, item.path);
  }

  private async doSwitch(chatId: number, path: string): Promise<void> {
    const { cfg, out, pi } = this.deps;
    cfg.pendingAction = { type: "activate", chatId, path };
    await this.deps.persist();
    await out.send(chatId, "🔄 Switching session…");
    pi.switchSession(path); // instance replacement; onSessionReplaced posts card + clear question
  }

  private async handleModelList(chatId: number): Promise<void> {
    const { out, pi, state } = this.deps;
    const scoped = pi.scopedModels();
    const models = scoped.length > 0 ? scoped.map((s) => s.model) : pi.allModels();
    if (models.length === 0) {
      await out.send(chatId, "No models available.");
      return;
    }
    state.setModelList(models.map((m) => m.id));
    const current = pi.currentModel()?.id;
    const keyboard = models.map((m, i) => [{ text: `${m.id === current ? "★ " : ""}${escapeHtml(m.name)}`, callback_data: CB.model(i) }]);
    await out.send(chatId, "Model:", { replyMarkup: { inline_keyboard: keyboard } });
  }

  private async handleModelSet(action: Extract<TgAction, { kind: "modelSet" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const id = state.modelAt(action.index);
    if (!id) {
      await out.send(action.chatId, "⚠️ List expired — send /models again.");
      return;
    }
    if (!(await pi.setModel(id))) {
      await out.send(action.chatId, `⚠️ Unknown model: ${escapeHtml(id)}`);
      return;
    }
    const now = pi.currentModel();
    await out.send(action.chatId, `✓ Model set to ${escapeHtml(now?.name ?? id)}.`);
  }

  private async handleThinkingList(chatId: number): Promise<void> {
    const { out, pi, state } = this.deps;
    const model = pi.currentModel();
    if (!model) {
      await out.send(chatId, "No model selected.");
      return;
    }
    const levels = supportedThinkingLevels(model);
    state.setThinkingList(levels);
    const current = pi.currentThinking();
    const keyboard = levels.map((l, i) => [{ text: `${l === current ? "★ " : ""}${l}`, callback_data: CB.thinking(i) }]);
    await out.send(chatId, `Thinking level for ${escapeHtml(model.name)}:`, { replyMarkup: { inline_keyboard: keyboard } });
  }

  private async handleThinkingSet(action: Extract<TgAction, { kind: "thinkingSet" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const level = state.thinkingAt(action.index);
    if (!level) {
      await out.send(action.chatId, "⚠️ List expired — send /thinking again.");
      return;
    }
    pi.setThinkingLevel(level);
    await out.send(action.chatId, `✓ Thinking: ${level}.`);
  }

  private async handleClear(action: Extract<TgAction, { kind: "clear" }>): Promise<void> {
    const { out, state, sleep } = this.deps;
    if (!action.doIt) {
      await out.send(action.chatId, "OK — chat history kept.");
      return;
    }
    const ids = state.drainSent();
    if (ids.length === 0) {
      await out.send(action.chatId, "Nothing to clear.");
      return;
    }
    await out.send(action.chatId, `🧹 Clearing ${ids.length} messages…`);
    let cleared = 0;
    for (const id of ids) {
      try {
        await out.delete(action.chatId, id);
        cleared++;
      } catch {
        /* already gone */
      }
      await sleep(50); // stay under Telegram rate limits
    }
    await out.send(action.chatId, `✓ Cleared ${cleared}/${ids.length} bot messages. Your own messages stay — Telegram doesn't let a bot delete them.`);
  }
}
