// Shared fake harness for mirror tests: real Mirror + TelegaState, fake Out,
// injectable clock AND timer (the heartbeat is fake — no real sleeps).
import { Mirror, type MirrorDeps } from "../src/mirror.ts";
import { TelegaState } from "../src/state.ts";
import { DEFAULTS, type TelegaConfig } from "../src/config.ts";
import { FakeOut } from "./fake-pi.ts";

export interface MirrorTestDeps {
  deps: MirrorDeps;
  out: FakeOut;
  state: TelegaState;
  cfg: TelegaConfig;
  advance(ms: number): void;
  fireTimer(): void; // fires the single pending (heartbeat) timer, if any
}

export function makeMirrorDeps(cfg: Partial<TelegaConfig> = {}, chatId = 7): MirrorTestDeps {
  const out = new FakeOut();
  const state = new TelegaState();
  let t = 0;
  let timer: { fn: () => void } | undefined;
  const fullCfg: TelegaConfig = { ...DEFAULTS, botToken: "t", ownerId: 7, ...cfg };
  const deps: MirrorDeps = {
    out,
    state,
    cfg: fullCfg,
    getChatId: () => chatId,
    now: () => t,
    setTimer: (fn) => { timer = { fn }; return timer; },
    clearTimer: () => { timer = undefined; },
  };
  return {
    deps,
    out,
    state,
    cfg: fullCfg,
    advance: (ms: number) => { t += ms; },
    fireTimer: () => { const c = timer; timer = undefined; c?.fn(); },
  };
}
