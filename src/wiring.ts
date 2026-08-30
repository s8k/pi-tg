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
}

export interface ClientLike {
  sendMessage(chatId: number, text: string, opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }): Promise<boolean>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

// ── Out adapter: client + state tracking + persist ──

export function makeOut(client: ClientLike, state: TelegaState, persist: () => Promise<void>): Out {
  return {
    async send(chatId, text, opts) {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      const sent = await client.sendMessage(chatId, text, { parseMode, replyToId: opts?.replyToId, replyMarkup: opts?.replyMarkup });
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    edit: (chatId, messageId, text, opts) => {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      return client.editMessageText(chatId, messageId, text, { parseMode, replyMarkup: opts?.replyMarkup });
    },
    delete: (chatId, messageId) => client.deleteMessage(chatId, messageId),
  };
}

// ── TelegaPi adapter: pi + latest contexts → the bridge’s structural interface ──

export interface TelegaPiDeps {
  pi: PiLike;
  getCmdCtx(): CtxLike | undefined;
  getSessionCtx(): CtxLike | undefined;
  listSessions(cwd: string): Promise<PiSessionInfo[]>;
}

export function makeTelegaPi(deps: TelegaPiDeps): TelegaPi {
  const ctx = (): CtxLike | undefined => deps.getCmdCtx() ?? deps.getSessionCtx();
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
          const s = (r as { summary?: string } | undefined)?.summary;
          onDone(true, s ?? "compacted");
        },
        onError: (e) => onDone(false, e.message),
      });
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
