// System load probe for the session card (CPU + RAM).
//
// Pure Node builtins (os.cpus / os.totalmem / os.freemem) — no external
// processes, no timeouts, no dependencies. CPU utilization is a RATE, so
// `SysSampler` keeps a baseline (taken at construction) and each `sample()`
// computes the delta since the previous sample, then re-baselines: the card
// always shows "CPU since the last card render (or since startup)".
//
// RAM "used" is total − free, which counts the OS file cache as used (more
// than Task Manager's "in use"); fine for a status card.
//
// Every failure mode resolves to null fields — this module never throws.
import { cpus as osCpus, freemem as osFree, totalmem as osTotal } from "node:os";

export interface SysStats {
  /** Overall CPU utilization across all cores, rounded 0..100, or null. */
  cpuPct: number | null;
  ramUsedGb: number | null;
  ramTotalGb: number | null;
}

export type SysProbe = () => SysStats | null;

/** The per-core cumulative-time shape os.cpus() returns (subset). */
export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}
export interface Cpulike {
  times: CpuTimes;
}

const GB = 2 ** 30;

/**
 * Pure: overall CPU % across all cores between two samples
 * (1 − ΣΔidle/ΣΔtotal, rounded). `null` for an empty/invalid window —
 * never throws, never NaN.
 */
export function cpuPercent(prev: Cpulike[], next: Cpulike[]): number | null {
  if (prev.length === 0 || next.length === 0) return null;
  const sum = (cs: Cpulike[]) => {
    let total = 0;
    let idle = 0;
    for (const c of cs) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    return { total, idle };
  };
  const p = sum(prev);
  const n = sum(next);
  const dt = n.total - p.total;
  const di = n.idle - p.idle;
  if (dt <= 0) return null; // zero-length window / clock skew
  const pct = ((dt - di) / dt) * 100;
  return Number.isFinite(pct) && pct >= 0 ? Math.round(pct) : null;
}

export interface SysSamplerOptions {
  /** Injectable for tests; defaults to node:os. */
  cpus?: () => Cpulike[];
  totalmem?: () => number;
  freemem?: () => number;
}

/**
 * On-demand sampler (checked when the session card is generated): baseline at
 * construction, `sample()` returns the window since the last sample and
 * re-baselines. Never throws — a throwing probe yields all-null stats.
 */
export class SysSampler {
  private prev: Cpulike[] = [];
  private readonly cpus: () => Cpulike[];
  private readonly totalmem: () => number;
  private readonly freemem: () => number;

  constructor(opts: SysSamplerOptions = {}) {
    this.cpus = opts.cpus ?? osCpus;
    this.totalmem = opts.totalmem ?? osTotal;
    this.freemem = opts.freemem ?? osFree;
    try {
      this.prev = this.cpus();
    } catch {
      this.prev = [];
    }
  }

  sample(): SysStats {
    let next: Cpulike[] = [];
    try {
      next = this.cpus();
    } catch {
      next = [];
    }
    const cpuPct = cpuPercent(this.prev, next);
    this.prev = next;
    let ramUsedGb: number | null = null;
    let ramTotalGb: number | null = null;
    try {
      const total = this.totalmem();
      const free = this.freemem();
      if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
        ramTotalGb = total / GB;
        ramUsedGb = Math.max(0, total - free) / GB;
      }
    } catch {
      /* keep nulls */
    }
    return { cpuPct, ramUsedGb, ramTotalGb };
  }
}

/**
 * Pure renderer: ONE card line, `📊 CPU: 12% · RAM: 24.4/91.7 GB`
 * (the RAM part carries no icon — deliberate, 2026-10-18).
 * (parts omitted when null; `null` when nothing is available — including
 * for a `null` stats input).
 */
export function formatSysLine(s: SysStats | null): string | null {
  const parts: string[] = [];
  if (!s) return null;
  if (s.cpuPct !== null) parts.push(`📊 CPU: ${s.cpuPct}%`);
  if (s.ramUsedGb !== null && s.ramTotalGb !== null)
    parts.push(`RAM: ${s.ramUsedGb.toFixed(1)}/${s.ramTotalGb.toFixed(1)} GB`);
  return parts.length ? parts.join(" · ") : null;
}
