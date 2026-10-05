/**
 * Throwaway probe for the TG dialog mirroring (Task 9.2 item 8).
 * Load it ALONGSIDE pi-tg:  pi -e /c/tmp/pi-tg/index.ts -e /c/tmp/pi-tg/scripts/dialog-probe.ts
 * then run /dialogtest in the TUI (or from Telegram).
 *
 * Expected: the TUI select dialog opens AND a Telegram twin appears with the
 * same options as inline buttons. Tapping a TG button must (a) stop the button
 * animation, (b) stamp the TG message with the picked option, (c) close the
 * TUI dialog. Answering in the TUI instead must stamp the TG message
 * "(answered in terminal)".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("dialogtest", {
    description: "Probe: select dialog (mirrored to Telegram)",
    handler: async (_name, ctx) => {
      const v = await ctx.ui.select("Pick a flavor", ["vanilla", "chocolate", "strawberry"]);
      ctx.ui.notify(`You picked: ${v ?? "(cancelled)"}`, "info");
    },
  });
  pi.registerCommand("dialogtest2", {
    description: "Probe: confirm dialog (mirrored to Telegram)",
    handler: async (_name, ctx) => {
      const v = await ctx.ui.confirm("Are you sure? (probe)");
      ctx.ui.notify(`Confirm: ${v ? "yes" : "no"}`, "info");
    },
  });
}
