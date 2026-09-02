# /status: GPU line + new card format

Date: 2026-09-02
Branch: `feat/pi-telega-v1`

## What

`/status` gets a GPU line (temperature, utilization, VRAM) via `nvidia-smi`, and the
card switches to an emoji-labeled format:

```
🆔 Untitled session — idle
📁 dir: c:\tmp\pi-telega
🤖 model: huggingface.co/unsloth/qwen3.8-27b-gguf:UD-Q4_K_M · 🧠 thinking: medium
📖 context: 76% (92024/120000)
📨 messages: 171
🔥 GPU: 67°C · 96% · 14.2/24.0 GB
```

- Session name is plain (no bold).
- Context percent is rounded to an integer (`Math.round`).
- Multi-GPU: `🔥 GPU 0: …` / `🔥 GPU 1: …` (indexed).
- Partial data (driver reports `[N/A]`) → `n/a` in that slot.
- Probe unavailable (no nvidia-smi / no GPUs / any failure) → line omitted entirely;
  status arrives on time.

## Design

### `src/gpu.ts` (new)

- `parseGpuCsv(stdout): GpuStats[]` — pure parser for
  `--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total
  --format=csv,noheader,nounits` (one row per GPU; memory in MiB → GB).
  Rows with <4 fields are skipped; non-numeric/`[N/A]` fields → `null`; never throws.
- `formatGpuLines(stats): string[]` — pure renderer (GB via `toFixed(1)`,
  multi-GPU indexing, `n/a` for nulls).
- `probeGpu(opts?): Promise<GpuStats[] | undefined>` — `execFile("nvidia-smi", …,
  { timeout: 1500 })` (typical call ~50 ms). **Windows**: PATH first, then the
  canonical install path `C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe`.
  **Linux**: PATH. Defense in depth: the promise is raced against its own
  `setTimeout(timeoutMs).unref()` so a stuck/uncooperative execFile can never delay
  `/status` past the timeout. Every failure mode resolves `undefined`.
  Options (`timeoutMs`, `platform`, `execFile`) are injectable for tests.

### Bridge

`BridgeDeps.probeGpu` (DI, matches the `sleep`/`persist` style; `index.ts` passes the
real probe, test `makeDeps` stubs `async () => undefined`). `statusText()` is now
async: renders the five fixed lines, awaits the probe, appends GPU line(s) only when
data came back.

### Status message contract

Sent with the default `parseMode: HTML`; cwd is wrapped in `<code>…</code>` (as before);
session name/model are `escapeHtml`'d.

## Tests

`tests/gpu.test.ts` (parser: full/partial/`[N/A]`/multi-GPU/junk; renderer: formatting,
indexing, `n/a`; probe: happy path + query args, ENOENT, non-zero exit, Windows PATH
fallback, empty stdout, hanging child capped by timeout) and `tests/bridge-core.test.ts`
(exact card format incl. rounded percent, busy+muted+`n/a` variants, GPU line
single/multi/omitted).

## Verified

- `npx tsc --noEmit` clean; `node --test` 207/207.
- Live probe on an RTX 3090 (Windows): 69 ms → `🔥 GPU: 73°C · 97% · 23.7/24.0 GB`.

## Non-goals

- AMD/Intel GPU probes (YAGNI; no such hardware in scope — NVIDIA path only).
- Caching (each `/status` probes fresh; ~50 ms is negligible for a user-initiated command).
- Fan speed / power draw (could extend the query later).
