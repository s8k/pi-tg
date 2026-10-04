import type { Out, TelegramPi, PiContextUsage, PiSessionInfo } from "./session-bridge.ts";
import { compactTokenDetail } from "./mirror.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import type { TelegramState } from "./state.ts";
import type { TgBlock } from "./rich-blocks.ts";

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
    getBranch(): { type: string; message?: unknown }[];
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
  sendRichMessage(chatId: number, rich: { blocks: TgBlock[] }, opts?: { replyToId?: number; disableNotification?: boolean; replyMarkup?: unknown }): Promise<{ message_id: number }>;
  editRichMessage(chatId: number, messageId: number, rich: { blocks: TgBlock[] }, opts?: { replyMarkup?: unknown }): Promise<boolean>;
  sendRichMessageDraft(chatId: number, draftId: number, rich: { blocks: TgBlock[] }, canStop?: boolean, keepOnStop?: boolean): Promise<boolean>;
}

// ── Out adapter: client + state tracking + persist ──

export function makeOut(client: ClientLike, state: TelegramState, persist: () => Promise<void>): Out {
  return {
    async send(chatId, text, opts) {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      const sent = await client.sendMessage(chatId, text, { parseMode, replyToId: opts?.replyToId, replyMarkup: opts?.replyMarkup, disableNotification: opts?.disableNotification });
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    async sendRich(chatId, blocks, opts) {
      const sent = await client.sendRichMessage(chatId, { blocks }, opts);
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    sendDraft: (chatId, draftId, blocks, canStop, keepOnStop) =>
      client.sendRichMessageDraft(chatId, draftId, { blocks }, canStop, keepOnStop),
    editRich: (chatId, messageId, blocks, opts) => client.editRichMessage(chatId, messageId, { blocks }, opts),
    edit: (chatId, messageId, text, opts) => {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      return client.editMessageText(chatId, messageId, text, { parseMode, replyMarkup: opts?.replyMarkup });
    },
    delete: (chatId, messageId) => client.deleteMessage(chatId, messageId),
  };
}

// ── TelegramPi adapter: pi + latest contexts → the bridge’s structural interface ──

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

export interface TelegramPiDeps {
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

export function makeTelegramPi(deps: TelegramPiDeps): TelegramPi {
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
          onDone(true, compactTokenDetail(res?.tokensBefore, res?.estimatedTokensAfter));
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
    // The session's cumulative tokens (the card's ` ↑<in> ↓<out>`): the FULL
    // branch (getBranch is not compaction-aware — every assistant message of
    // the session's life counts, like messageCount), assistant role only.
    sessionUsage: () => {
      let input = 0;
      let output = 0;
      for (const e of ctx()?.sessionManager.getBranch() ?? []) {
        if (e.type !== "message") continue;
        const m = e.message as { role?: string; usage?: { input?: number; output?: number } } | undefined;
        if (m?.role !== "assistant") continue;
        input += m.usage?.input ?? 0;
        output += m.usage?.output ?? 0;
      }
      return { input, output };
    },
    listSessions: () => deps.listSessions(ctx()?.cwd ?? ""),
    currentSessionPath: () => ctx()?.sessionManager.getSessionFile() ?? "",
    notifyUi(text, level) {
      ctx()?.ui.notify(text, level ?? "info");
    },
    shutdown: () => requireCtx().shutdown(),
  };
}

// ── TUI dialog mirroring (Option A) ─────────────────────────────────────────
// pi's ctx.ui is ONE shared plain object (runner.uiContext, wrapped by pi's
// wrapUIPromptContext) that EVERY extension's ctx resolves live. We patch its
// dialog methods in place: the real TUI dialog opens as usual while a Telegram
// twin goes out; the first resolution wins. TG win ⇒ the TUI dialog is
// dismissed via the combined AbortSignal (pi's supported dismiss path); TUI
// win ⇒ host.tuiAnswered stamps the Telegram message. custom() is NOT
// mirrorable (arbitrary component) — it stays TUI-only with the existing
// ui_prompt_start heads-up. Verified against pi 0.87.1: select/confirm/input
// accept opts.signal (abort ⇒ resolve(undefined)); editor has NO opts (a TG-
// first answer leaves the TUI editor open until Esc — its late resolution is
// discarded harmlessly).

export interface UiDialogSpec {
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}

export type UiDialogAnswer =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string }
  | { kind: "cancel" }
  | { kind: "expired" };

/** Implemented by PendingDialogs (src/ui-dialogs.ts). */
export interface UiDialogHost {
  /** cfg.mirrorDialogs master switch. */
  enabled(): boolean;
  /** Register + send the Telegram twin. undefined = cannot show (unpaired/disabled/send failed) → TUI-only. */
  show(spec: UiDialogSpec): Promise<number | undefined>;
  /** Attach the race resolver for a shown dialog. */
  answer(id: number, resolve: (a: UiDialogAnswer) => void): void;
  /** The TUI side resolved first (or timed out): stamp + release. */
  tuiAnswered(id: number, value: unknown): void;
}

export const UI_PROXY_MARKER = Symbol.for("pi-telegram.ui-proxy");

function specFor(method: UiDialogSpec["kind"], args: unknown[]): UiDialogSpec {
  const [title, a2] = args;
  switch (method) {
    case "select":
      return { kind: "select", title: String(title), options: Array.isArray(a2) ? a2.map(String) : undefined };
    case "confirm":
      return { kind: "confirm", title: String(title), message: typeof a2 === "string" ? a2 : "" };
    case "input":
      return { kind: "input", title: String(title), placeholder: typeof a2 === "string" ? a2 : undefined };
    case "editor":
      return { kind: "editor", title: String(title), prefill: typeof a2 === "string" ? a2 : undefined };
  }
}

function mapAnswer(method: UiDialogSpec["kind"], args: unknown[], a: UiDialogAnswer): unknown {
  switch (method) {
    case "select": {
      const options = Array.isArray(args[1]) ? args[1] : [];
      return a.kind === "option" ? options[a.index] : undefined;
    }
    case "confirm":
      return a.kind === "option" ? a.index === 0 : false; // mirror pi: cancel ⇒ false
    case "input":
    case "editor":
      return a.kind === "text" ? a.text : undefined;
  }
}

/** select/confirm/input take opts LAST (maybe omitted); editor has no opts at all. */
function withCombinedSignal(
  method: UiDialogSpec["kind"],
  orig: (...a: unknown[]) => unknown,
  args: unknown[],
  signal: AbortSignal,
): unknown {
  if (method === "editor") return orig(...args);
  const next = [...args];
  const last = next[next.length - 1];
  if (last === undefined || (typeof last === "object" && !Array.isArray(last))) {
    const opts = (typeof last === "object" && last !== null ? last : {}) as { signal?: AbortSignal };
    next[next.length - 1] = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal };
  } else {
    next.push({ signal });
  }
  return orig(...next);
}

/**
 * Install the in-place proxy on the shared ctx.ui object. Idempotent (marker);
 * returns false (with a warn) when the object is not patchable or has no dialog
 * methods — the caller degrades to heads-up-only (today's behavior). Must be
 * re-called on every session_start: each runner swap creates a FRESH wrapped
 * object, so a previous patch never carries over.
 */
export function installUiProxy(ui: Record<PropertyKey, unknown>, host: UiDialogHost, warn?: (msg: string) => void): boolean {
  try {
    if (ui[UI_PROXY_MARKER]) return true;
  } catch {
    return false; // a hostile ui object — never break the caller
  }
  const methods = ["select", "confirm", "input", "editor"] as const;
  let patched = 0;
  for (const m of methods) {
    let orig: ((...a: unknown[]) => unknown) | undefined;
    try {
      orig = ui[m] as ((...a: unknown[]) => unknown) | undefined;
    } catch {
      continue; // a hostile property read — skip this method, patch the rest
    }
    if (typeof orig !== "function") continue;
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      // Fault isolation: every pi-tg step below is guarded; ANY internal
      // failure degrades to the plain TUI call, exactly as unpatched pi would
      // behave. pi's own errors (from `orig`) always propagate untouched.
      let id: number | undefined;
      try {
        if (host.enabled()) {
          const spec = specFor(m, args);
          id = await host.show(spec);
        }
      } catch {
        id = undefined; // enabled()/specFor()/show() threw — TUI-only
      }
      if (id === undefined) return (orig as (...a: unknown[]) => unknown)(...args); // TG unavailable → TUI-only
      const ac = new AbortController();
      let tuiPromise: Promise<unknown>;
      try {
        tuiPromise = Promise.resolve(withCombinedSignal(m, orig, args, ac.signal));
      } catch (err) {
        try {
          host.tuiAnswered(id, undefined); // release the already-sent Telegram twin
        } catch {
          /* stamping is best effort — the error below propagates anyway */
        }
        throw err; // propagate exactly as unmirrored pi would
      }
      const dialogId = id;
      return new Promise<unknown>((resolve, reject) => {
        let done = false;
        tuiPromise.then(
          (v) => {
            if (done) return;
            done = true;
            try {
              host.tuiAnswered(dialogId, v);
            } catch {
              /* stamping is best effort — the TUI answer wins regardless */
            }
            resolve(v);
          },
          (err) => {
            if (done) return;
            done = true;
            try {
              host.tuiAnswered(dialogId, undefined);
            } catch {
              /* best effort */
            }
            reject(err);
          },
        );
        try {
          host.answer(dialogId, (a) => {
            if (done || a.kind === "expired") return;
            done = true;
            try {
              ac.abort(); // dismiss the TUI dialog (select/confirm/input); editor has no signal — it stays open until Esc
            } catch {
              /* the TUI dialog stays open; its answer still decides */
            }
            resolve(mapAnswer(m, args, a));
          });
        } catch {
          // The race resolver could not be attached — the TUI dialog alone
          // decides the outcome (its path stamps + resolves).
        }
      });
    };
    try {
      ui[m] = wrapped;
    } catch {
      // getter-only property (strict mode): the assignment throws — not patchable
      warn?.("pi-tg: ctx.ui is not patchable — dialog mirroring disabled (heads-up only)");
      return false;
    }
    try {
      if (ui[m] !== wrapped) {
        warn?.("pi-tg: ctx.ui is not patchable — dialog mirroring disabled (heads-up only)");
        return false;
      }
    } catch {
      warn?.("pi-tg: ctx.ui is not patchable — dialog mirroring disabled (heads-up only)");
      return false;
    }
    patched++;
  }
  if (patched === 0) {
    warn?.("pi-tg: no dialog methods on ctx.ui — dialog mirroring disabled");
    return false;
  }
  try {
    ui[UI_PROXY_MARKER] = true;
  } catch {
    // The methods are patched but the marker cannot be set: a repeat install on
    // the SAME object could double-wrap. pi creates a fresh ui object per runner
    // swap, so in practice this only costs a heads-up.
    warn?.("pi-tg: could not mark ctx.ui as patched (re-install may re-wrap)");
  }
  return true;
}
