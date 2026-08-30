import { test } from "node:test";
import assert from "node:assert/strict";
import { notAuthorizedText, pairWelcome, renderQr, tokenLooksValid } from "../src/onboarding.ts";

test("renderQr: uniform width, no ANSI escapes, deterministic, has modules", () => {
  const q1 = renderQr("https://t.me/pi_telega_bot");
  const q2 = renderQr("https://t.me/pi_telega_bot");
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
  assert.ok(pairWelcome("mybot", 42).includes("ID 42"));
  assert.ok(pairWelcome("mybot", 42).includes("t.me/mybot"));
  assert.ok(!pairWelcome(undefined, 42).includes("t.me/undefined"));
  assert.ok(notAuthorizedText(true).includes("another account"));
  assert.ok(notAuthorizedText(false).includes("Start"));
});
