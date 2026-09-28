import { test } from "node:test";
import assert from "node:assert/strict";

test("scaffolding: node --test runs TypeScript directly", () => {
  const n: number = 41;
  assert.equal(n + 1, 42);
});
