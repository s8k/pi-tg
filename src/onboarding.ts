import QRCode from "qrcode";

/**
 * Terminal QR: matrix rendered as █/▁ with a 4-module quiet zone.
 * A t.me bot link needs 25×25 at ECC-L → ~33 chars wide. No ANSI escapes.
 */
export function renderQr(text: string): string {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = modules.size;
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    let row = "    ";
    for (let c = 0; c < size; c++) row += modules.data[r * size + c] ? "█" : "▁";
    rows.push(row + "    ");
  }
  const pad = " ".repeat(size + 8);
  return pad + "\n" + rows.join("\n") + "\n" + pad;
}

/**
 * Structural subset of pi-tui's Component (render + invalidate).
 * pi's setWidget caps *string[]* content at 10 lines and appends
 * "... (widget truncated)" — a 25×25 QR is 27 lines, so the QR must be
 * passed as a component factory instead.
 */
export interface QrWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** Component factory for ctx.ui.setWidget(key, factory) — renders the full QR, uncapped. */
export function qrWidgetFactory(qr: string): (tui: unknown, theme: unknown) => QrWidgetComponent {
  const lines = qr.split("\n");
  return (_tui, _theme) => ({
    render: () => lines,
    invalidate: () => {},
  });
}

/** BotFather token shape: <digits>:<20+ alnum/-_>. Real validation is getMe() in the bridge. */
export function tokenLooksValid(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

export function pairWelcome(botUsername: string | undefined, fromId: number): string {
  const tip = botUsername ? `\nTip: bookmark https://t.me/${botUsername}` : "";
  return `✅ Paired. Only your account (ID ${fromId}) can use this bot now.${tip}`;
}

export function notAuthorizedText(alreadyPaired: boolean): string {
  return alreadyPaired
    ? "🔒 Not authorized — this bot is paired with another account."
    : "🔒 Not paired yet. Press the *Start* button in this chat — the first account to press it becomes the owner.";
}
