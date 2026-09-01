import type { PiThinkingLevel } from "./thinking.ts";

export interface SessionListItem {
  path: string;
  id: string;
  name?: string;
  firstMessage?: string;
  modified: number; // epoch ms
  messageCount: number;
}

const SENT_CAP = 500;

/**
 * Per-instance runtime state. `sentIds` + `offset` are persisted by index.ts
 * (they must survive restarts and session replacement); the rest is instance-scoped.
 */
export class TelegaState {
  private sent: number[] = [];
  private offset: number;
  private sessionList: SessionListItem[] = [];
  private modelList: string[] = [];
  private thinkingList: PiThinkingLevel[] = [];

  constructor(offset = 0) {
    this.offset = offset;
  }

  // persisted
  restoreSentIds(ids: number[]): void {
    this.sent = ids.slice(-SENT_CAP);
  }
  sentIds(): number[] {
    return [...this.sent];
  }
  addSent(id: number): void {
    if (this.sent.includes(id)) return;
    this.sent.push(id);
    if (this.sent.length > SENT_CAP) this.sent = this.sent.slice(-SENT_CAP);
  }
  /** Newest first; empties the tracker (used by “clear chat”). */
  drainSent(): number[] {
    const out = [...this.sent].reverse();
    this.sent = [];
    return out;
  }
  getOffset(): number {
    return this.offset;
  }
  setOffset(n: number): void {
    this.offset = n;
  }

  // instance-scoped
  setSessionList(items: SessionListItem[]): void {
    this.sessionList = items;
  }
  sessionAt(i: number): SessionListItem | undefined {
    return this.sessionList[i];
  }
  setModelList(models: string[]): void {
    this.modelList = models;
  }
  modelAt(i: number): string | undefined {
    return this.modelList[i];
  }
  setThinkingList(levels: PiThinkingLevel[]): void {
    this.thinkingList = levels;
  }
  thinkingAt(i: number): PiThinkingLevel | undefined {
    return this.thinkingList[i];
  }
}
