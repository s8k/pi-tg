// Shared fake harness for mirror tests: real Mirror + TelegramState, fake Out,
// injectable clock AND timers (heartbeat + throttle drain are fakes — no real
// sleeps). `advance(ms)` moves the clock and fires every due timer in time
// order (a firing timer may arm further ones; they fire too if still due).
import type { MirrorDeps } from "../src/mirror.ts";
import { TelegramState } from "../src/state.ts";
import { DEFAULTS, type TelegramConfig } from "../src/config.ts";
import { FakeOut } from "./fake-pi.ts";

export interface MirrorTestDeps {
  deps: MirrorDeps;
  out: FakeOut;
  state: TelegramState;
  cfg: TelegramConfig;
  advance(ms: number): void;
  timerCount(): number;
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export function makeMirrorDeps(cfg: Partial<TelegramConfig> = {}, chatId = 7): MirrorTestDeps {
  const out = new FakeOut();
  const state = new TelegramState();
  let t = 0;
  let seq = 0;
  const timers = new Map<number, FakeTimer>();
  const fullCfg: TelegramConfig = { ...DEFAULTS, botToken: "t", ownerId: 7, ...cfg };
  const deps: MirrorDeps = {
    out,
    state,
    cfg: fullCfg,
    getChatId: () => chatId,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { id, at: t + (ms ?? 0), fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    deps,
    out,
    state,
    cfg: fullCfg,
    advance: (ms: number) => {
      t += ms;
      for (;;) {
        const due = [...timers.values()].filter((x) => x.at <= t).sort((a, b) => a.at - b.at || a.id - b.id);
        if (due.length === 0) break;
        for (const x of due) {
          timers.delete(x.id);
          x.fn();
        }
      }
    },
    timerCount: () => timers.size,
  };
}

/** One microtask tick — lets fire-and-forget async handlers settle. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
