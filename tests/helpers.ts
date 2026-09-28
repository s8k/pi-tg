import type { TelegramPi, BridgeDeps } from "../src/session-bridge.ts";
import type { TelegramConfig } from "../src/config.ts";
import { TelegramState } from "../src/state.ts";
import type { FakeOut } from "./fake-pi.ts";

export function makeDeps(pi: TelegramPi, out: FakeOut, cfg: Partial<TelegramConfig> = {}): BridgeDeps {
  return {
    pi,
    out,
    state: new TelegramState(),
    cfg: {
      botToken: "t",
      ownerId: 7,
      streamEditMs: 1500,
      askClearOnSwitch: true,
      maxSessionList: 20,
      draftHeartbeatMs: 17_000,
      errorSettleMs: 5_000,
      codeFoldLines: 25,
      level: "full",
      mirrorDialogs: true,
      sentMessageIds: [],
      seenUpdateIds: [],
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
