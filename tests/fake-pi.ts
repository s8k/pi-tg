import type { TelegramPi, PiModelInfo, PiSessionInfo, PiContextUsage } from "../src/session-bridge.ts";
import type { PiModel, PiThinkingLevel } from "../src/thinking.ts";
import { blocksToPlainText, type TgBlock } from "../src/rich-blocks.ts";

export interface FakePiOptions {
  cwd?: string;
  busy?: boolean;
  model?: PiModel;
  thinking?: PiThinkingLevel;
  scopedModels?: PiModelInfo[];
  allModels?: PiModel[];
  sessionName?: string;
  sessionPath?: string;
  messageCount?: number;
  contextUsage?: PiContextUsage;
  sessionUsage?: { input: number; output: number };
  sessions?: PiSessionInfo[];
  modelSetResult?: boolean;
  /** Live resource commands for the inline picker (pi.getCommands). */
  commands?: { name: string; description: string; source: "extension" | "prompt" | "skill" }[];
}

export class FakePi {
  readonly opts: FakePiOptions;
  readonly sentPrompts: { text: string; deliverAs: "now" | "steer" }[] = [];
  abortCalls = 0;
  newSessionCalls = 0;
  switchSessions: string[] = [];
  waitForIdleCalls = 0;
  setModels: string[] = [];
  setThinkings: string[] = [];
  setNames: string[] = [];
  shutdownCalls = 0;
  compactCalls = 0;
  compactDone: ((ok: boolean, detail?: string) => void) | undefined;
  reloadCalls = 0;
  reloadDone: ((ok: boolean, detail?: string) => void) | undefined;
  runCommands: { name: string; args: string }[] = [];
  /** Last customInstructions passed to compact (inline picker /compact <text>). */
  compactInstructions: string | undefined;
  uiNotices: { text: string; level?: "info" | "warning" | "error" }[] = [];

  constructor(opts: FakePiOptions = {}) {
    this.opts = opts;
  }

  build(): TelegramPi {
    const self = this;
    const impl: TelegramPi = {
      cwd: self.opts.cwd ?? "/proj",
      isIdle: () => !self.opts.busy,
      // a real abort ends the current turn → the agent goes idle again
      abort: () => {
        self.abortCalls++;
        self.opts.busy = false;
      },
      sendPrompt: (text, deliverAs) => self.sentPrompts.push({ text, deliverAs }),
      newSession: () => self.newSessionCalls++,
      switchSession: (path) => self.switchSessions.push(path),
      waitForIdle: async () => {
        self.waitForIdleCalls++;
      },
      compact: (onDone, instructions) => {
        self.compactCalls++;
        self.compactDone = onDone;
        self.compactInstructions = instructions;
      },
      reload: (onDone) => {
        self.reloadCalls++;
        self.reloadDone = onDone;
      },
      runCommand: (name, args) => { self.runCommands.push({ name, args }); },
      getCommands: () => self.opts.commands ?? [],
      getSessionName: () => self.opts.sessionName,
      setSessionName: (name) => self.setNames.push(name),
      currentModel: () => self.opts.model,
      currentThinking: () => self.opts.thinking,
      scopedModels: () => self.opts.scopedModels ?? [],
      allModels: () => self.opts.allModels ?? [],
      setModel: async (id) => {
        self.setModels.push(id);
        const known = [...(self.opts.scopedModels ?? []).map((s) => s.model), ...(self.opts.allModels ?? [])];
        const m = known.find((x) => x.id === id);
        if (m) self.opts.model = m; // mirror pi: a successful setModel changes the current model
        return self.opts.modelSetResult ?? true;
      },
      setThinkingLevel: (level) => self.setThinkings.push(level),
      contextUsage: () => self.opts.contextUsage,
      messageCount: () => self.opts.messageCount ?? 0,
      sessionUsage: () => self.opts.sessionUsage ?? { input: 0, output: 0 },
      listSessions: async () => self.opts.sessions ?? [],
      currentSessionPath: () => self.opts.sessionPath ?? "/proj/current.jsonl",
      notifyUi: (text, level) => self.uiNotices.push({ text, level }),
      shutdown: () => self.shutdownCalls++,
    };
    return impl;
  }
}

export interface FakeOutCall {
  kind: "send" | "edit" | "delete" | "sendRich" | "sendDraft" | "editRich";
  chatId: number;
  messageId?: number;
  text?: string;
  blocks?: TgBlock[];
  opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown; disableNotification?: boolean };
  draftId?: number;
  canStop?: boolean;
  keepOnStop?: boolean;
}

export class FakeOut {
  calls: FakeOutCall[] = [];
  nextMessageId = 100;
  sendFailsWith: Error | undefined;
  sendRichFailsWith: Error | undefined;
  sendHtmlFailsWith: Error | undefined; // only when opts.parseMode === "HTML"
  sendRichAttempts = 0;
  /** Per-attempt failures (wins over sendRichFailsWith). */
  sendRichFailScript?: (attempt: number) => Error | undefined;

  send = async (chatId: number, text: string, opts?: FakeOutCall["opts"]): Promise<number | undefined> => {
    if (this.sendFailsWith) throw this.sendFailsWith;
    if (opts?.parseMode === "HTML" && this.sendHtmlFailsWith) throw this.sendHtmlFailsWith;
    const id = this.nextMessageId++;
    this.calls.push({ kind: "send", chatId, text, opts, messageId: id });
    return id;
  };
  edit = async (chatId: number, messageId: number, text: string, opts?: FakeOutCall["opts"]): Promise<boolean> => {
    this.calls.push({ kind: "edit", chatId, messageId, text, opts });
    return true;
  };
  editRich = async (chatId: number, messageId: number, blocks: TgBlock[], opts?: { replyMarkup?: unknown }): Promise<boolean> => {
    this.calls.push({ kind: "editRich", chatId, messageId, blocks, text: blocksToPlainText(blocks), opts: { ...opts } });
    return true;
  };
  delete = async (chatId: number, messageId: number): Promise<void> => {
    this.calls.push({ kind: "delete", chatId, messageId });
  };
  sendRich = async (chatId: number, blocks: TgBlock[], opts?: { disableNotification?: boolean }): Promise<number | undefined> => {
    const attempt = this.sendRichAttempts++;
    const err = this.sendRichFailScript ? this.sendRichFailScript(attempt) : this.sendRichFailsWith;
    if (err) throw err;
    const id = this.nextMessageId++;
    this.calls.push({ kind: "sendRich", chatId, blocks, text: blocksToPlainText(blocks), opts, messageId: id });
    return id;
  };
  sendDraft = async (chatId: number, draftId: number, blocks: TgBlock[], canStop?: boolean, keepOnStop?: boolean): Promise<boolean> => {
    this.calls.push({ kind: "sendDraft", chatId, blocks, text: blocksToPlainText(blocks), draftId, canStop, keepOnStop });
    return true;
  };
}
