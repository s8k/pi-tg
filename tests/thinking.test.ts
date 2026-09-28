import { test } from "node:test";
import assert from "node:assert/strict";
import { supportedThinkingLevels } from "../src/thinking.ts";

test("non-reasoning model → only 'off'", () => {
  assert.deepEqual(supportedThinkingLevels({ id: "m", name: "M", provider: "p", reasoning: false }), ["off"]);
});

test("reasoning, no map → off..high (xhigh/max need explicit map)", () => {
  const levels = supportedThinkingLevels({ id: "m", name: "M", provider: "p", reasoning: true });
  assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high"]);
});

test("map: null drops the level; defined xhigh adds it", () => {
  const levels = supportedThinkingLevels({
    id: "m", name: "M", provider: "p", reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "128000" },
  });
  assert.ok(!levels.includes("minimal"));
  assert.ok(levels.includes("xhigh"));
  assert.ok(!levels.includes("max"));
});

test("map: off can be dropped too", () => {
  const levels = supportedThinkingLevels({
    id: "m", name: "M", provider: "p", reasoning: true,
    thinkingLevelMap: { off: null },
  });
  assert.ok(!levels.includes("off"));
});
