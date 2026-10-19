import type { TgAction } from "./router.ts";
import { CB } from "./router.ts";
import type { OutputLevel, TelegramConfig } from "./config.ts";
import type { TelegramState, SessionListItem } from "./state.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import { supportedThinkingLevels } from "./thinking.ts";
import { pairWelcomeBlocks, notAuthorizedBlocks } from "./onboarding.ts";
import { escapeHtml } from "./markdown.ts";
import { mdToBlocks, type TgBlock, type TgRichText } from "./rich-blocks.ts";
import { formatGpuLines, type GpuStats } from "./gpu.ts";
import { formatSysLine, type SysStats } from "./sys.ts";
import { COMPACT_CANCELLED_MSG } from "./compact.ts";
import { AUTO_COMPACT_STATUS, AUTO_COMPACT_DONE_TEXT, fmtTokens, fmtUsd } from "./mirror.ts";
import { mergeCommands, dispatchFor, actionForDecision, PICKER_BUTTON } from "./pi-commands.ts";
import { BOT_COMMANDS } from "./bot-commands.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The running pi-tg version (package.json next to this module), for the
 * /help header stamp: after `npm update` + `/reload` the stamp shows the
 * NEW version only if the reload actually re-imported the extension code —
 * it is the user-visible proof of which generation is live.
 */
export const PI_TG_VERSION: string | undefined = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined; // versionless install — the header simply omits the stamp
  }
})();

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
export interface TelegramPi {
  cwd: string;
  isIdle(): boolean;
  abort(): void;
  sendPrompt(text: string, deliverAs: "now" | "steer"): void;
  newSession(): void; // triggers instance replacement
  switchSession(path: string): void; // triggers instance replacement
  waitForIdle(): Promise<void>;
  compact(onDone: (ok: boolean, detail?: string) => void, instructions?: string): void; // instructions → pi's customInstructions (inline picker /compact <text>)
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
  /** The session's cumulative usage (tokens over assistant messages; cost over all cost-bearing branch entries). */
  sessionUsage(): { input: number; output: number; cost: number };
  listSessions(): Promise<PiSessionInfo[]>;
  currentSessionPath(): string;
  notifyUi(text: string, level?: "info" | "warning" | "error"): void;
  shutdown(): void;
  /** Live resource commands (pi.getCommands) — inline command picker. */
  getCommands(): { name: string; description: string; source: "extension" | "prompt" | "skill" }[];
  /** Run a session command by name (idle only — the bridge checks first). */
  runCommand(name: string, args: string): void;
}

/**
 * Structural view of the dialog host (src/ui-dialogs.ts) — keeps the bridge
 * pi-free & testable. Absent when mirrorDialogs is off.
 */
export interface DialogsPort {
  /** Telegram side answered a pending dialog. false = stale (already answered / unknown id). */
  tgAnswer(dialogId: number, input: { kind: "option"; index: number } | { kind: "text"; text: string } | { kind: "cancel" }): boolean;
  /** The dialog id for a pending dialog's Telegram message (reply routing), or undefined. */
  dialogIdForMessage(messageId: number): number | undefined;
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
  /** Blocks-tier rich message (Bot API 10.2+); records the sent id; returns it. `disableNotification` suppresses the notification sound (persistent sends only — drafts cannot). */
  sendRich(
    chatId: number,
    blocks: TgBlock[],
    opts?: { disableNotification?: boolean; replyToId?: number; replyMarkup?: unknown }
  ): Promise<number | undefined>;
  /** Edits a rich message in place (editMessageText's rich_message parameter). false = unchanged (not an error). Omitting replyMarkup REMOVES the existing keyboard (stamps use this to disable dialog buttons). */
  editRich(chatId: number, messageId: number, blocks: TgBlock[], opts?: { replyMarkup?: unknown }): Promise<boolean>;
  /** Ephemeral draft (blocks-tier; `thinking` blocks are allowed here — never in persistent sends). The same draftId refreshes in place. keepOnStop keeps the draft when Stop is pressed. */
  sendDraft(chatId: number, draftId: number, blocks: TgBlock[], canStop?: boolean, keepOnStop?: boolean): Promise<boolean>;
}

export interface BridgeDeps {
  pi: TelegramPi;
  out: Out;
  state: TelegramState;
  cfg: TelegramConfig;
  botUsername: string | undefined;
  persist: () => Promise<void>; // save cfg (offset/sentIds/pendingAction/ownerId)
  sleep: (ms: number) => Promise<void>;
  /** GPU probe for /status; bounded by its own short timeout; undefined = unavailable. */
  probeGpu: () => Promise<GpuStats[] | undefined>;
  probeSys: () => SysStats | null;
  /** The session cwd's git branch (`` when undetermined → line omitted). */
  probeBranch: (cwd: string) => Promise<string | undefined>;
  /**
   * T6 early draft: called synchronously when the owner's prompt is
   * dispatched, BEFORE pi's agent_start — the run's draft (spinner) appears
   * immediately. index.ts wires it to the current mirror; optional (tests
   * that don't exercise the early draft leave it unset).
   */
  onPromptAccepted?: () => void;
  /**
   * The user pressed the native Stop on the RUN'S draft (stopped_message_
   * generation's draft_id): the mirror arms its can_stop=false reset packet
   * so the next send to the (suppressed) draft id renders again. index.ts
   * wires it to the current mirror; optional (tests leave it unset).
   */
  onDraftStopped?: (draftId: number) => void;
  /** Dialog mirroring host (absent when mirrorDialogs is off or tests don't exercise it). */
  dialogs?: DialogsPort;
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

/** The status card's always-on level suffix (and the ack emoji scale). */
const LEVEL_BADGES: Record<OutputLevel, string> = {
  mute: "🔇 mute",
  minimal: "🔉 minimal",
  full: "🔊 full",
};

const helpPara = (text: TgRichText): TgBlock => ({ type: "paragraph", text });

/**
 * The /help card as rich blocks — each line a paragraph, the command names
 * bold entities. SINGLE SOURCE OF TRUTH: the command lines are a verbatim
 * projection of the bot menu (BOT_COMMANDS) — same commands, order and
 * descriptions — so the menu and the card can never drift (the /help entry
 * included: its menu description carries the picker-button line).
 */
/**
 * Footer of the /help card when the bot has NO inline mode (getMe says so):
 * the ⌨️ picker button is omitted and this line explains the lost feature
 * and where to turn it back on.
 */
export const INLINE_MODE_OFF_FOOTER: TgBlock = {
  type: "paragraph",
  text: "⚠️ Inline mode is disabled — the session commands picker (in /help) is unavailable. Enable it: @BotFather → /mybots → Bot Settings → API Services → Inline mode.",
};

/**
 * The TUI-side twin of the footer — deliberately EVENT-DRIVEN (2026-10-11):
 * fired only at pairing completion and by /tg:config, never on startup or
 * /reload (the /help footer is the standing signal). One constant so the
 * two events can't drift.
 */
export const INLINE_MODE_OFF_WARNING =
  "pi-tg: INLINE MODE IS DISABLED for this bot — the session commands picker (in /help) will be unavailable. Enable it: @BotFather → /mybots → Bot Settings → API Services → Inline mode. Restart Pi or /reload afterwards.";

/**
 * `inlineModeEnabled: false` appends INLINE_MODE_OFF_FOOTER (the caller also
 * omits the ⌨️ picker button — the button and the footer move together).
 */
export function helpBlocks(opts?: { inlineModeEnabled?: boolean }): TgBlock[] {
  const cmd = (c: string, desc: string): TgBlock => helpPara([{ type: "bold", text: c }, ` — ${desc}`]);
  const parts: TgBlock[] = [
    helpPara([
      { type: "bold", text: "pi-tg" },
      `${PI_TG_VERSION ? ` v${PI_TG_VERSION}` : ""} — drive this Pi session from Telegram`,
    ]),
  ];
  for (const { command, description } of BOT_COMMANDS) parts.push(cmd(`/${command}`, description));
  if (opts?.inlineModeEnabled === false) {
    parts.push({ type: "divider" }); // separate the command list from the warning
    parts.push(INLINE_MODE_OFF_FOOTER);
  }
  return parts;
}

// ── compact draft (Telegram Bot API 10.2 rich message drafts) ──
// The in-progress state of /compact is an EPHEMERAL draft — it never touches
// the message history and is replaced by the stamped persistent result (the
// send itself also clears the draft, so no explicit delete is needed).
// Draft ids live in their own namespace: the mirror uses 1.., compact starts
// at 1_000_000.
const COMPACT_DRAFT_ID_BASE = 1_000_000;
export const COMPACT_DRAFT: TgBlock[] = [{ type: "thinking", text: "🗜 Compacting context…" }];
/** Lane-1 auto-compact draft content: the C1 status, wrapped in the ephemeral thinking block. */
const AUTO_COMPACT_DRAFT: TgBlock[] = [{ type: "thinking", text: AUTO_COMPACT_STATUS }];

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
  /**
   * One-shot confirmation questions (clear/kill): nonce → the question's
   * message id + blocks. A tap stamps the question IN PLACE (the edit removes
   * the keyboard — a Bot API fact, live-verified), so the buttons die with it
   * and repeat/foreign taps (same batch, old question) are silently ignored.
   */
  private oneShotSeq = 0;
  private oneShot = new Map<string, { chatId: number; messageId: number; blocks: TgBlock[] }>();
  /**
   * Inline-picker nonce table: nonce → the chosen command's NAME. The nonce
   * is minted by index.ts in the answerInlineQuery results (result_id
   * "c<nonce>") and looked up on cmdRun (chosen_inline_result tap). Only the
   * name is stored: the LIVE session table decides behavior at dispatch
   * time (a command removed before the tap gets the unknown-command reply).
   * Bounded (Map insertion order: the oldest evicts — evicted nonces are a
   * silent no-op).
   */
  private pendingRuns = new Map<string, string>();
  private static readonly PENDING_RUNS_CAP = 32;

  /** index.ts (answerInlineQuery): remember a result that may be chosen. */
  registerRun(nonce: string, name: string): void {
    this.pendingRuns.set(nonce, name);
    while (this.pendingRuns.size > SessionBridge.PENDING_RUNS_CAP) {
      const oldest = this.pendingRuns.keys().next().value;
      if (oldest === undefined) return;
      this.pendingRuns.delete(oldest);
    }
  }

  /** Persistent lookup — the entry stays (re-taps execute; unknown/evicted nonces → undefined). */
  lookupRun(nonce: string): string | undefined {
    return this.pendingRuns.get(nonce);
  }
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
      const stamp = mdToBlocks(cancelled ? "⏹️ Stopping… ✔️" : text);
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
      void this.deps.out.sendDraft(c.chatId, c.draftId, COMPACT_DRAFT, true, true).catch(() => {});
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
      .sendDraft(chatId, draftId, AUTO_COMPACT_DRAFT, false /* no Stop button */, true /* keepOnStop */)
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
  /**
   * Resolves after the stamp draft AND the persistent send are on the wire
   * — callers that must land AFTER the persistent message (it clears every
   * ephemeral draft in the chat) await it (index.ts: the lane-1 spinner
   * respawn).
   */
  async autoCompactFinish(ok: boolean, detail?: string): Promise<void> {
    const s = this.autoCompactState;
    if (!s) return; // no lane-1 compaction in flight (duplicate / raced event)
    this.autoCompactState = undefined;
    this.clearAutoCompactHeartbeat();
    const text = ok
      ? `${AUTO_COMPACT_DONE_TEXT}${detail ? ` ${detail}` : ""}`
      : `⚠️ ${detail ?? "compaction failed"}`;
    if (s.draftId !== 0) {
      await this.deps.out.sendDraft(s.chatId, s.draftId, mdToBlocks(text), false).catch(() => {});
    }
    await this.deps.out.send(s.chatId, text, { parseMode: null }).catch(() => {});
  }

  /** Re-send the lane-1 draft every cfg.draftHeartbeatMs (drafts expire after ~30 s). */
  private armAutoCompactHeartbeat(): void {
    this.clearAutoCompactHeartbeat();
    const tick = (): void => {
      this.autoCompactHbTimer = undefined;
      const s = this.autoCompactState;
      if (!s || s.draftId === 0) return;
      void this.deps.out.sendDraft(s.chatId, s.draftId, AUTO_COMPACT_DRAFT, false, true).catch(() => {});
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
      this.deps.pi.notifyUi(`pi-tg: ${msg}`, "error");
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
      await out.sendRich(chatId, await this.statusBlocks());
      if (cfg.askClearOnSwitch) {
        const nonce = `c${++this.oneShotSeq}`;
        const blocks: TgBlock[] = [{ type: "paragraph", text: "Clear chat history?" }];
        const id = await out.sendRich(chatId, blocks, {
          replyMarkup: {
            inline_keyboard: [[{ text: "🧹 Clear", callback_data: CB.clear(true, nonce) }, { text: "Keep", callback_data: CB.clear(false, nonce) }]],
          },
        });
        if (id !== undefined) this.oneShot.set(nonce, { chatId, messageId: id, blocks });
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

  private async statusBlocks(): Promise<TgBlock[]> {
    const { pi, cfg } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    const tokens = pi.sessionUsage();
    const blocks: TgBlock[] = [
      // entity data — the session name / cwd are NEVER parsed or escaped
      { type: "paragraph", text: ["📌 ", name, ` — ${pi.isIdle() ? "idle" : "busy"} · ${LEVEL_BADGES[cfg.level]}`] },
      { type: "paragraph", text: ["📁 dir: ", { type: "code", text: pi.cwd }] },
    ];
    // The cwd's git branch — directly UNDER the dir line; undetermined
    // (no git, not a repo, timeout) → the line is omitted. Bounded by the
    // probe's own short timeout; never throws.
    const branch = await this.deps.probeBranch(pi.cwd);
    if (branch) blocks.push({ type: "paragraph", text: `🌿 branch: ${branch}` });
    blocks.push(
      { type: "paragraph", text: `🤖 model: ${model?.name ?? "n/a"} · 🧠 thinking: ${pi.currentThinking() ?? "default"}` },
      { type: "paragraph", text: `📖 context: ${usage?.percent != null ? `${Math.round(usage.percent)}%` : "n/a"}${usage?.tokens != null ? ` (${usage.tokens}/${usage.contextWindow})` : ""}` },
      // The session's cumulative tokens (same ` ↑<in> ↓<out>` display the
      // mirror's bottom line uses) sit ABOVE the messages line. ALWAYS shown
      // — `↑0 ↓0` proves the wiring is live.
      { type: "paragraph", text: `🪙 tokens: ↑${fmtTokens(tokens.input)} ↓${fmtTokens(tokens.output)}` },
      // The session's cost — shown ONLY when something was actually spent
      // (local models report cost 0 → the card is unchanged for them).
      // (spread operands don't get the array's contextual type — annotate,
      // or `type` widens to `string` and fails TgBlock's literal union)
      ...(tokens.cost > 0 ? ([{ type: "paragraph", text: `💲 cost: ${fmtUsd(tokens.cost)}` }] as TgBlock[]) : []),
      { type: "paragraph", text: `📨 messages: ${pi.messageCount()}` },
    );
    // Bounded by the probe's own short timeout; unavailable → lines omitted.
    const gpus = await this.deps.probeGpu();
    if (gpus) for (const line of formatGpuLines(gpus)) blocks.push({ type: "paragraph", text: line });
    // CPU + RAM (checked on each card render; never throws → nulls → omitted).
    const sysLine = formatSysLine(this.deps.probeSys());
    if (sysLine) blocks.push({ type: "paragraph", text: sysLine });
    return blocks;
  }

  /**
   * Inline mode availability (getMe().supports_inline_queries, learned on
   * every poller start — /reload re-learns it). false → the /help card omits
   * the ⌨️ button and carries the footer explaining why.
   */
  private inlineModeEnabled = true;
  setInlineModeEnabled(enabled: boolean): void {
    this.inlineModeEnabled = enabled;
  }

  /** The /help card: picker button iff inline mode is enabled; footer otherwise. */
  private async sendHelp(chatId: number): Promise<void> {
    const { out } = this.deps;
    await out.sendRich(chatId, helpBlocks({ inlineModeEnabled: this.inlineModeEnabled }), {
      replyMarkup: this.inlineModeEnabled ? PICKER_BUTTON : undefined,
    });
  }

  private async sendCardAndHelp(chatId: number): Promise<void> {
    // the picker button lives on the help card only (removed from the status
    // card 2026-10-11)
    await this.deps.out.sendRich(chatId, await this.statusBlocks());
    await this.sendHelp(chatId);
  }

  private async handle(action: TgAction): Promise<void> {
    const { out, pi, cfg } = this.deps;
    switch (action.kind) {
      case "notAuthorized":
        await out.sendRich(action.chatId, notAuthorizedBlocks(cfg.ownerId !== undefined));
        return;
      case "pair": {
        cfg.ownerId = action.fromId;
        cfg.ownerChatId = action.chatId; // the /start chat is the owner's chat — persist it
        await this.deps.persist();
        await out.sendRich(action.chatId, pairWelcomeBlocks(this.deps.botUsername, action.fromId));
        await this.sendCardAndHelp(action.chatId);
        // Event-driven (2026-10-11): pairing completion is when "one thing
        // left in BotFather" makes sense — the Telegram side already shows
        // the /help footer; the TUI side gets the one-time nudge here.
        if (!this.inlineModeEnabled) this.deps.pi.notifyUi(INLINE_MODE_OFF_WARNING, "warning");
        return;
      }
      case "start":
        await this.sendCardAndHelp(action.chatId);
        return;
      case "help":
        await this.sendHelp(action.chatId);
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
            void out.sendDraft(c.chatId, c.draftId, COMPACT_DRAFT, true, true).catch(() => {});
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
        await out.sendRich(action.chatId, await this.statusBlocks()); // no picker button — it lives on the /help card only
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
              .sendDraft(compacting.chatId, compacting.draftId, mdToBlocks("⏹️ Stopping…"), false /* the draft is about to be stamped (finishCompact) */)
              .catch(() => {});
          return; // the final "⚠️ Compaction cancelled" comes via finishCompact
        }
        if (pi.isIdle()) await out.send(action.chatId, "Nothing to stop — session is idle.");
        else {
          pi.abort();
          if (action.draftId !== undefined) this.deps.onDraftStopped?.(action.draftId); // the run's draft id is suppressed until the mirror's can_stop=false reset packet
          const stopMsg = await out.send(action.chatId, "⏹️ Stopping…");
          if (stopMsg !== undefined) void this.stampAfterIdle(action.chatId, stopMsg, "⏹️ Stopping… ✔️"); // waits for the aborted turn to end
        }
        return;
      }
      case "level_mute":
        cfg.level = "mute";
        await this.deps.persist();
        await out.send(action.chatId, "🔇 Level: mute — no agent output (commands still work).");
        return;
      case "level_minimal":
        cfg.level = "minimal";
        await this.deps.persist();
        await out.send(action.chatId, "🔉 Level: minimal — visible text only (no tools, no thinking).");
        return;
      case "level_full":
        cfg.level = "full";
        await this.deps.persist();
        await out.send(action.chatId, "🔊 Level: full — tool log + final answer (default).");
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
            pi.compact(onDone, action.instructions);
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
            .sendDraft(action.chatId, draftId, COMPACT_DRAFT, true /* canStop */, true /* keepOnStop — the bot persists it as the stamped result */)
            .catch(() => false);
          if (!this.compactState) return; // onDone raced past the draft send
          if (draftUp) {
            this.compactState.draftId = draftId;
            this.armCompactHeartbeat(); // the draft expires after ~30 s — keep it alive during the LLM call
          }
        }
        if (!busy) {
          try {
            pi.compact(onDone, action.instructions);
          } catch (err) {
            fail(err);
          }
        }
        return;
      }
      case "cmdRun": {
        // The nonce was minted in answerInlineQuery; unknown/evicted → no-op.
        const name = this.lookupRun(action.nonce);
        if (name === undefined) return;
        await this.runSessionCommand(action.chatId, name, "");
        return;
      }
      case "cmdSend":
        // Typed @bot /name args — the user's own message is the echo; no ack.
        await this.runSessionCommand(action.chatId, action.name, action.args);
        return;
      case "cmdTerminal":
        await out.send(action.chatId, `🖥 /${action.name} is a terminal-only command — run it in the Pi TUI.`, { parseMode: null });
        return;
      case "importSet": {
        // /import <path>: import (switch to) an existing session file — the
        // same rules as the session list (idle only; instance replacement).
        if (!action.path) {
          await out.send(action.chatId, "Usage: /import <path-to-session.jsonl>");
          return;
        }
        if (action.path === pi.currentSessionPath()) {
          await out.send(action.chatId, "Already active.");
          return;
        }
        if (!pi.isIdle()) {
          await out.send(action.chatId, "Agent is busy — send /stop first.");
          return;
        }
        await this.doSwitch(action.chatId, action.path);
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
        await out.sendRich(action.chatId, [
          { type: "paragraph", text: ["📌 Renamed to ", { type: "bold", text: action.name }, "."] },
        ]);
        return;
      case "killAsk": {
        const nonce = `k${++this.oneShotSeq}`;
        const blocks: TgBlock[] = [{ type: "paragraph", text: "⚠️ This terminates the Pi process — the bot goes silent until Pi restarts. Sure?" }];
        const id = await out.sendRich(action.chatId, blocks, {
          replyMarkup: {
            inline_keyboard: [[{ text: "☠ Yes, kill", callback_data: CB.kill(true, nonce) }, { text: "No", callback_data: CB.kill(false, nonce) }]],
          },
        });
        if (id !== undefined) this.oneShot.set(nonce, { chatId: action.chatId, messageId: id, blocks });
        return;
      }
      case "kill": {
        const p = this.consumeOneShot(action.nonce);
        if (action.nonce && !p) return; // stale tap — the question is already stamped
        if (!action.yes) {
          if (p) await this.stampOneShot(p, "✅ Kept running — Pi is still alive.");
          else await out.send(action.chatId, "OK — Pi keeps running."); // legacy (no nonce) — plain message
          return;
        }
        if (p) await this.stampOneShot(p, "☠ Shutting down…");
        await out.send(action.chatId, "👋 Shutting down pi… (bot goes silent)");
        pi.shutdown();
        return;
      }
      case "clear":
        await this.handleClear(action);
        return;
      case "dialogAnswer":
        // Stale taps (unknown/answered id) are silent: the stamp edit already
        // removed the keyboard, so this is a same-batch double tap at worst.
        this.deps.dialogs?.tgAnswer(action.dialogId, { kind: "option", index: action.index });
        return;
      case "dialogCancel":
        this.deps.dialogs?.tgAnswer(action.dialogId, { kind: "cancel" });
        return;
      case "dialogText": {
        const id = this.deps.dialogs?.dialogIdForMessage(action.replyToMessageId);
        if (id !== undefined) this.deps.dialogs?.tgAnswer(id, { kind: "text", text: action.text });
        return;
      }
      case "dialogPlain":
        // Plain-message fallback (no reply-to): the router already matched the
        // text against a pending text-answer dialog — deliver as its answer.
        this.deps.dialogs?.tgAnswer(action.dialogId, { kind: "text", text: action.text });
        return;
    }
  }

  /**
   * Executes a session command by name (inline picker taps + typed
   * `@bot /name args`), dispatching on the LIVE session command table:
   * mapped built-ins reuse the existing TG flows, resource commands go
   * through pi's prompt() (extension commands execute; templates/skills
   * expand), terminal-only built-ins get the 🖥 explanation. Unknown names
   * are NEVER dispatched (safety: only the live table's names are legal).
   */
  private async runSessionCommand(chatId: number, name: string, rest: string): Promise<void> {
    const { out, pi } = this.deps;
    const table = mergeCommands(pi.getCommands());
    const d = dispatchFor(name, rest, table);
    if (!d) {
      await out.send(chatId, `⚠️ Unknown command /${name} — it may have been removed.`, { parseMode: null });
      return;
    }
    if (d.type === "terminal") {
      await out.send(chatId, `🖥 /${d.name} is a terminal-only command — run it in the Pi TUI.`, { parseMode: null });
      return;
    }
    if (d.type === "action") {
      // Reuse the existing flow (status card, model picker, kill question…).
      await this.handle(actionForDecision(d, chatId)!);
      return;
    }
    // Resource command — same guards as a text prompt (B6): a manual
    // compaction in flight swallows prompts, and a busy agent is refused
    // (the tap has nowhere to queue — plain steer-queueing is for text).
    if (this.compactState) {
      await out.send(chatId, "🗜 Compaction already in progress — try again after it finishes");
      return;
    }
    if (!pi.isIdle()) {
      await out.send(chatId, "⚡️ Agent is busy — send /stop first, then retry.");
      return;
    }
    try {
      pi.runCommand(d.name, d.args);
    } catch (err) {
      await out.send(chatId, `⚠️ /${name}: ${err instanceof Error ? err.message : String(err)}`, { parseMode: null });
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

  /** Consume the tap's one-shot question (stale nonce → silent ignore). */
  private consumeOneShot(nonce: string | undefined): { chatId: number; messageId: number; blocks: TgBlock[] } | undefined {
    if (!nonce) return undefined;
    const p = this.oneShot.get(nonce);
    if (!p) return undefined; // stale: already answered, or a newer question replaced it
    this.oneShot.delete(nonce);
    return p;
  }

  /** Stamp the question in place: original blocks + a status line, NO keyboard —
    * the edit removes it (Bot API: editMessageText without reply_markup drops
    * the inline keyboard), so the stamped message can never be tapped again. */
  private async stampOneShot(p: { chatId: number; messageId: number; blocks: TgBlock[] }, line: string): Promise<void> {
    await this.deps.out.editRich(p.chatId, p.messageId, [...p.blocks, { type: "paragraph", text: line }]).catch(() => {});
  }

  private async handleClear(action: Extract<TgAction, { kind: "clear" }>): Promise<void> {
    const { out, state, sleep } = this.deps;
    const p = this.consumeOneShot(action.nonce);
    if (action.nonce && !p) return; // stale tap — the question is already stamped
    if (!action.doIt) {
      if (p) await this.stampOneShot(p, "✅ Kept — chat history stays.");
      else await out.send(action.chatId, "OK — chat history kept."); // legacy (no nonce) — plain message
      return;
    }
    const ids = state.drainSent();
    if (ids.length === 0) {
      if (p) await this.stampOneShot(p, "✅ Nothing to clear.");
      else await out.send(action.chatId, "Nothing to clear.");
      return;
    }
    if (p) await this.stampOneShot(p, "🧹 Clearing…");
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
