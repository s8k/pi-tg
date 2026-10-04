import { test } from "node:test";
import assert from "node:assert/strict";
import { notAuthorizedBlocks, pairWelcomeBlocks, renderQr, tokenLooksValid } from "../src/onboarding.ts";

const richPlain = (blocks: import("../src/rich-blocks.ts").TgBlock[]): string =>
  blocks
    .map((b) => {
      const rt: import("../src/rich-blocks.ts").TgRichText = b.type === "paragraph" || b.type === "heading" ? b.text : "";
      return typeof rt === "string" ? rt : Array.isArray(rt) ? rt.map(richPlainRt).join("") : richPlainRt(rt);
    })
    .join("\n");
const richPlainRt = (rt: import("../src/rich-blocks.ts").TgRichText): string =>
  typeof rt === "string" ? rt : Array.isArray(rt) ? rt.map(richPlainRt).join("") : richPlainRt(rt.text);

test("renderQr: uniform width, no ANSI escapes, deterministic, has modules", () => {
  const q1 = renderQr("https://t.me/pi_telegram_bot");
  const q2 = renderQr("https://t.me/pi_telegram_bot");
  assert.equal(q1, q2);
  assert.ok(!q1.includes("\x1b"));
  const lines = q1.split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `line widths: ${[...widths]}`);
  assert.ok(lines.length >= 25);
  assert.ok(q1.includes("█") && q1.includes("▁"));
});

test("tokenLooksValid: BotFather shape only", () => {
  assert.ok(tokenLooksValid("123456789:AAHk3xYz-abcDEF1234567890123456"));
  assert.ok(tokenLooksValid("  123456789:AAHk3xYz-abcDEF1234567890123456  "));
  assert.ok(!tokenLooksValid("abc"));
  assert.ok(!tokenLooksValid("123456:"));
  assert.ok(!tokenLooksValid("123456:short"));
});

test("pairing texts", () => {
  assert.ok(richPlain(pairWelcomeBlocks("mybot", 42)).includes("ID 42"));
  assert.ok(richPlain(pairWelcomeBlocks("mybot", 42)).includes("t.me/mybot"));
  assert.ok(!richPlain(pairWelcomeBlocks(undefined, 42)).includes("t.me/undefined"));
  assert.ok(richPlain(notAuthorizedBlocks(true)).includes("another account"));
  assert.ok(richPlain(notAuthorizedBlocks(false)).includes("Start"));
});
