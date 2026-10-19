import { test } from "node:test";
import assert from "node:assert/strict";
import { notAuthorizedBlocks, pairWelcomeBlocks, renderQr, tokenLooksValid, buildPairingTitle, osc8Link } from "../src/onboarding.ts";

const richPlain = (blocks: import("../src/rich-blocks.ts").TgBlock[]): string =>
  blocks
    .map((b) => {
      const rt: import("../src/rich-blocks.ts").TgRichText = b.type === "paragraph" || b.type === "heading" ? b.text : "";
      return typeof rt === "string" ? rt : Array.isArray(rt) ? rt.map(richPlainRt).join("") : richPlainRt(rt);
    })
    .join("\n");
const richPlainRt = (rt: import("../src/rich-blocks.ts").TgRichText): string =>
  typeof rt === "string" ? rt : Array.isArray(rt) ? rt.map(richPlainRt).join("") : rt.type === "anchor" ? "" : richPlainRt(rt.text);

test("renderQr: half-block, uniform width, no ANSI, deterministic", () => {
  const q1 = renderQr("https://t.me/pi_telegram_bot");
  const q2 = renderQr("https://t.me/pi_telegram_bot");
  assert.equal(q1, q2);
  assert.ok(!q1.includes("\x1b"));
  const lines = q1.split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `line widths: ${[...widths]}`);
  // width = size modules + 4+4 module horizontal quiet zone
  const size = lines[0].length - 8;
  // half-height: one char per two stacked modules, + a top/bottom pad line
  assert.equal(lines.length, Math.ceil(size / 2) + 2);
  // uses the half-block glyphs (full / top / bottom), never the old low block
  assert.ok(q1.includes("█"));
  assert.ok(q1.includes("▀") || q1.includes("▄"), "mixed cells must appear");
  assert.ok(!q1.includes("▁"));
});

test("tokenLooksValid: BotFather shape only", () => {
  assert.ok(tokenLooksValid("123456789:AAHk3xYz-abcDEF1234567890123456"));
  assert.ok(tokenLooksValid("  123456789:AAHk3xYz-abcDEF1234567890123456  "));
  assert.ok(!tokenLooksValid("abc"));
  assert.ok(!tokenLooksValid("123456:"));
  assert.ok(!tokenLooksValid("123456:short"));
});

test("buildPairingTitle: title → instructions → URL → QR, URL between instructions and QR", () => {
  const url = "https://t.me/pi_telegram_bot";
  const lines = buildPairingTitle(url).split("\n");

  assert.equal(lines[0], "Pair Pi with Telegram");
  // instructions come before the URL
  const instrIdx = lines.findIndex((l) => l.includes("open the link below"));
  const urlIdx = lines.findIndex((l) => l.includes(url));
  assert.ok(instrIdx > 0 && instrIdx < urlIdx, "instructions precede the URL");
  // the URL line is a clickable OSC 8 link and sits above the QR
  assert.equal(lines[urlIdx], osc8Link(url, url));
  const firstQrRow = lines.findIndex((l) => l.includes("█"));
  assert.ok(urlIdx < firstQrRow, "the URL is above the QR");
  // Cancel is a select option, not a line in the title
  assert.ok(!lines.some((l) => l.includes("Cancel")), "Cancel is an option, not a title line");
});

test("buildPairingTitle: no emojis in the instruction/title lines", () => {
  const lines = buildPairingTitle("https://t.me/pi_telegram_bot").split("\n");
  // strip the QR matrix (block glyphs U+2580–259F) and the OSC 8 URL line —
  // the remaining prose must be emoji-free
  const prose = lines.filter((l) => !/[\u2580-\u259F]/.test(l) && !l.includes("\u001b]8"));
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const line of prose) assert.ok(!emoji.test(line), `emoji found in: ${JSON.stringify(line)}`);
});

test("pairing texts", () => {
  assert.ok(richPlain(pairWelcomeBlocks("mybot", 42)).includes("ID 42"));
  assert.ok(richPlain(pairWelcomeBlocks("mybot", 42)).includes("t.me/mybot"));
  assert.ok(!richPlain(pairWelcomeBlocks(undefined, 42)).includes("t.me/undefined"));
  assert.ok(richPlain(notAuthorizedBlocks(true)).includes("another account"));
  assert.ok(richPlain(notAuthorizedBlocks(false)).includes("/start"));
});
