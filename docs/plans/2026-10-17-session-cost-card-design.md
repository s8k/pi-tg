# Design: session cost line on the session card

Date: 2026-10-17 · Branch: `feat/session-cost-card` (from `feat/npm-publish`)

## Goal

Show the **accumulated USD cost of the current session** on the session
(status) card, so owners using a **paid remote model** can see what the
session costs. Local-model users see no change.

## Decisions (approved in chat, 2026-10-17)

1. **Scope: current session, cumulative** — same scope as the existing
   `🪙 tokens: ↑in ↓out` line. Resets with `/new` (new session file);
   session switches show that session's own cost. Not per-turn, not
   all-time.
2. **Visibility: only when cost > $0** (option B). The line appears the
   first time a paid model has been used in the session; local sessions
   never show it. Mixed sessions show the paid turns' share.
3. **Number format: adaptive precision** (option B):
   - `≥ $1`    → `$X.XX` (2 decimals)
   - `≥ $0.01` → `$X.XXX` (3 decimals)
   - below     → `$X.XXXX` (4 decimals)
   The line is never `$0.00` once visible.
4. **Exactness: branch-scoped, all cost-bearing entry types.** Sum
   `usage.cost.total` over the **active branch** (`getBranch()` — same
   scope as the tokens line and `messageCount`), but include **every**
   entry that carries cost:
   - assistant messages (`type: "message"`, role `assistant`)
   - `type: "usage"` entries (any `kind` — cache warming, tool-reported
     usage; docs: treat unknown kinds as normal usage)
   - `compaction.usage` and `branch_summary.usage`
   This is "exact for the session you're looking at". It deliberately does
   **not** use `getEntries()` (whole file, all branches) — that would
   diverge from the tokens line's branch scope after a `/tree` branch.

## Why we compute it ourselves

- The extension API has **no session-cost getter**. `ctx.getContextUsage()`
  only covers the context window. Pi's docs point extensions to computing
  stats from `ctx.sessionManager` entries.
- The ready-made `get_session_stats` RPC command (returns `cost: 0.45`,
  "across the full session") belongs to the `pi rpc` protocol — not
  callable from an extension.
- Cost data per entry: assistant messages carry `usage.cost.total`;
  `usage` entries, `compaction` and `branch_summary` entries carry it on
  their `usage` field. Models without a catalog price (e.g. local) report
  cost 0.

## Performance

- `getBranch()` re-walks leaf→root on every call: O(n) per card render,
  n = entries on the active branch. In-memory only (no I/O) — sub-ms even
  for very large sessions.
- Adding cost changes **nothing asymptotically**: one more `if` + addition
  per entry in a walk that already happens for the tokens line.
- No caching: the card renders a handful of times per session at most
  (session start, `/new`, switch, reload); the streaming draft path never
  calls `statusBlocks()`.

## Implementation

1. **`src/wiring.ts`** — `sessionUsage()` returns `{ input, output, cost }`.
   In the existing branch walk: also sum `cost.total` from
   - assistant messages (`m.usage?.cost?.total ?? 0`),
   - `e.type === "usage"` entries (`e.usage?.cost?.total ?? 0`),
   - `compaction` / `branch_summary` entries (`e.usage?.cost?.total ?? 0`).
   (Tokens keep their current assistant-only semantics — unchanged.)
2. **`src/session-bridge.ts`** — `Pi.sessionUsage()` type gains
   `cost: number`. In `statusBlocks()`, after the tokens line: if
   `cost > 0`, push
   `{ type: "paragraph", text: `💲 cost: ${fmtUsd(cost)}` }`.
3. **New pure helper `fmtUsd(n: number): string`** next to `fmtTokens`:
   adaptive precision per decision 3, rounded at the chosen width.

## Behavior

- Local models: catalog cost 0 → line absent; card identical to today.
- Paid model used → line appears at the next card render.
  Snapshot data — no live updating (same as the tokens line).
- Mid-session model swaps: paid turns contribute, local turns $0.
- `usage` fields missing/undefined → `?? 0`; sessions with no cost data
  render exactly as today.

## Testing (TDD)

- `fmtUsd` (pure): boundaries at $0.999/$1 and $0.0099/$0.01; sub-cent
  values; exact values; rounding at the chosen width; `0` (unused, but
  defined: `$0.0000`).
- `sessionUsage` cost sum: assistant with/without `cost`; `usage` entries
  of arbitrary `kind` included; `compaction`/`branch_summary` `usage`
  included; non-assistant messages ignored; tokens unchanged.
- `statusBlocks`: cost 0 → no 💲 line; cost > 0 → line present, correct
  format, correct position (right after the tokens line).
- Smoke (fake-fetch): a "paid" assistant usage on the wire → the card
  carries the cost line.

## Out of scope (YAGNI)

- Per-turn cost; cost in the mirror's bottom line; all-time / whole-file
  totals; cost display on the `/session`-style TUI surface; live updating
  of the card while a turn runs.
