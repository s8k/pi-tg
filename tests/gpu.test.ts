import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpuCsv, formatGpuLines, probeGpu, type GpuStats } from "../src/gpu.ts";

type FakeExecFile = (cmd: string, args: string[], cb: (err: Error | null, stdout?: string) => void) => void;

test("parseGpuCsv: single GPU, full data (MiB → GB)", () => {
  const stats = parseGpuCsv("67, 96, 14532, 24576\n");
  assert.equal(stats.length, 1);
  assert.equal(stats[0].tempC, 67);
  assert.equal(stats[0].utilPct, 96);
  assert.equal(stats[0].memUsedGb, 14532 / 1024);
  assert.equal(stats[0].memTotalGb, 24);
});

test("parseGpuCsv: multi-GPU rows", () => {
  const stats = parseGpuCsv("67, 96, 14532, 24576\r\n72, 50, 8192, 24576\n");
  assert.equal(stats.length, 2);
  assert.equal(stats[1].tempC, 72);
  assert.equal(stats[1].memUsedGb, 8);
});

test("parseGpuCsv: [N/A] fields → null; short/malformed rows skipped; never throws", () => {
  const stats = parseGpuCsv("[N/A], 96, [N/A], 24576\n67\nN/A, junk\n\n");
  assert.equal(stats.length, 1); // rows with <4 fields ("67", "N/A, junk") skipped
  assert.equal(stats[0].tempC, null);
  assert.equal(stats[0].utilPct, 96);
  assert.equal(stats[0].memUsedGb, null);
  assert.equal(stats[0].memTotalGb, 24);
  assert.deepEqual(parseGpuCsv(""), []);
  assert.deepEqual(parseGpuCsv("garbage\n"), []); // single field → skipped
});

test("formatGpuLines: single GPU, multi-GPU indexing, n/a parts, empty → []", () => {
  const one: GpuStats = { tempC: 67, utilPct: 96, memUsedGb: 14.19140625, memTotalGb: 24 };
  assert.deepEqual(formatGpuLines([one]), ["🔥 GPU: 67°C · 96% · 14.2/24.0 GB"]);
  const multi = [one, { tempC: 72, utilPct: 50, memUsedGb: 8, memTotalGb: 24 }];
  const lines = formatGpuLines(multi);
  assert.ok(lines[0].startsWith("🔥 GPU 0: 67°C"));
  assert.ok(lines[1].startsWith("🔥 GPU 1: 72°C"));
  const partial: GpuStats = { tempC: null, utilPct: null, memUsedGb: null, memTotalGb: null };
  assert.deepEqual(formatGpuLines([partial]), ["🔥 GPU: n/a · n/a · n/a/n/a GB"]);
  assert.deepEqual(formatGpuLines([]), []);
});

test("probeGpu: happy path → parsed stats; queries the documented fields", async () => {
  const seen: { cmd: string; args: string[] }[] = [];
  const fake: FakeExecFile = (cmd, args, cb) => {
    seen.push({ cmd, args });
    setTimeout(() => cb(null, "67, 96, 14532, 24576\n"), 5);
  };
  const stats = await probeGpu({ execFile: fake, platform: "linux" });
  assert.ok(stats && stats.length === 1);
  assert.equal(stats![0].tempC, 67);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, "nvidia-smi");
  assert.ok(seen[0].args.join(" ").includes("temperature.gpu,utilization.gpu,memory.used,memory.total"));
});

test("probeGpu: missing binary → undefined (linux: no fallback)", async () => {
  const fake: FakeExecFile = (_c, _a, cb) => setTimeout(() => cb(new Error("spawn ENOENT")), 5);
  assert.equal(await probeGpu({ execFile: fake, platform: "linux" }), undefined);
});

test("probeGpu: non-zero exit → undefined", async () => {
  const fake: FakeExecFile = (_c, _a, cb) => setTimeout(() => cb(Object.assign(new Error("exit 1"), { code: 1 })), 5);
  assert.equal(await probeGpu({ execFile: fake, platform: "linux" }), undefined);
});

test("probeGpu: windows PATH miss → falls back to canonical NVSMI path", async () => {
  const seen: string[] = [];
  const fake: FakeExecFile = (cmd, _a, cb) => {
    seen.push(cmd);
    if (cmd === "nvidia-smi") setTimeout(() => cb(new Error("spawn ENOENT")), 5);
    else setTimeout(() => cb(null, "58, 41, 1024, 24576\n"), 5);
  };
  const stats = await probeGpu({ execFile: fake, platform: "win32" });
  assert.deepEqual(seen, ["nvidia-smi", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"]);
  assert.ok(stats && stats[0].tempC === 58);
});

test("probeGpu: empty stdout (no devices) → undefined", async () => {
  const fake: FakeExecFile = (_c, _a, cb) => setTimeout(() => cb(null, ""), 5);
  assert.equal(await probeGpu({ execFile: fake, platform: "linux" }), undefined);
});

test("probeGpu: hanging child → timeoutMs caps the wait (defense in depth)", async () => {
  const fake: FakeExecFile = () => { /* never settles */ };
  const t0 = Date.now();
  const stats = await probeGpu({ execFile: fake, platform: "linux", timeoutMs: 40 });
  assert.equal(stats, undefined);
  assert.ok(Date.now() - t0 < 500, `resolved in ${Date.now() - t0}ms`);
});
