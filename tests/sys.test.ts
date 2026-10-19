// System load probe (CPU + RAM) for the session card. Pure Node builtins
// (os.cpus / os.totalmem / os.freemem) — no processes, no timeouts, no deps.
// CPU % is a DELTA: utilization is a rate, so each sample compares against
// the previous one (plugin load / last card render).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuPercent, formatSysLine, SysSampler, type Cpulike, type SysStats } from "../src/sys.ts";

const cpu = (user: number, sys: number, idle: number, irq = 0, nice = 0) =>
  ({ times: { user, nice, sys, idle, irq } });

test("cpuPercent: busy fraction of the window (single core)", () => {
  // 100ms busy + 100ms idle in the window → 50%
  assert.equal(cpuPercent([cpu(100, 100, 1000)], [cpu(150, 150, 1100)]), 50);
  // all idle → 0
  assert.equal(cpuPercent([cpu(0, 0, 1000)], [cpu(0, 0, 2000)]), 0);
  // all busy → 100
  assert.equal(cpuPercent([cpu(0, 0, 0)], [cpu(100, 50, 0)]), 100);
});

test("cpuPercent: sums across cores (two cores, one fully busy → 50%)", () => {
  const prev = [cpu(0, 0, 0), cpu(0, 0, 0)];
  const next = [cpu(100, 0, 0), cpu(0, 0, 100)];
  assert.equal(cpuPercent(prev, next), 50);
});

test("cpuPercent: empty window / bad input → null (never throws, never NaN)", () => {
  assert.equal(cpuPercent([cpu(1, 1, 1)], [cpu(1, 1, 1)]), null); // zero-length window
  assert.equal(cpuPercent([], [cpu(1, 1, 1)]), null);
  assert.equal(cpuPercent([cpu(1, 1, 1)], []), null);
  // clock skew: totals went backwards
  assert.equal(cpuPercent([cpu(1000, 1000, 1000)], [cpu(0, 0, 0)]), null);
});

test("SysSampler: first sample = window since construction; re-baselines each sample", () => {
  const seq: Array<{ user: number; sys: number; idle: number }> = [
    { user: 0, sys: 0, idle: 0 },      // construction baseline
    { user: 500, sys: 0, idle: 500 },  // window 1: 500/1000 → 50%
    { user: 800, sys: 0, idle: 700 },  // window 2: 300/500… 300 busy, 200 idle → 60%
  ];
  let i = 0;
  const s = new SysSampler({
    cpus: () => [cpu(seq[i].user, seq[i].sys, seq[i].idle)],
    totalmem: () => 8 * 2 ** 30,
    freemem: () => 6 * 2 ** 30,
  });
  i = 1;
  assert.deepEqual(s.sample(), { cpuPct: 50, ramUsedGb: 2, ramTotalGb: 8 });
  i = 2;
  assert.deepEqual(s.sample(), { cpuPct: 60, ramUsedGb: 2, ramTotalGb: 8 });
});

/** Probe that returns seq[i] on call i (clamped at the last entry): call 0 = construction baseline. */
const stepping = (seq: Cpulike[][]) => {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)]!;
};

test("SysSampler: zero totalmem → RAM nulls; free>total clamps used to 0; probes that throw → all null (never throws)", () => {
  const s1 = new SysSampler({
    cpus: stepping([[cpu(0, 0, 0)], [cpu(1, 0, 1)]]), // construction, sample → 50%
    totalmem: () => 0,
    freemem: () => 0,
  });
  assert.deepEqual(s1.sample(), { cpuPct: 50, ramUsedGb: null, ramTotalGb: null });

  const s2 = new SysSampler({
    cpus: stepping([[cpu(0, 0, 0)], [cpu(1, 0, 1)]]),
    totalmem: () => 4 * 2 ** 30,
    freemem: () => 5 * 2 ** 30,
  });
  assert.equal(s2.sample().ramUsedGb, 0);

  const s3 = new SysSampler({
    cpus: () => { throw new Error("boom"); },
    totalmem: () => { throw new Error("boom"); },
    freemem: () => { throw new Error("boom"); },
  });
  assert.deepEqual(s3.sample(), { cpuPct: null, ramUsedGb: null, ramTotalGb: null });
});

test("formatSysLine: combined / single-part / none", () => {
  const full: SysStats = { cpuPct: 12, ramUsedGb: 24.4, ramTotalGb: 91.7 };
  assert.equal(formatSysLine(full), "🧮 CPU: 12% · 🧾 RAM: 24.4/91.7 GB");
  assert.equal(formatSysLine({ cpuPct: 12, ramUsedGb: null, ramTotalGb: null }), "🧮 CPU: 12%");
  assert.equal(formatSysLine({ cpuPct: null, ramUsedGb: 24.4, ramTotalGb: 91.7 }), "🧾 RAM: 24.4/91.7 GB");
  // a half-RAM (used without total) renders nothing for the RAM part
  assert.equal(formatSysLine({ cpuPct: null, ramUsedGb: 24.4, ramTotalGb: null }), null);
  assert.equal(formatSysLine({ cpuPct: null, ramUsedGb: null, ramTotalGb: null }), null);
});
