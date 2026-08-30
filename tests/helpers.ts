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
      toolPreviewChars: 300,
      askClearOnSwitch: true,
      maxSessionList: 20,
      sentMessageIds: [],
      ...cfg,
    },
    botUsername: "testbot",
    persist: async () => {},
    sleep: async () => {},
  };
}

export function lastSend(out: FakeOut): string {
  const sends = out.calls.filter((c) => c.kind === "send" && typeof c.text === "string");
  return sends[sends.length - 1]!.text as string;
}
