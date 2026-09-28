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
const SEEN_CAP = 200;

/**
 * Per-instance runtime state. `sentIds` + `offset` are persisted by index.ts
 * (they must survive restarts and session replacement); the rest is instance-scoped.
 */
export class TelegramState {
  private sent: number[] = [];
  /** update_ids already handled — replay guard (the offset can regress after a
   * crash or a 409 twin, and Telegram redelivers unconfirmed updates). */
  private seen: number[] = [];
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
  /**
   * Restore the replay guard. Only ids ABOVE the restored offset can ever be
   * redelivered (getUpdates returns ids ≥ offset), so ids ≤ offset are
   * dropped — a fresh stream reusing low ids (tests) is never shadowed by a
   * stale guard, while a regressed-offset replay (ids above it) is still caught.
   */
  restoreSeenIds(ids: number[], offset: number): void {
    this.seen = ids.filter((id) => id > offset).slice(-SEEN_CAP);
  }
  seenIds(): number[] {
    return [...this.seen];
  }
  isSeen(id: number): boolean {
    return this.seen.includes(id);
  }
  markSeen(id: number): void {
    if (this.seen.includes(id)) return;
    this.seen.push(id);
    if (this.seen.length > SEEN_CAP) this.seen = this.seen.slice(-SEEN_CAP);
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
