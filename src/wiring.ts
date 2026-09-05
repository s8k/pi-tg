import type { Out, TelegaPi, PiContextUsage, PiSessionInfo } from "./session-bridge.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import type { TelegaState } from "./state.ts";

// ── Local structural mirrors of pi 0.84.4 (keeps wiring.ts pi-free & testable) ──

export interface PiLike {
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setModel(model: PiModel): Promise<boolean>;
  setThinkingLevel(level: PiThinkingLevel): void;
}

export interface CtxLike {
  cwd: string;
  mode: string;
  hasUI: boolean;
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
  compact(options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model: PiModel | undefined;
  thinkingLevel?: string;
  scopedModels: readonly { model: PiModel; thinkingLevel?: string }[];
  modelRegistry: { getAvailable(): PiModel[] };
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    getBranch(): { type: string }[];
  };
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  // command-context-only (absent on the plain session context):
  waitForIdle?(): Promise<void>;
  newSession?(): Promise<{ cancelled: boolean }>;
  switchSession?(sessionPath: string): Promise<{ cancelled: boolean }>;
  /** Runs pi's /reload flow; on resolve the old runtime is already replaced. */
  reload?(): Promise<void>;
}

export interface ClientLike {
  sendMessage(chatId: number, text: string, opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown; disableNotification?: boolean }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }): Promise<boolean>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendRichMessage(chatId: number, rich: { markdown?: string }, opts?: { replyToId?: number; disableNotification?: boolean }): Promise<{ message_id: number }>;
  sendRichMessageDraft(chatId: number, draftId: number, rich: { markdown?: string }, canStop?: boolean, keepOnStop?: boolean): Promise<boolean>;
}

// ── Out adapter: client + state tracking + persist ──

export function makeOut(client: ClientLike, state: TelegaState, persist: () => Promise<void>): Out {
  return {
    async send(chatId, text, opts) {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      const sent = await client.sendMessage(chatId, text, { parseMode, replyToId: opts?.replyToId, replyMarkup: opts?.replyMarkup, disableNotification: opts?.disableNotification });
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    async sendRich(chatId, md, opts) {
      const sent = await client.sendRichMessage(chatId, { markdown: md }, opts);
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    sendDraft: (chatId, draftId, md, canStop, keepOnStop) =>
      client.sendRichMessageDraft(chatId, draftId, { markdown: md }, canStop, keepOnStop),
    edit: (chatId, messageId, text, opts) => {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      return client.editMessageText(chatId, messageId, text, { parseMode, replyMarkup: opts?.replyMarkup });
    },
    delete: (chatId, messageId) => client.deleteMessage(chatId, messageId),
  };
}

// ── TelegaPi adapter: pi + latest contexts → the bridge’s structural interface ──

/**
 * Wrap `pi.waitForIdle` so it additionally waits for the mirror to finish
 * the run's finalization (all persistent sends delivered). pi's extension
 * runner does not await the mirror's fire-and-forget handlers, so the bare
 * wait resolves before e.g. the aborted run's "⚠️ error: Request was
 * aborted" message has reached Telegram — the bridge's compact/stop flows
 * rely on the wrapped wait to keep their sends ordered after it.
 */
export function wrapWaitForIdle(pi: { waitForIdle(): Promise<void> }, whenSettled: () => Promise<void>): void {
  const base = pi.waitForIdle.bind(pi);
  pi.waitForIdle = async () => {
    await base();
    await whenSettled();
  };
}

export interface TelegaPiDeps {
  pi: PiLike;
  getCmdCtx(): CtxLike | undefined;
  getSessionCtx(): CtxLike | undefined;
  listSessions(cwd: string): Promise<PiSessionInfo[]>;
}

/**
 * Liveness probe for a captured pi ctx. After a session replacement or
 * reload, pi invalidates the session's ExtensionRunner and EVERY access to a
 * captured ctx (even a bare property read) throws, so one cheap read
 * reliably distinguishes live from stale.
 */
export function ctxIsAlive(c: { cwd: string } | undefined): c is { cwd: string } {
  if (!c) return false;
  try {
    void c.cwd;
  } catch {
    return false;
  }
  return true;
}

export function makeTelegaPi(deps: TelegaPiDeps): TelegaPi {
  // Prefer the command ctx (it adds waitForIdle/newSession/switchSession), but
  // skip any stale one — after /new or /sessions-switch the old command ctx is
  // invalidated while a fresh sessionCtx arrives via the new session_start.
  const ctx = (): CtxLike | undefined => {
    const cmd = deps.getCmdCtx();
    if (ctxIsAlive(cmd)) return cmd;
    const sess = deps.getSessionCtx();
    if (ctxIsAlive(sess)) return sess;
    return undefined;
  };
  const requireCtx = (): CtxLike => ctx() ?? (() => { throw new Error("no active pi context"); })();
  return {
    get cwd() {
      return ctx()?.cwd ?? "";
    },
    isIdle: () => ctx()?.isIdle() ?? true,
    abort: () => requireCtx().abort(),
    sendPrompt(text, deliverAs) {
      deps.pi.sendUserMessage(
        text,
        deliverAs === "steer"
          ? { deliverAs: "steer", expandPromptTemplates: true }
          : { expandPromptTemplates: true }
      );
    },
    newSession() {
      const c = requireCtx();
      if (!c.newSession) throw new Error("no active pi context");
      void c.newSession().catch(() => {});
    },
    switchSession(path) {
      const c = requireCtx();
      if (!c.switchSession) throw new Error("no active pi context");
      void c.switchSession(path).catch(() => {});
    },
    waitForIdle: async () => {
      const c = requireCtx();
      if (!c.waitForIdle) throw new Error("no active pi context");
      await c.waitForIdle();
    },
    compact(onDone) {
      requireCtx().compact({
        onComplete: (r) => {
          // Short "before → after tokens" note — NEVER the full summary (it
          // exceeds Telegram's 4096-char limit and the completion message
          // would be dropped).
          const res = r as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
          const detail =
            typeof res?.tokensBefore === "number" && typeof res?.estimatedTokensAfter === "number"
              ? `${res.tokensBefore.toLocaleString("en-US")} → ${res.estimatedTokensAfter.toLocaleString("en-US")} tokens`
              : undefined;
          onDone(true, detail);
        },
        onError: (e) => onDone(false, e.message),
      });
    },
    reload(onDone) {
      const c = requireCtx();
      if (!c.reload) throw new Error("no active pi context");
      // Terminal: after pi replaces the runtime, this closure still runs in the
      // pre-reload version — report the outcome, never persist from here.
      void c.reload().then(
        () => onDone(true),
        (e) => onDone(false, e instanceof Error ? e.message : String(e))
      );
    },
    getSessionName: () => deps.pi.getSessionName(),
    setSessionName: (name) => deps.pi.setSessionName(name),
    currentModel: () => ctx()?.model,
    currentThinking: () => ctx()?.thinkingLevel as PiThinkingLevel | undefined,
    scopedModels: () => (ctx()?.scopedModels ?? []).map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel as PiThinkingLevel | undefined })),
    allModels: () => ctx()?.modelRegistry.getAvailable() ?? [],
    async setModel(id) {
      const scoped = (ctx()?.scopedModels ?? []).map((s) => s.model);
      const model = scoped.find((m) => m.id === id) ?? (ctx()?.modelRegistry.getAvailable() ?? []).find((m) => m.id === id);
      if (!model) return false;
      return deps.pi.setModel(model);
    },
    setThinkingLevel(level) {
      deps.pi.setThinkingLevel(level);
    },
    contextUsage: (): PiContextUsage | undefined => {
      const u = ctx()?.getContextUsage();
      if (!u) return undefined;
      return { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent };
    },
    messageCount: () => (ctx()?.sessionManager.getBranch() ?? []).filter((e) => e.type === "message").length,
    listSessions: () => deps.listSessions(ctx()?.cwd ?? ""),
    currentSessionPath: () => ctx()?.sessionManager.getSessionFile() ?? "",
    notifyUi(text, level) {
      ctx()?.ui.notify(text, level ?? "info");
    },
    shutdown: () => requireCtx().shutdown(),
  };
}
