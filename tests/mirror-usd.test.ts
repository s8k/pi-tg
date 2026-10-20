// fmtUsd — adaptive-precision USD for the session card's cost line.
// The line is only rendered when cost > 0, so the format must never
// produce a misleading $0.00 for a visible line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtUsd } from "../src/mirror.ts";

test("fmtUsd: >= $1 → 2 decimals", () => {
  assert.equal(fmtUsd(1), "$1.00");
  assert.equal(fmtUsd(0.45), "$0.450"); // 3-decimal band, not 2
  assert.equal(fmtUsd(12.345), "$12.35"); // rounds at the chosen width
});

test("fmtUsd: >= $0.01 → 3 decimals", () => {
  assert.equal(fmtUsd(0.01), "$0.010");
  assert.equal(fmtUsd(0.999), "$0.999"); // boundary: still below $1
  assert.equal(fmtUsd(0.4521), "$0.452");
});

test("fmtUsd: below $0.01 → 4 decimals", () => {
  assert.equal(fmtUsd(0.0099), "$0.0099");
  assert.equal(fmtUsd(0.00004), "$0.0000"); // known edge: sub-0.05¢ renders zero — accepted (design doc)
  assert.equal(fmtUsd(0), "$0.0000"); // 0 is never rendered (guard is in statusBlocks), but defined
});
