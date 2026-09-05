import type { TelegaPi, BridgeDeps } from "../src/session-bridge.ts";
import type { TelegaConfig } from "../src/config.ts";
import { TelegaState } from "../src/state.ts";
import type { FakeOut } from "./fake-pi.ts";

export function makeDeps(pi: TelegaPi, out: FakeOut, cfg: Partial<TelegaConfig> = {}): BridgeDeps {
  return {
    pi,
    out,
    state: new TelegaState(),
    cfg: {
      botToken: "t",
      ownerId: 7,
      streamEditMs: 1500,
      askClearOnSwitch: true,
      maxSessionList: 20,
      draftHeartbeatMs: 17_000,
      errorSettleMs: 5_000,
      codeFoldLines: 25,
      muted: false,
      sentMessageIds: [],
      ...cfg,
    },
    botUsername: "testbot",
    persist: async () => {},
    sleep: async () => {},
    probeGpu: async () => undefined, // no GPU in tests unless a test overrides
  };
}

export function lastSend(out: FakeOut): string {
  const sends = out.calls.filter((c) => c.kind === "send" && typeof c.text === "string");
  return sends[sends.length - 1]!.text as string;
}
