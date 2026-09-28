// GPU temperature probe for /status (NVIDIA, via nvidia-smi).
//
// Works on Windows (PATH + canonical NVSMI install fallback) and Linux (PATH).
// Every failure mode — missing binary, driver error, timeout, unparseable
// output — resolves `undefined`; this module never throws and never blocks
// /status for more than `timeoutMs`.
import { execFile } from "node:child_process";

export interface GpuStats {
  tempC: number | null;
  utilPct: number | null;
  memUsedGb: number | null;
  memTotalGb: number | null;
}

/** The status card's GPU line(s) for the probed stats ("" for none). */
export type GpuProbe = () => Promise<GpuStats[] | undefined>;

const WIN_NVSMI_FALLBACK = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
const QUERY_ARGS = [
  "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];

export const DEFAULT_PROBE_TIMEOUT_MS = 1500; // typical call is ~50 ms

/** Pure CSV parser: one row per GPU, in the order of QUERY_ARGS fields. */
export function parseGpuCsv(stdout: string): GpuStats[] {
  const field = (raw: string | undefined): number | null => {
    const t = (raw ?? "").trim();
    if (t === "" || t === "[N/A]" || /^n\/?a$/i.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const toGb = (mib: number | null): number | null => (mib === null ? null : mib / 1024);
  const out: GpuStats[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 4) continue; // malformed row — skip, never throw
    out.push({
      tempC: field(f[0]),
      utilPct: field(f[1]),
      memUsedGb: toGb(field(f[2])),
      memTotalGb: toGb(field(f[3])),
    });
  }
  return out;
}

/** Pure renderer: one card line per GPU, indexed when multiple. */
export function formatGpuLines(stats: GpuStats[]): string[] {
  if (stats.length === 0) return [];
  const multi = stats.length > 1;
  const gb = (v: number | null) => (v === null ? "n/a" : v.toFixed(1));
  return stats.map(
    (s, i) =>
      `🔥 GPU${multi ? ` ${i}` : ""}: ` +
      `${s.tempC !== null ? `${s.tempC}°C` : "n/a"} · ` +
      `${s.utilPct !== null ? `${s.utilPct}%` : "n/a"} · ` +
      `${gb(s.memUsedGb)}/${gb(s.memTotalGb)} GB`,
  );
}

interface ProbeOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to child_process.execFile. */
  execFile?: (cmd: string, args: string[], cb: (err: Error | null, stdout?: string) => void) => void;
}

/**
 * Probe all GPUs. Returns parsed stats, or `undefined` when the probe is
 * unavailable (no nvidia-smi, no GPUs, probe failed/timed out).
 */
export function probeGpu(opts: ProbeOptions = {}): Promise<GpuStats[] | undefined> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const run =
    opts.execFile ??
    ((cmd, args, cb) =>
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => cb(err ?? null, stdout)));
  const candidates = ["nvidia-smi", ...(platform === "win32" ? [WIN_NVSMI_FALLBACK] : [])];
  const attempt = async (i = 0): Promise<GpuStats[] | undefined> => {
    if (i >= candidates.length) return undefined;
    const stdout = await new Promise<string | undefined>((resolve) => {
      try {
        run(candidates[i], QUERY_ARGS, (err, out) => resolve(err ? undefined : (out ?? "")));
      } catch {
        resolve(undefined); // synchronous spawn failure
      }
    });
    if (stdout === undefined) return attempt(i + 1); // missing binary → try next candidate
    // Rows whose fields are ALL null (nvidia-smi present but the driver
    // reports nothing — e.g. [N/A] values) carry no data: drop them, and if
    // nothing usable is left the probe is unavailable (no GPU line at all).
    const usable = parseGpuCsv(stdout).filter(
      (s) => s.tempC !== null || s.utilPct !== null || s.memUsedGb !== null || s.memTotalGb !== null,
    );
    return usable.length > 0 ? usable : undefined; // no devices / no data → unavailable (no fallback)
  };
  // execFile's `timeout` kills the child; the race is defense in depth so a
  // stuck/uncooperative execFile can never delay /status past timeoutMs.
  return Promise.race([
    attempt(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs).unref()),
  ]);
}
