# Changelog — 2026-10-08 (blocks tier + md4x migration)

Branch `feat/rich_blocks_migration`, 39 commits ahead of `main`
(head `370048f`; 596/596 tests green, tsc clean).

## md4x parser migration (the big one)

The hand-rolled markdown→blocks converter (regex passes + a recursive tag
parser, ~500 lines) is **replaced by md4x 0.0.30** (NAPI, CommonMark+GFM
spec-compliant, linear-time). Plan: `docs/plans/2026-10-07-md4x-parser-migration.md` (done).

- `src/md4x-mapper.ts` — AST → `TgBlock[]` mapper (inline entities, lists,
  tables, footnotes in the canonical shape, display math, anchors)
- `src/rich-blocks.ts` 1009 → 498 lines — types, cost model, pipeline only
- Drafts parse in-flight text with `heal: true` (half-typed constructs
  close); persistent sends never heal
- Draft-only `sanitizeDraftTail`: strips the two streaming-edge artifacts
  heal leaves literal (trailing lone backtick → doubled "``"; half-typed
  closing `**bold *`) — no more marker flicker in the draft
- Live-verified element by element (msgs 1544–1554); the forwarded-back
  footnote message round-trips byte-for-byte in the server's canonical shape

## Message-size caps (mobile client freezes)

Mobile Telegram re-lays out the whole message on every draft edit — the old
32k-per-message worst case was freezing the client.

- `RICH_CAP` 32k → **16k** (persistent messages; single source of truth for
  `tailBlocks`/`chunkBlocks` + the finalize chunking)
- `DRAFT_TAIL_CAP` **8k** (new): the repeatedly-edited draft tail is capped
  lower; overflow truncates the oldest content (the in-flight answer stays
  fully visible)

## Router: R9 — incoming rich messages

A forwarded rich message carries `rich_message` blocks and **no `text`**
field — the router used to silently drop it. Now the blocks are projected
through `blocksToPlainText` and routed like any text (commands, dialog
answers, auth rules all apply).

## Experiment: uncollapsed tool calls in the live draft (REVERTED 2026-10-11)

While streaming, tool calls render as a plain `⚙ name state` line with the
**visible args pre** below (no collapsible container). The finalized
persistent send keeps the collapsed `details` form — the run "tidies up"
on completion. One commit (`370048f`) — instant to revert.

**Reverted (2026-10-11):** tool calls now ALWAYS use the collapsed
details form, in both the live draft and the finalized send.

## Earlier in the branch (blocks tier)

- Blocks-tier mirroring (replaces the markdown + HTML tiers, both retired)
- Canonical footnote markers (`superscript` anchor + reference_link,
  `footer` block with `reference` entries) — live-verified
- Display math (`$$…$$`, ` ```math ` fences) and `<a name>` anchors
- Nested GFM lists, bordered tables with header rows, task lists
- Streaming fixes: single-draft flow, list marker-type splits, one-shot
  dialog buttons, answer-callback anti-flicker
- Narration is converted (not raw); `parseTagged` OOM regression fixed
  (superseded by md4x, which cannot hit it)
