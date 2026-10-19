import QRCode from "qrcode";
import type { TgBlock, TgRichText } from "./rich-blocks.ts";

/**
 * Terminal QR rendered with half-size blocks, so each character encodes TWO
 * stacked modules (top + bottom) and the code is ~half the height of a one-
 * module-per-char render:
 *   █  both cells dark      ▀  top only      ▄  bottom only      (space) neither
 * Terminal cells are ~2:1 tall:wide, so the two sub-cells stay roughly square
 * and the code still scans. A 4-module (4-char) horizontal quiet zone frames
 * each row; a blank pad line caps the top and bottom. No ANSI escapes.
 */
export function renderQr(text: string): string {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = modules.size;
  const data = modules.data as Uint8Array;
  const dark = (r: number, c: number): boolean =>
    r >= 0 && r < size && data[r * size + c] === 1;
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let row = "    "; // 4-module quiet zone (left)
    for (let c = 0; c < size; c++) {
      const top = dark(y, c);
      const bottom = dark(y + 1, c);
      row += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(row + "    "); // 4-module quiet zone (right)
  }
  const pad = " ".repeat(size + 8);
  return pad + "\n" + rows.join("\n") + "\n" + pad;
}

/**
 * OSC 8 hyperlink (https://spec.commonmark.org/en/latest/autolinks/ and the
 * xterm OSC 8 spec): `ESC]8;;<url> BEL <text> ESC]8;; BEL`. pi's TUI renders
 * these as clickable links ("OSC 8 links take precedence over enclosing click
 * regions") and resets hyperlinks after each line, so each line must carry its
 * own start/stop pair. The visible `text` stays the plain URL, so a terminal
 * without OSC 8 support still shows a copyable address.
 */
export function osc8Link(text: string, url: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/**
 * Build the pairing selector's title for a bot URL — a multi-line TUI dialog
 * title (ctx.ui.select renders the title as multi-line text). Order is fixed by
 * design: title → plain-English instructions → the clickable bot URL → the QR.
 * The Cancel button is a select option, not part of the title. No emojis: the
 * terminal QR is the visual anchor and plain text stays crisp across themes.
 * The QR (from renderQr) already carries a blank quiet-zone row at its top and
 * bottom, so it separates the link from the option list without extra spacers.
 */
export function buildPairingTitle(url: string): string {
  return [
    "Pair Pi with Telegram",
    "",
    "To pair, open the link below in Telegram (or scan the QR code).",
    "Then press Start in the bot's chat.",
    "",
    osc8Link(url, url),
    ...renderQr(url).split("\n"),
  ].join("\n");
}

/** BotFather token shape: <digits>:<20+ alnum/-_>. Real validation is getMe() in the bridge. */
export function tokenLooksValid(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

export function pairWelcomeBlocks(botUsername: string | undefined, fromId: number): TgBlock[] {
  const base = `✅ Paired. Only your account (ID ${fromId}) can use this bot now.`;
  const text: TgRichText = botUsername
    ? [base, "\nTip: bookmark ", { type: "url", text: `https://t.me/${botUsername}`, url: `https://t.me/${botUsername}` }]
    : base;
  return [{ type: "paragraph", text }];
}

export function notAuthorizedBlocks(alreadyPaired: boolean): TgBlock[] {
  return [
    {
      type: "paragraph",
      text: alreadyPaired
        ? "🔒 Not authorized — this bot is paired with another account."
        : "🔒 Not paired yet. Press the /start button in this chat — the first account to press it becomes the owner.",
    },
  ];
}
