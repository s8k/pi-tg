import type { Out } from "./session-bridge.ts";
import { CB } from "./router.ts";
import { escapeHtml } from "./markdown.ts";

/** Dialog kinds that can be mirrored to Telegram (pi's custom() is not — it is an arbitrary TUI component). */
export type DialogKind = "select" | "confirm" | "input" | "editor";

export interface DialogSpec {
  kind: DialogKind;
  title: string;
  options?: string[]; // select
  message?: string; // confirm
  placeholder?: string; // input
  prefill?: string; // editor (informational only — the phone answer is always fresh text)
}

/** What happened on the Telegram side (or "expired": the TUI side won / the dialog was torn down). */
export type DialogAnswer =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string }
  | { kind: "cancel" }
  | { kind: "expired" };

/** What the bridge hands us from Telegram (never "expired"). */
export type DialogTgInput = { kind: "option"; index: number } | { kind: "text"; text: string } | { kind: "cancel" };

export interface PendingDialogsDeps {
  out: Out;
  getChatId(): number | undefined;
  /** cfg.mirrorDialogs — the master switch. */
  enabled(): boolean;
  notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}

interface Pending {
  chatId: number;
  spec: DialogSpec;
  messageId: number;
  numbered: boolean;
  resolve: (a: DialogAnswer) => void;
  /** (stamp, answer) waiting for the message id (the send is still in flight). */
  deferred?: { stamp: string; answer: DialogAnswer };
  /** Answer released before the race resolver was attached (see release/answer). */
  pendingAnswer?: DialogAnswer;
}

const NOOP: (a: DialogAnswer) => void = () => {};

/** select/confirm render as inline buttons up to this many options; beyond that the owner replies with a number. */
export const MAX_BUTTON_OPTIONS = 20;

/** Pure rendering of a dialog into Telegram HTML + inline keyboard rows (one testable unit). */
export function renderDialog(
  spec: DialogSpec,
  id: number,
  numbered: boolean,
): { text: string; buttons: { text: string; callback_data: string }[][] } {
  const t = escapeHtml(spec.title);
  if (spec.kind === "confirm") {
    return {
      text: `🔔 <b>${t}</b>\n${escapeHtml(spec.message ?? "")}`,
      buttons: [
        [
          { text: "✅ Yes", callback_data: CB.dialogAnswer(id, 0) },
          { text: "❌ No", callback_data: CB.dialogAnswer(id, 1) },
        ],
      ],
    };
  }
  if (spec.kind === "select" && !numbered && (spec.options?.length ?? 0) > 0) {
    return {
      text: `🔔 <b>${t}</b>\nChoose an option:`,
      buttons: [
        ...(spec.options ?? []).map((o, i) => [{ text: `${i + 1}. ${escapeHtml(o.slice(0, 60))}`, callback_data: CB.dialogAnswer(id, i) }]),
        [{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }],
      ],
    };
  }
  if (spec.kind === "select" && numbered) {
    const lines = (spec.options ?? []).map((o, i) => `${i + 1}. ${o.slice(0, 80)}`).join("\n");
    return {
      text: `🔔 <b>${t}</b>\nReply with the option number:\n${lines}`,
      buttons: [[{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }]],
    };
  }
  // input / editor
  return {
    text: `✏️ <b>${t}</b>\nReply to this message with your answer${spec.placeholder ? ` (${escapeHtml(spec.placeholder)})` : ""}.`,
    buttons: [[{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }]],
  };
}

/**
 * In-flight mirrored dialogs (one instance per polling generation, owned by
 * index.ts). The TG twin of a TUI dialog is a regular message with inline
 * buttons (select/confirm) or a reply-based prompt (input/editor); the first
 * resolution — phone or terminal — wins, and the message is stamped.
 */
export class PendingDialogs {
  private deps: PendingDialogsDeps;
  private nextId = 1;
  private byId = new Map<number, Pending>();
  private byMessageId = new Map<number, number>(); // Telegram message id → dialog id (reply routing)

  constructor(deps: PendingDialogsDeps) {
    this.deps = deps;
  }

  isDialogMessage(messageId: number): boolean {
    return this.byIdMessage(messageId) !== undefined;
  }

  /** UiDialogHost contract: the cfg.mirrorDialogs master switch. */
  enabled(): boolean {
    return this.deps.enabled();
  }

  /** A dialog with this exact title is pending on Telegram right now (the
   *  mirrored twin of a TUI prompt that is still open). */
  hasActive(title: string): boolean {
    for (const p of this.byId.values()) if (p.spec.title === title) return true;
    return false;
  }

  dialogIdForMessage(messageId: number): number | undefined {
    return this.byIdMessage(messageId);
  }

  private byIdMessage(messageId: number): number | undefined {
    return this.byMessageId.get(messageId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Register + send the Telegram dialog. Resolves to the dialog id, or undefined when it
   *  cannot be shown (unpaired / disabled / send failed) — the caller then stays TUI-only. */
  async show(spec: DialogSpec): Promise<number | undefined> {
    const chatId = this.deps.getChatId();
    if (!this.deps.enabled() || chatId === undefined) return undefined;
    const id = this.nextId++;
    const p: Pending = {
      chatId,
      spec,
      messageId: -1,
      numbered: spec.kind === "select" && (spec.options?.length ?? 0) > MAX_BUTTON_OPTIONS,
      resolve: NOOP, // placeholder until answer() attaches the race resolver
    };
    this.byId.set(id, p);
    const { text, buttons } = renderDialog(spec, id, p.numbered);
    let sent: number | undefined;
    try { sent = await this.deps.out.send(chatId, text, { replyMarkup: { inline_keyboard: buttons } });
    } catch (err) {
      this.deps.notify?.(`pi-telega: dialog send failed: ${String(err)}`, "error");
      this.byId.delete(id); // the wrapper never attaches (show returned undefined) — nothing to resolve
      return undefined;
    }
    if (sent === undefined) {
      this.byId.delete(id);
      return undefined;
    }
    p.messageId = sent;
    this.byMessageId.set(sent, id);
    if (p.deferred) {
      // A TG/TUI answer beat the sendMessage response — stamp with the now-known
      // id and release (release may hold the answer until answer() attaches).
      const d = p.deferred;
      p.deferred = undefined;
      void this.deps.out.edit(p.chatId, p.messageId, d.stamp, { parseMode: null }).catch(() => {});
      this.release(id, d.answer);
    }
    return id;
  }

  /** Attach the race resolver (wiring's installUiProxy). */
  answer(id: number, resolve: (a: DialogAnswer) => void): void {
    const p = this.byId.get(id);
    if (!p) return;
    p.resolve = resolve;
    if (p.pendingAnswer !== undefined) {
      // An answer was released before the resolver existed — deliver it now.
      const a = p.pendingAnswer;
      p.pendingAnswer = undefined;
      this.byId.delete(id);
      this.byMessageId.delete(p.messageId);
      resolve(a);
    }
  }

  /** Telegram side answered (bridge dispatch). false = stale (already answered / unknown id). */
  tgAnswer(dialogId: number, input: DialogTgInput): boolean {
    const p = this.byId.get(dialogId);
    if (!p) return false;
    if (p.numbered && input.kind === "text") {
      const n = Number(input.text.trim());
      if (!Number.isInteger(n) || n < 1 || n > (p.spec.options?.length ?? 0)) return false; // ignore — dialog stays open
      input = { kind: "option", index: n - 1 };
    }
    const stamp =
      input.kind === "option" ?
        // confirm carries a message, not an options list — name the choice.
        `✔️ ${p.spec.title}: answered: ${
          p.spec.kind === "confirm" ? (input.index === 0 ? "Yes" : "No") : (p.spec.options ?? [])[input.index] ?? `#${input.index + 1}`
        }`
        : input.kind === "text"
          ? `✔️ ${p.spec.title}: answered (see reply)`
          : `✖️ ${p.spec.title}: cancelled`;
    if (p.messageId === -1) {
      // The send is still in flight: stamp + release run once show() knows the id.
      p.deferred = { stamp, answer: input };
      return true;
    }
    void this.deps.out.edit(p.chatId, p.messageId, stamp, { parseMode: null }).catch(() => {});
    this.release(dialogId, input);
    return true;
  }

  /** The TUI side resolved first (or timed out): stamp + release. */
  tuiAnswered(dialogId: number, value: unknown): void {
    const p = this.byId.get(dialogId);
    if (!p) return;
    const stamp =
      value === undefined ? `💻 ${p.spec.title}: cancelled in the terminal` : `💻 ${p.spec.title}: answered in the terminal`;
    if (p.messageId === -1) {
      p.deferred = { stamp, answer: { kind: "expired" } };
      return;
    }
    void this.deps.out.edit(p.chatId, p.messageId, stamp, { parseMode: null }).catch(() => {});
    this.release(dialogId, { kind: "expired" });
  }

  /** Instance swap / shutdown: stamp + release everything (best effort, synchronous). */
  cancelAll(): void {
    for (const id of [...this.byId.keys()]) {
      const p = this.byId.get(id)!;
      if (p.messageId === -1) {
        p.deferred = { stamp: `⚠️ ${p.spec.title}: expired`, answer: { kind: "expired" } };
        continue;
      }
      void this.deps.out.edit(p.chatId, p.messageId, `⚠️ ${p.spec.title}: expired`, { parseMode: null }).catch(() => {});
      this.release(id, { kind: "expired" });
    }
  }

  private release(dialogId: number, a: DialogAnswer): void {
    const p = this.byId.get(dialogId);
    if (!p) return;
    if (p.resolve === NOOP) {
      // The race resolver isn't attached yet (show() still in flight) — hold the
      // answer; answer() delivers it the moment the wrapper attaches.
      p.pendingAnswer = a;
      return;
    }
    this.byId.delete(dialogId);
    this.byMessageId.delete(p.messageId);
    p.resolve(a);
  }
}
