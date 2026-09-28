import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// built indirectly so this file itself doesn’t trip the scan
const PI_PKG = "@earendil-works/" + "pi-coding-agent";
const ROOT = join(import.meta.dirname, "..");

function scan(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts"));
}

for (const dir of ["src", "tests"]) {
  test(`module boundary: ${dir}/**/*.ts never reference the pi package`, () => {
    for (const f of scan(dir)) {
      const src = readFileSync(join(ROOT, dir, f), "utf8");
      assert.ok(!src.includes(PI_PKG), `${dir}/${f} must not import ${PI_PKG}`);
    }
  });
}

test("module boundary: index.ts IS the pi importer", () => {
  const src = readFileSync(join(ROOT, "index.ts"), "utf8");
  assert.ok(src.includes(PI_PKG));
  assert.match(src, /export default function/);
});
