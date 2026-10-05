# md4x parser migration

Status: **in progress** (T1–T2 done) — branch `feat/md4x-parser`
(branched from `feat/rich_blocks_migration` @ `9947938`).

## Context

The blocks-tier markdown converter (`src/rich-blocks.ts`: `inlineToRichText` +
`mdToBlocks`, ~500 lines of hand-rolled regex passes + a recursive tag parser)
has proven fragile in production:

- **OOM crash (fixed in `4056434`, but symptomatic)**: a later emphasis pass
  can pair markers across an earlier pass's tag boundary → unbalanced control
  tags → `parseTagged` infinite loop → the process died on a 1.5 MB session
  transcript.
- **A second latent bug surfaced during that fix** (out-of-range stash index
  on text containing regex-source patterns) — evidence the pass architecture
  has more corners.
- Every new feature (nested lists, footnotes, math) required more bespoke
  parsing with its own edge cases.

**md4x** (unjs/md4x, MIT, v0.0.30) is a spec-compliant CommonMark+GFM parser
(C core + NAPI binding; **synchronous on Node** —
`parseAST(input, { heal? }): ComarkTree`, no `init()` needed; bare
`import { parseAST } from "md4x"` auto-selects the NAPI build). It parses the
full 1.5 MB transcript in ~23 ms (measured), scales linearly (10k stars
0.05 ms; 50k footnotes 108 ms / 38 MB), and natively handles footnotes, math,
tables, task lists, autolinks — plus a `heal` option for incomplete/streaming
markdown.

## Goal

Replace the internals of `mdToBlocks` / `inlineToRichText` with an
**md4x AST → `TgBlock` mapper**. Everything downstream of the converter stays
unchanged: `TgBlock`/`TgRichText` types, cost model (`richTextLen`/
`blocksLen`), fold/tail/chunk/plain pipeline, draft/persistent mirroring,
dialogs, the canonical footnote shape, math/anchor blocks.

## Non-goals

- No changes to the Telegram client, mirror pipeline, dialog layer, or
  session bridge.
- Public signatures keep their names: `mdToBlocks(src): TgBlock[]` and
  `inlineToRichText(src): TgRichText` stay importable (callers: mirror tail,
  narration, tool `why`/args rendering, tests). Internals swap.
- No new Telegram features (no image blocks; the HTML tier stays retired;
  entity text is still raw data — never escaped).

## Task outline

| # | Task | Notes |
|---|------|-------|
| T1 | Add `md4x` dependency | package.json + lockfile; verify the Node import picks NAPI (probe dir `/c/tmp/md4x-probe` confirms win32-x64) |
| T2 | Spike: pin remaining AST shapes | duplicate footnote defs (md4x keeps only the FIRST per id — confirmed), multiple refs to one def (refId/refCount), task lists, setext headings, ` ```math ` fences, ordered-list `start`, heal on streaming input; record results in this doc |
| T3 | Inline mapper: `ComarkNode[] → TgRichText` | TDD against the existing inline tests in `tests/rich-blocks.test.ts` |
| T4 | Block mapper: `ComarkNode[] → TgBlock[]` | TDD against existing block tests (nested lists, tables, pre, blockquote, hr, details-free) |
| T5 | Footnote mapping → canonical shape | body `footnote-ref` → `superscript(anchor + reference_link)`; `footnotes` block → `footer` block. Gate: 16 tests in `tests/rich-blocks-footnotes.test.ts` |
| T6 | Math + anchor mapping | `p > math-display` (sole child) → `mathematical_expression`; html-node paragraphs matching the anchor pattern → `anchor` block. Gate: 12 tests in `tests/rich-blocks-math-anchors.test.ts` |
| T7 | Swap internals; drafts get `heal: true` | persistent sends parse WITHOUT heal (never corrupt complete text); drafts parse WITH heal. Mirror draft path is the only heal consumer |
| T8 | Delete the old parser | emphasis passes, `parseTagged`, hand-rolled list parser, `FN_DEF_RE`/`FN_PARTIAL_RE`/`ANCHOR_LINE_RE` pre-scan, `finalizeFootnotes` (replaced by T5 mapping); update tests where behavior legitimately changes (chunk 3 lists them) |
| T9 | Perf + full suite + tsc | 1.5 MB benchmark with and without heal; all 532+ tests green; tsc clean |
| T10 | Live verification | one rich message exercising every element; a streaming draft mid-token (heal); footnotes; math; a long transcript (no OOM, per-tick cost) |

## Chunk / progress tracker

- [x] Chunk 1: header, context, goals/non-goals, task outline
- [x] Chunk 2: design — API surface, AST→TG mapping table, footnote mapping, heal strategy
- [x] Chunk 3: behavioral diffs + test strategy
- [x] Chunk 4: risks + live verification checklist
- [x] T2 spike results recorded (§4.4)

---

## Chunk 2 — Design

### 2.1 md4x API (verified against v0.0.30 in `/c/tmp/md4x-probe`)

```ts
import { parseAST } from "md4x";            // NAPI auto-selected on Node; sync
const tree: ComarkTree = parseAST(md, { heal: boolean });
// ComarkTree = { nodes: ComarkNode[]; frontmatter: Record<string,unknown>; meta: {...} }
// ComarkNode  = string | [tag: string|null, props: Record<string,unknown>, ...children]
```

- `heal: true` repairs incomplete/streaming markdown (unclosed emphasis,
  fences, tables) before parsing. **Drafts only.**
- Text nodes have HTML entities already resolved (`&amp;` → `&`); `code`,
  fenced code, math and `html` nodes keep their source bytes.
- The 1024 nesting cap: deeper content is preserved but flattened
  (`meta.maxDepthExceeded`) — not a concern at our sizes.

### 2.2 What stays / what goes

**Stays (untouched):** `TgBlock`/`TgRichText`/`TgListItem`/`TgTableCell`
types; `richTextLen`/`blocksLen`/`blockCount`; `foldBlocks`/`tailBlocks`/
`chunkBlocks`/`blocksToPlainText`; all of `src/mirror.ts` (except the heal
flag at the draft parse sites); client, dialogs, bridge.

**Goes (replaced):** the emphasis/code/link/ref regex passes; `parseTagged`;
the stack-based list parser; the line pre-scan (`FN_DEF_RE`,
`FN_PARTIAL_RE`, `ANCHOR_LINE_RE`); `finalizeFootnotes`/`literalizeRef`/
`mergeStrings` (replaced by the T5 mapping).

**Public API (kept for callers):**
- `mdToBlocks(src: string): TgBlock[]` — now `mapBlocks(parseAST(src).nodes)`
  + footnote finalization.
- `mdToBlocksHeal(src: string): TgBlock[]` — same, `heal: true` (draft path).
- `inlineToRichText(src: string): TgRichText` — now: parse `src` as a single
  paragraph (md4x on one line is a paragraph), map its inline children,
  return the merged RichText. Callers: tool `why`/state rendering, tests.
  (If any caller needs it for multi-line input, it already shouldn't —
  audit in T7.)

### 2.3 Block mapping table (`ComarkNode[] → TgBlock[]`)

| md4x node | TgBlock | Notes |
|---|---|---|
| `p` (inline children) | `paragraph` | children → `mapInline` |
| `p` whose sole child is `math-display` | `mathematical_expression` | `$$..$$` arrives wrapped in `p` (verified) |
| `p` of only `html` nodes matching `<a name="id"></a>` | `anchor` | concat the html node texts, run the existing anchor pattern |
| `h1`–`h6` | `heading` {size} | `props.id` ignored (anchors come from explicit `<a name>`) |
| `pre` {language} > `code` | `pre` {text, language} | **strip the trailing `\n`** md4x keeps in code content (verified) |
| `ul` > `li` (nested `ul`/`ol` inside `li`) | `list` {items} | item = `{ blocks: [para, nestedLists...] }`; `li` props `task`/`checked` → `has_checkbox`/`is_checked`; a list stays entirely ordered or unordered (server rule) — nested lists carry their own ordered-ness |
| `ol` {start?} > `li` | `list` {items} | each item `value` = start+i, `type: "1"` |
| `blockquote` > (blocks) | `blockquote` {blocks} | recurse the block mapper |
| `table` > `thead`/`tbody` > `tr` > `th`/`td` | `table` {cells, is_bordered: true} | row-major 2D; `th` cells get `is_header: true`; every cell is a RichText **entity object** (bare strings 400 — server-verified); empty cell → `""` object (empty content 400) |
| `hr` | `divider` | |
| `footnotes` > `footnote` | `footer` | see 2.4 |
| `html` (block-level, not the anchor case) | `paragraph` with raw text | entity data is raw — never parsed/escaped |
| `img` (inline) | literal `![alt](src)` string | no image block in `TgBlock`; matches current behavior |
| unknown tag | literal text of its descendants | fail soft, never throw |

### 2.4 Inline mapping table (`ComarkNode[] → TgRichText`)

| md4x node | TgRichText |
|---|---|
| string | string (adjacent strings merged) |
| `strong` | `bold` |
| `em` | `italic` |
| `del` | `strikethrough` |
| `mark` | `marked` |
| `code` (inline) | `code` |
| `a` {href} (incl. `autolink: true`) | `url` {text, url} |
| `sub` / `sup` | `subscript` / `superscript` |
| `footnote-ref` {id, refId} | intermediate `reference` entity (rewritten in 2.5) |
| `html` (inline) | raw text string |
| `img` | literal `![alt](src)` |
| unknown | literal text of descendants |

### 2.5 Footnote mapping (canonical shape, T5)

md4x gives us the hard part for free: the `footnotes` block is **already
numbered and ordered by first reference**; `footnote` props: `id` (the
marker number), `label`, `refCount`; body `footnote-ref` props: `id`,
`refId` (per-occurrence), `label`. Undefined refs stay literal text (no
node) — matches our GFM fallback. Duplicate definitions for one id: md4x
keeps only the **first** (verified) — a deliberate simplification vs our
current multi-def behavior; acceptable (LLMs don't redefine ids).

Mapping (same canonical shape as today, learned from the server's own
conversion — forwarded msg 1516):
1. For each body `footnote-ref` (id N, occurrence k): `superscript`
   containing `anchor` {name: `fnref-N-k`} + `reference_link` {text:
   `${N}`, reference_name: `fn-N`}.
2. The `footnotes` block → ONE `footer` block: entries
   `${N}. ` + `reference` {text: defText, name: `fn-N`} + ` ` +
   `↩`-backlink (`anchor_link` → `fnref-N-1`), all in one RichText array
   with `"\n"` between entries (the `↩` is a surrogate pair — the cost
   model already counts it as 2 units).
3. No definitions at all → no footer; refs were already literalized by
   md4x.

### 2.6 Heal strategy

- **Drafts** (`runDraftOnce` / streaming tail + committed-log re-render):
  `mdToBlocksHeal` — incomplete tokens (`**bol`, `` `` ``) render as
  finished-looking entities instead of raw markers mid-stream.
- **Persistent sends** (m1 full log, m2 final answer, plain demotion
  input): plain `mdToBlocks` — the text is complete; heal could only
  change (corrupt) final content.
- Cost: heal on a 1.5 MB log ≈ same order as parse (~25–50 ms, to be
  re-measured in T9). Draft ticks are throttled; acceptable if <~100 ms
  (else: convert committed log once at commit time and cache — decision
  deferred to T9 measurements).

---

## Chunk 3 — Behavioral diffs + test strategy

### 3.1 Behavioral diffs (old hand-rolled vs md4x)

Each diff: what changes, and the decision. "Update test" = the existing
test is amended with a comment citing the new (spec-correct) behavior.

| # | Input | Old behavior | md4x behavior | Decision |
|---|---|---|---|---|
| 1 | `||spoiler||` | `spoiler` entity | literal text (no GFM syntax for it) | **Drop support** — LLMs don't emit it; re-adding would need the placeholder hack we're removing. Update the spoiler test to expect literal |
| 2 | bare `https://a.b` | literal text | `url` entity (autolink) | **Keep** (improvement; matches Telegram's own markdown tier) |
| 3 | `title\n===` (setext) | literal paragraph + `===` line | `heading` (CommonMark-correct) | **Keep** (spec-correct) |
| 4 | `\*escaped\*` | literal incl. backslashes | `*escaped*` literal (backslash consumed, CommonMark) | **Keep** (spec-correct) |
| 5 | `[t][1]` + `[1]: url` | literal (only inline links supported) | `url` entity (CommonMark link references) | **Keep** (improvement) |
| 6 | `- [x] done` | literal `- [x]` | `li` with `has_checkbox`/`is_checked` | **Keep** (GFM task lists; Tg renders checkboxes) |
| 7 | `<!-- comment -->` | literal | stripped (CommonMark HTML comment) | **Keep** |
| 8 | duplicate `[^1]:` defs | all defs in footer, per-occurrence refIds | **first def wins**, rest dropped | **Accept simplification** (LLMs don't redefine ids); footnote tests that exercise multi-def get amended |
| 9 | `[^id: label]` | literal | literal (pandoc extension, not GFM) | unchanged |
| 10 | trailing `  \n` (hard break) | `\n` kept in paragraph text | hard break — **T2 spike: confirm AST shape** (separate text node vs `\n`); map to `\n` in the RichText string to keep today's rendering | keep rendering, verify shape |
| 11 | YAML frontmatter at doc start | divider + paragraphs | parsed as frontmatter (suppressed from `nodes`) | **Accept** (LLMs don't emit it; if it ever bites, prepend as literal text — note in T2) |
| 12 | `$$..$$` mid-paragraph vs whole line | whole-line only (old pre-scan) | display math wherever it's a paragraph child | **Keep md4x's** (superset; our tests use whole-line) |
| 13 | inline `$x$` (if md4x supports it) | literal | **T2 spike** — if md4x emits an inline math node: no Tg inline-math entity exists → map to literal source text | decide in T2 |
| 14 | `**a * b** * c * d**` (cross-boundary emphasis) | OOM (now: degraded literal) | CommonMark-correct: bold + italic + literal `**` | **Keep** (the regression test still guards: terminates, no control chars, content preserved) |
| 15 | `<a name="id"></a>` on own line | `anchor` block (regex pre-scan) | `p` of two `html` nodes → same mapping (2.3) | unchanged, different mechanism |

### 3.2 Test strategy

**The existing suite is the acceptance gate** (~130 converter tests):
- `tests/rich-blocks.test.ts` — inline entities, cost model, blocks, lists,
  tables, fold/tail/chunk (cost/pipeline tests are parser-independent and
  must pass untouched).
- `tests/rich-blocks-footnotes.test.ts` — 16 canonical-shape tests.
- `tests/rich-blocks-math-anchors.test.ts` — 12 tests.
- `tests/mirror-*.test.ts` — pipeline-level (mostly parser-independent;
  they build LogBlocks and assert TgBlock output).

**TDD rhythm per task (T3–T6):** the relevant existing tests are written
*before* the mapper exists (they fail on the old impl's removal or on the
new impl's absence) — in practice: implement the mapper behind the same
export, run the suite; a red test is either (a) a mapper bug → fix mapper,
or (b) an intended diff from 3.1 → amend the test with a citing comment.
No test may be deleted; only amended where 3.1 says so.

**New tests to add:**
- autolink entity; CommonMark escapes; setext heading; task list checkboxes;
  link references; HTML comment stripping; unknown-node fail-soft; `pre`
  trailing-newline strip; `ol` with `start: 5` → values 5,6,7.
- heal: `**unterminated` → bold (draft); same input WITHOUT heal → literal
  (persistent parity with old "unmatched markers stay literal").
- perf guard (T9): 1.5 MB parse < 200 ms with heap < 200 MB (node:assert in
  a test marked `.skip` on CI-less boxes? no — just keep it fast: it's ~25 ms).

**Ordering:** T3 (inline) and T4 (block) can land behind the old impl
(exports still point at old code); T7 flips the pointer; T8 deletes the old
code. Between T7 and T8 the suite must be fully green — that's the gate
that the mapper is behaviorally equivalent (modulo 3.1).

---

## Chunk 4 — Risks + live verification

### 4.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| md4x is young (0.0.x) — API churn | med | low | **Pin exact version** in package.json (no caret); the converter is isolated behind two exports — reverting = restoring the old code from git history (`9947938^`) |
| Behavioral drift vs the old parser | high (by design) | low | chunk-3 diff table + the full test gate + live matrix (T10) |
| NAPI binary for the runtime platform | low (win32-x64 verified) | high | the package ships prebuilt binaries for win32/darwin/linux x64+arm64 (verified file list); no build step; T1 smoke-imports on the bot's machine |
| `heal` produces odd output on pathological streaming prefixes | med | low (drafts only) | drafts are transient; 400 → 60 s cooldown unchanged; persistent sends never heal |
| Draft re-render cost at large logs (parse+heal per tick) | med | med | T9 measures the 1.5 MB case; fallback: convert the committed log once at commit time and cache the `TgBlock[]` on the narration LogBlock (keeps per-tick cost constant) |
| Footnote edge semantics (dup defs, multi-ref) | low | low | T2 pins the AST; canonical shape unchanged; 16-test gate |
| md4x parses constructs the LLM emits that we never render (frontmatter, raw html blocks) | low | low | fail-soft: unknown → literal text; frontmatter suppressed (3.1 #11) |

### 4.2 Live verification checklist (T10, owner-verified)

1. **Full-element message**: heading; bold/italic/strike/marked/code; link +
   autolink; unordered + ordered (`start > 1`) + task + **nested** lists;
   bordered table with distinct header row; blockquote; fenced pre with
   language; divider; footnote (defined ref + undefined ref literal);
   `$$math$$`; `<a name>` anchor — rendered in the owner's Telegram,
   element by element.
2. **Streaming draft**: a real multi-tool task — the tail heals mid-token
   (no raw `**`/` ``` ` flicker), the committed narration section shows
   formatted markdown (the `3e9ce51` fix), spinner stays last.
3. **Long transcript**: the 1.5 MB session at full level — no OOM, heap
   < 200 MB, per-tick parse+heal < ~100 ms (T9 numbers attach here).
   T9 MEASURED (2026-10-07, this machine): 1.5 MB mixed doc → 130 ms
   no-heal / 132 ms heal, heap +11–20 MB (old parser: 158 ms on the same
   doc — md4x is 22% faster AND can't hit the old parser's catastrophic
   unbalanced-input OOM); 10k `**bold**` runs → 12 ms; 50k footnotes
   (1.6 MB) → 172 ms, +60 MB (linear).
4. **Footnote canonical shape**: forward the bot's footnote message back;
   the incoming `rich_message` blocks match the server's own shape
   (superscript anchor+reference_link in the body; `footer` block with
   numbered `reference` entries) — same as msg 1516.
5. **Plain demotion**: a persistent send that 400s falls back to plain text
   that includes the converted narration content.
6. **Draft 400 cooldown** unchanged (only if cheap to trigger).

### 4.3 Exit criteria

- [ ] `md4x` pinned in package.json; T1 import smoke on the bot's machine
- [ ] T2 spike results recorded in this doc (open items resolved)
- [ ] 532+ tests green (amendments only per 3.1, each cited), tsc clean
- [ ] old parser code deleted (T8); no dead imports
- [ ] T9 perf numbers recorded
- [ ] live checklist items 1–4 owner-verified (5–6 if triggered)
- [ ] this doc's status → done; merge plan: `feat/md4x-parser` →
      `feat/rich_blocks_migration` (or → `main` once that branch merges)

### 4.4 T2 spike results (2026-10-07, md4x 0.0.30) — all open items resolved

1. **Hard breaks**: two-trailing-spaces → `br` node (empty element) → map to
   `"\n"`. Soft break = literal `\n` inside the text string (unchanged).
   **md4x quirk**: backslash-EOL becomes literal `\` + `n` (newline
   swallowed, verified by char codes) instead of a `br`. Workaround:
   stateless pre-scan `src.replace(/\\\n/g, "  \n")` before `parseAST`
   (one regex, no state — not the kind of pass we're removing).
2. **Inline math EXISTS**: `$x$` → `["math",{},expr]`. No inline-math entity
   in `TgRichText` → map to literal `$expr$` string (preserves source;
   matches old literal behavior). (Resolves 3.1 #13.)
3. **` ```math ` fence is NOT math-display** — it's a plain `pre` with
   `language: "math"`. Mapper: `pre` with `language === "math"` →
   `mathematical_expression` (strip the trailing `\n` md4x keeps in code
   content). Same end result as the old converter — tests stay green.
4. **Ordered lists**: `props.start` present only when > 1; `li` carries no
   value → mapper computes `value = (start ?? 1) + i`, `type: "1"`.
5. **Frontmatter**: confirmed suppressed from `nodes`; available as
   `tree.frontmatter` / `tree.meta.title` (we ignore both — 3.1 #11 stands).
6. **heal**: unclosed fence → `pre` **even without heal** (CommonMark: fence
   runs to EOD — spec, not heal); unclosed table [heal] → padded with empty
   `td` nodes (the empty-cell rule below handles them); half `**` → closed
   `strong` [heal] vs literal (no heal) ✓; half `$$` → `math-display` [heal] ✓.
7. **Multiple refs to one def**: `refId` = 1..n per body occurrence, `refCount`
   = n, ONE `footnote` entry in the `footnotes` block ✓. `[^id: label]` →
   literal (pandoc extension) ✓. `label` prop = the user's source label; `id`
   = the assigned number. The canonical mapping uses `id` (number) — same as
   today (`reference_link` text = the number, not the label).

**Refined table-cell rule (mapper MUST replicate the current wrap logic —
spike-pinned 2026-10-05):** header plain cell → `bold` entity +
`is_header: true`; body plain cell → `code` entity; a cell that maps to a
single pure entity passes through (entities keep their own type, header adds
`is_header`); a cell mapping to an ARRAY (mixed content) is WRAPPED in the
plain entity (`{type: "code", text: ["x ", bold]}` — whole cell monospace);
empty cell ("" or zero-length) → `" "` single space (empty entity 400s).

**Refined canonical footnote mapping (T5):** body `footnote-ref {id: N,
refId: k}` → `superscript[anchor{fnref-N-k}, reference_link{String(N),
fn-N}]`; `footnotes` block → one `footer`: per `footnote {id: N}` →
`"${N}. "` + `reference{mapInline(defChildren), fn-N}` + `" "` +
`anchor_link{"↩", fnref-N-1}`, entries `"\n"`-prefixed (merged into the
next entry's prefix string, per msg 1516). Def children are already parsed
inline nodes — no re-parse needed (old code re-ran `inlineToRichText` on the
definition text; same result). Undefined refs need no handling: md4x leaves
them as literal text (no node). No refs → no footer (md4x omits the
`footnotes` block entirely).
