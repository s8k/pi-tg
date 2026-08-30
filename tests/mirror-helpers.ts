import type { MirrorDeps } from "../src/mirror.ts";
import type { TelegaConfig } from "../src/config.ts";
import { DEFAULTS } from "../src/config.ts";
import { TelegaState } from "../src/state.ts";
import type { FakeOut } from "./fake-pi.ts";

export type MirrorTestDeps = MirrorDeps & { advance(ms: number): void };

export function makeMirrorDeps(
  out: FakeOut,
  cfg: Partial<TelegaConfig> = {},
  chatId: number | null = 7
): MirrorTestDeps {
  let clock = 0;
  return {
    out,
    state: new TelegaState(),
    cfg: { ...DEFAULTS, botToken: "t", ownerId: 7, ...cfg },
    // `null` = no chat yet (a default parameter cannot distinguish omitted from explicit undefined)
    getChatId: () => (chatId === null ? undefined : chatId),
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
