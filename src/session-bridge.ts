import type { TgAction } from "./router.ts";
import { CB } from "./router.ts";
import type { TelegaConfig } from "./config.ts";
import type { TelegaState, SessionListItem } from "./state.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import { supportedThinkingLevels } from "./thinking.ts";
import { pairWelcome, notAuthorizedText } from "./onboarding.ts";
import { escapeHtml } from "./markdown.ts";
import { formatGpuLines, type GpuStats } from "./gpu.ts";
import { COMPACT_CANCELLED_MSG } from "./compact.ts";
import { AUTO_COMPACT_STATUS, AUTO_COMPACT_DONE_TEXT, fmtTokens } from "./mirror.ts";

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
  /**
   * Hot-reload pi's extensions/skills/prompts/themes/context files (pi's
   * ctx.reload()). Fire-and-forget: pi replaces the extension runtime, so this
   * call is terminal — onDone(true) means the reload resolved; the old
   * instance stamps its ack with ✔️ (the confirmation — the replacement posts
   * nothing); onDone(false, detail) means the old instance is still alive and
   * must tell the user what failed.
   */
  reload(onDone: (ok: boolean, detail?: string) => void): void;
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
  /** The session's cumulative token usage (sum over its assistant messages). */
  sessionUsage(): { input: number; output: number };
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
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown; disableNotification?: boolean }
  ): Promise<number | undefined>;
  edit(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }
  ): Promise<boolean>; // false = text unchanged (not an error)
  delete(chatId: number, messageId: number): Promise<void>; // idempotent
  /** Rich message (markdown pass-through); records the sent id; returns it. `disableNotification` suppresses the notification sound (persistent sends only — drafts cannot). */
  sendRich(chatId: number, md: string, opts?: { disableNotification?: boolean }): Promise<number | undefined>;
  /** Ephemeral draft; the same draftId refreshes in place. keepOnStop keeps the draft when Stop is pressed. */
  sendDraft(chatId: number, draftId: number, md: string, canStop?: boolean, keepOnStop?: boolean): Promise<boolean>;
}

export interface BridgeDeps {
  pi: TelegaPi;
  out: Out;
  state: TelegaState;
  cfg: TelegaConfig;
  botUsername: string | undefined;
  persist: () => Promise<void>; // save cfg (offset/sentIds/pendingAction/ownerId)
  sleep: (ms: number) => Promise<void>;
  /** GPU probe for /status; bounded by its own short timeout; undefined = unavailable. */
  probeGpu: () => Promise<GpuStats[] | undefined>;
  /**
   * T6 early draft: called synchronously when the owner's prompt is
   * dispatched, BEFORE pi's agent_start — the run's draft (spinner) appears
   * immediately. index.ts wires it to the current mirror; optional (tests
   * that don't exercise the early draft leave it unset).
   */
  onPromptAccepted?: () => void;
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
    "<b>/compact</b> — compact the context (stoppable via the Stop button)",
    "<b>/reload</b> — hot-reload extensions & resources (idle only)",
    "<b>/name &lt;text&gt;</b> — rename this session",
    "<b>/kill</b> — shut down pi",
    "<b>/help</b> — this text",
  ].join("\n");
}

// ── compact draft (Telegram Bot API 10.2 rich message drafts) ──
// The in-progress state of /compact is an EPHEMERAL draft — it never touches
// the message history and is replaced by the stamped persistent result (the
// send itself also clears the draft, so no explicit delete is needed).
// Draft ids live in their own namespace: the mirror uses 1.., compact starts
// at 1_000_000.
const COMPACT_DRAFT_ID_BASE = 1_000_000;
export const COMPACT_DRAFT_MD = "<tg-thinking>🗜 Compacting context…</tg-thinking>";
/** Lane-1 auto-compact draft content: the C1 status, wrapped in the ephemeral thinking block. */
const AUTO_COMPACT_DRAFT_MD = `<tg-thinking>${AUTO_COMPACT_STATUS}</tg-thinking>`;

/** The in-progress state of a TG-initiated /compact (see case "compact"). */
interface CompactState {
  chatId: number;
  /** 0 until the draft send succeeds (then it is heartbeat-kept alive). */
  draftId: number;
  /** Set by the Stop button — the session_before_compact hook bails on it. */
  stopRequested: boolean;
  /** Aborted by the Stop button — the hook's summarization LLM call watches it. */
  controller: AbortController;
}

export class SessionBridge {
  private deps: BridgeDeps;
  private compactState: CompactState | undefined;
  private compactDraftSeq = 0;
  private compactHbTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /**
   * For the `session_before_compact` hook (index.ts): the pending
   * TG-initiated manual compaction, or undefined when the compaction was not
   * started by Telegram (TUI /compact, auto-compaction) — in which case the
   * hook leaves pi's default compaction untouched.
   */
  manualCompact(): { stopRequested: boolean; controller: AbortController } | undefined {
    const c = this.compactState;
    return c ? { stopRequested: c.stopRequested, controller: c.controller } : undefined;
  }

  /**
   * Finalize a /compact: clear state + heartbeat, STAMP the draft with the
   * final state, then persist the stamped result — the persistent send also
   * CLEARS the ephemeral draft ("stamp and save": the result becomes a normal
   * message in the history, the draft is gone). Plain text: the failure
   * detail is an error message and may contain HTML characters (a 400 here
   * would lose the result notice entirely). A Stop cancellation (A3) stamps
   * the Stop ack instead: ⏹️ Stopping… → ⏹️ Stopping… ✔️ →
   * ⚠️ Compaction cancelled.
   */
  private async finishCompact(ok: boolean, detail?: string): Promise<void> {
    const c = this.compactState;
    if (!c) return;
    this.compactState = undefined;
    this.clearCompactHeartbeat();
    const cancelled = !ok && detail === COMPACT_CANCELLED_MSG;
    const text = ok
      ? `🗜 Context compacted ✔️${detail ? ` ${detail}` : ""}`
      : cancelled
        ? "⚠️ Compaction cancelled"
        : `⚠️ Compaction Failed${detail ? `: ${detail}` : "."}`;
    const { out } = this.deps;
    if (c.draftId !== 0) {
      // The stamped state lands in the draft FIRST — the user sees the draft
      // morph into the result before the persistent message replaces it.
      const stamp = cancelled ? "⏹️ Stopping… ✔️" : text;
      await out.sendDraft(c.chatId, c.draftId, stamp, false /* no Stop button — it is over */).catch(() => {});
    }
    // A failed send must not become an unhandled rejection.
    await out.send(c.chatId, text, { parseMode: null }).catch(() => {});
  }

  /** Re-send the compact draft every cfg.draftHeartbeatMs (Bot API drafts expire after ~30 s). */
  private armCompactHeartbeat(): void {
    this.clearCompactHeartbeat();
    const tick = (): void => {
      this.compactHbTimer = undefined;
      const c = this.compactState;
      if (!c || c.draftId === 0) return; // finished or the draft never went up
      void this.deps.out.sendDraft(c.chatId, c.draftId, COMPACT_DRAFT_MD, true, true).catch(() => {});
      this.armCompactHeartbeat();
    };
    const t = setTimeout(tick, this.deps.cfg.draftHeartbeatMs);
    t.unref?.();
    this.compactHbTimer = t;
  }

  private clearCompactHeartbeat(): void {
    if (this.compactHbTimer !== undefined) {
      clearTimeout(this.compactHbTimer);
      this.compactHbTimer = undefined;
    }
  }

  // ── lane-1 auto-compact (T6: pi auto-compacts with NO live run draft) ──
  // The result events (session_compact / session_compact_failed) are routed
  // here by index.ts when the mirror had no live draft. Deliberately
  // SEPARATE from CompactState: a /stop during an auto-compact must hit the
  // plain idle branch (A2) — there is no bot-side controller that could
  // cancel pi's auto-compaction, so a ⏹️ Stopping… state would be a lie.
  private autoCompactState: { chatId: number; draftId: number } | undefined;
  private autoCompactHbTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Lane-1 auto-compact started (index.ts, session_before_compact auto with
   * no live mirror draft): raise the standalone ephemeral draft. No Stop
   * button — nothing bot-side can cancel pi's auto-compaction.
   */
  autoCompactStart(chatId: number): void {
    if (this.autoCompactState) return; // one at a time
    // The draft id is OURS (client-chosen) — claim it optimistically: a
    // session_compact that arrives before the first send lands must still
    // stamp it. If the send never lands, the stamp's sendDraft just fails
    // (caught) and the persistent send still goes out.
    const draftId = COMPACT_DRAFT_ID_BASE + ++this.compactDraftSeq;
    const state: { chatId: number; draftId: number } = { chatId, draftId };
    this.autoCompactState = state;
    void this.deps.out
      .sendDraft(chatId, draftId, AUTO_COMPACT_DRAFT_MD, false /* no Stop button */, true /* keepOnStop */)
      .then((up) => {
        if (this.autoCompactState !== state) return; // finished / superseded meanwhile
        if (up) this.armAutoCompactHeartbeat(); // landed: the draft expires after ~30 s — keep it alive
      })
      .catch(() => {});
  }

  /**
   * Lane-1 auto-compact finished (index.ts, session_compact /
   * session_compact_failed auto): stamp the draft with the result, then
   * persist it (the send also clears the draft). Plain text: the failure is
   * pi's pre-formatted error message (already ⚠-prefixed — verbatim, no
   * double prefix) and may contain HTML characters.
   */
  autoCompactFinish(ok: boolean, detail?: string): void {
    const s = this.autoCompactState;
    if (!s) return; // no lane-1 compaction in flight (duplicate / raced event)
    this.autoCompactState = undefined;
    this.clearAutoCompactHeartbeat();
    const text = ok
      ? `${AUTO_COMPACT_DONE_TEXT}${detail ? ` ${detail}` : ""}`
      : `⚠️ ${detail ?? "compaction failed"}`;
    void (async () => {
      if (s.draftId !== 0) {
        await this.deps.out.sendDraft(s.chatId, s.draftId, text, false).catch(() => {});
      }
      await this.deps.out.send(s.chatId, text, { parseMode: null }).catch(() => {});
    })();
  }

  /** Re-send the lane-1 draft every cfg.draftHeartbeatMs (drafts expire after ~30 s). */
  private armAutoCompactHeartbeat(): void {
    this.clearAutoCompactHeartbeat();
    const tick = (): void => {
      this.autoCompactHbTimer = undefined;
      const s = this.autoCompactState;
      if (!s || s.draftId === 0) return;
      void this.deps.out.sendDraft(s.chatId, s.draftId, AUTO_COMPACT_DRAFT_MD, false, true).catch(() => {});
      this.armAutoCompactHeartbeat();
    };
    const t = setTimeout(tick, this.deps.cfg.draftHeartbeatMs);
    t.unref?.();
    this.autoCompactHbTimer = t;
  }

  private clearAutoCompactHeartbeat(): void {
    if (this.autoCompactHbTimer !== undefined) {
      clearTimeout(this.autoCompactHbTimer);
      this.autoCompactHbTimer = undefined;
    }
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
    // A7: the /new ack ("🔄 Creating new session…") is edit-stamped with ✔️
    // BEFORE the new session's card — chronological in the history.
    if (pa.type === "new" && pa.ackMsgId !== undefined) {
      await out.edit(chatId, pa.ackMsgId, "🔄 Creating new session… ✔️").catch(() => {}); // message gone → best effort
    }
    // A /reload keeps the same session and is not session-related — nothing
    // new posted, no clear question (design B: the old instance's ✔️ stamp is
    // the reload's confirmation). /new and session switches post the card.
    if (pa.type !== "reload") {
      await out.send(chatId, await this.statusText());
      if (cfg.askClearOnSwitch) {
        await out.send(chatId, "Clear chat history?", {
          replyMarkup: {
            inline_keyboard: [[{ text: "🧹 Clear", callback_data: CB.clear(true) }, { text: "Keep", callback_data: CB.clear(false) }]],
          },
        });
      }
    }
  }

  /** Best-effort in-place stamp: a deleted/uneditable message is silently
   *  ignored; a failed edit must not become an unhandled rejection. */
  private stamp(chatId: number, messageId: number, text: string): void {
    void this.deps.out.edit(chatId, messageId, text).catch(() => { /* message gone */ });
  }

  /** Stamp a message once the (aborted) turn has actually ended; a failed wait
   *  (context gone, e.g. a concurrent reload) is silently ignored. */
  private async stampAfterIdle(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.deps.pi.waitForIdle();
    } catch {
      return;
    }
    this.stamp(chatId, messageId, text);
  }

  private async statusText(): Promise<string> {
    const { pi, cfg } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    const tokens = pi.sessionUsage();
    const lines = [
      `📌 ${escapeHtml(name)} — ${pi.isIdle() ? "idle" : "busy"}${cfg.muted ? " · 🔇 muted" : ""}`,
      `📁 dir: <code>${escapeHtml(pi.cwd)}</code>`,
      `🤖 model: ${model ? escapeHtml(model.name) : "n/a"} · 🧠 thinking: ${pi.currentThinking() ?? "default"}`,
      `📖 context: ${usage?.percent != null ? `${Math.round(usage.percent)}%` : "n/a"}${usage?.tokens != null ? ` (${usage.tokens}/${usage.contextWindow})` : ""}`,
      // The session's cumulative tokens (same ` ↑<in> ↓<out>` display the
      // mirror's bottom line uses) sit ABOVE the messages line. ALWAYS shown
      // — `↑0 ↓0` proves the wiring is live.
      `🪙 tokens: ↑${fmtTokens(tokens.input)} ↓${fmtTokens(tokens.output)}`,
      `📨 messages: ${pi.messageCount()}`,
    ];
    // Bounded by the probe's own short timeout; unavailable → line omitted.
    const gpus = await this.deps.probeGpu();
    if (gpus) lines.push(...formatGpuLines(gpus));
    return lines.join("\n");
  }

  private async sendCardAndHelp(chatId: number): Promise<void> {
    await this.deps.out.send(chatId, await this.statusText());
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
        // B6: reject a text prompt while a MANUAL compaction is in flight.
        // pi's prompt() throws in that window ("Cannot submit a prompt while
        // compaction is in progress") and isIdle() is still true there —
        // without this gate the prompt would be silently lost (the rejection
        // is invisible to extensions: the ExtensionAPI sendUserMessage
        // discards the promise) and the early draft would orphan forever
        // (its heartbeat keeps re-sending it past the ~30 s draft expiry).
        // NOTE: in-run AUTO-compaction must NOT be gated — pi's guard is
        // manual-only, and a prompt there is steer-queued and delivered
        // after the compact (see spec C-section note).
        if (this.compactState) {
          await out.send(
            action.chatId,
            "🗜 Compaction already in progress — resend your prompt after it finishes"
          );
          // A plain send dismisses the pending rich draft (Bot API behavior —
          // field report: the "Compacting context…" draft vanished until the
          // next heartbeat tick). Re-raise the SAME draft immediately so it
          // comes back right after the rejection. Re-read the state: compact
          // may have finished during the awaited send (then there is no
          // draft to restore).
          const c = this.compactState;
          if (c && c.draftId !== 0)
            void out.sendDraft(c.chatId, c.draftId, COMPACT_DRAFT_MD, true, true).catch(() => {});
          return;
        }
        // T6 early draft: the spinner goes out as soon as the prompt is
        // accepted — BEFORE the busy check (a broken ctx must not keep the
        // draft from going out) and before agent_start.
        this.deps.onPromptAccepted?.();
        const busy = !pi.isIdle();
        pi.sendPrompt(action.text, busy ? "steer" : "now");
        if (busy) await out.send(action.chatId, "⚡️ Message queued");
        return;
      }
      case "status":
        await out.send(action.chatId, await this.statusText());
        return;
      case "stop": {
        const compacting = this.compactState;
        if (compacting) {
          // Stop the IN-PROGRESS MANUAL COMPACTION (a compaction runs with
          // isIdle() === true, so this must come before the idle check):
          // flag it (the hook bails before/inside the LLM call) and abort the
          // compaction's own LLM call; also abort any not-yet-ended run so the
          // pre-compaction settle can't swallow the request.
          compacting.stopRequested = true;
          compacting.controller.abort();
          pi.abort();
          if (compacting.draftId !== 0)
            void out
              .sendDraft(compacting.chatId, compacting.draftId, "⏹️ Stopping…", false /* the draft is about to be stamped (finishCompact) */)
              .catch(() => {});
          return; // the final "⚠️ Compaction cancelled" comes via finishCompact
        }
        if (pi.isIdle()) await out.send(action.chatId, "Nothing to stop — session is idle.");
        else {
          pi.abort();
          const stopMsg = await out.send(action.chatId, "⏹️ Stopping…");
          if (stopMsg !== undefined) void this.stampAfterIdle(action.chatId, stopMsg, "⏹️ Stopping… ✔️"); // waits for the aborted turn to end
        }
        return;
      }
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
      case "compact": {
        if (this.compactState) {
          await out.send(action.chatId, "🗜 Compaction already in progress — use the Stop button to abort");
          return;
        }
        const controller = new AbortController();
        this.compactState = { chatId: action.chatId, draftId: 0, stopRequested: false, controller };
        const onDone = (ok: boolean, detail?: string): void => {
          void this.finishCompact(ok, detail); // stamp the draft, then persist (the state guards re-entry)
        };
        const fail = (err: unknown): void => onDone(false, err instanceof Error ? err.message : String(err));
        const busy = !pi.isIdle();
        if (busy) {
          // FIRST: abort the in-flight run so its persistent error lands before our draft.
          try {
            pi.compact(onDone);
            await pi.waitForIdle(); // wrapped in index.ts: also waits for the mirror to finish flushing the aborted run
          } catch (err) {
            fail(err); // e.g. no live pi context — the state must be finalized either way
            return;
          }
          if (!this.compactState) return; // fast path: onDone already stamped (or a Stop landed)
        }
        // The in-progress state: an ephemeral draft (never a message) with the
        // Stop button — pressing it aborts the compaction's LLM call (the
        // session_before_compact hook watches this.compactState's controller).
        let draftUp = false;
        if (!this.compactState.stopRequested) {
          const draftId = COMPACT_DRAFT_ID_BASE + ++this.compactDraftSeq;
          draftUp = await out
            .sendDraft(action.chatId, draftId, COMPACT_DRAFT_MD, true /* canStop */, true /* keepOnStop — the bot persists it as the stamped result */)
            .catch(() => false);
          if (!this.compactState) return; // onDone raced past the draft send
          if (draftUp) {
            this.compactState.draftId = draftId;
            this.armCompactHeartbeat(); // the draft expires after ~30 s — keep it alive during the LLM call
          }
        }
        if (!busy) {
          try {
            pi.compact(onDone);
          } catch (err) {
            fail(err);
          }
        }
        return;
      }
      case "new": {
        const ackMsg = await out.send(action.chatId, "🔄 Creating new session…");
        // The ack message's id rides with the pending action: the REPLACEMENT
        // instance (onSessionReplaced) edit-stamps it with ✔️ before the card.
        cfg.pendingAction = {
          type: "new",
          chatId: action.chatId,
          ...(ackMsg !== undefined ? { ackMsgId: ackMsg } : {}),
        };
        await this.deps.persist(); // awaited BEFORE newSession — the replacement instance reads it
        pi.newSession();
        return;
      }
      case "reload":
        if (!pi.isIdle()) {
          await out.send(action.chatId, "Agent is busy — send /stop first.");
          return;
        }
        cfg.pendingAction = { type: "reload", chatId: action.chatId };
        await this.deps.persist(); // the replacement instance reads it on session_start
        const reloadingMsg = await out.send(action.chatId, "🔄 Reloading extensions…");
        pi.reload((ok, detail) => {
          if (ok) {
            // Confirmed: stamp the original message with ✔️ (best effort)
            if (reloadingMsg !== undefined) this.stamp(action.chatId, reloadingMsg, "🔄 Reloading extensions… ✔️");
            return;
          }
          // Failure: the old instance is still alive — a failed send must not
          // become an unhandled rejection
          void out.send(
            action.chatId,
            `⚠️ Reload failed${detail ? `: ${detail}` : ""} (bot keeps running — check the TUI)`,
            { parseMode: null }
          ).catch(() => { /* best effort */ });
        });
        return;
      case "sessions":
        await this.handleSessions(action.chatId);
        return;
      case "sessionActivate":
        await this.handleSessionActivate(action);
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
    // A switch cannot wait for the current turn to end (a mid-run session
    // replacement would destroy the in-flight mirror draft): plain refusal —
    // the user must /stop first.
    await out.send(action.chatId, "Agent is busy — send /stop first.");
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
