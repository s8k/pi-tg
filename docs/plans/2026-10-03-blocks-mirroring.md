# Blocks-Tier Mirroring Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.
> **Status:** done (2026-10-06) — all 10 tasks implemented; live matrix complete except item 9.2-5 (auto-compact lane 2, pending owner test).

**Goal:** Replace the markdown-tier rich mirroring with the Telegram Bot API `blocks` tier: the mirror's block-shaped state model (`LogBlock[]` + streaming `tail` + `BottomLine`) renders directly to an explicit `InputRichBlock[]` array for both the live draft and the persistent sends, eliminating the "markdown string is re-parsed by Telegram" round trip and the whole bug class it creates (unclosed streaming fence swallowing the `<tg-thinking>` bottom line into a `<pre>` block).

**Architecture (target):** new pure module `src/rich-blocks.ts` holds (a) TypeScript types for the blocks-tier subset we use, (b) the inline converter `inlineToRichText(md) → RichText`, (c) the block-level converter `mdToBlocks(md) → TgBlock[]` (reusing the `richUnits` skeleton), (d) the blocks-side pipeline replacements for `tailView`/`foldLongFences`/`chunkRich` (block-array in, block-array out, with a rendered-length cost model). `mirror.ts` gains `blocksToBlocks()` replacing `blocksToMd()` — the work log, tool blocks (`details`+`pre`), dividers and the thinking bottom line become native blocks; the draft and the persistent m1/m2 sends carry `rich_message: { blocks }`. The persistent chain is `blocks → plain` — **BOTH legacy fallback tiers (markdown and HTML) are retired in this feature**: on a 400, the affected chunk and all remaining chunks demote to plain text (which cannot 400 on content). There is NO md twin: `content()` returns blocks only, so there is a single renderer and nothing to drift. The entire markdown-string pipeline (`blocksToMd`, `renderToolBlock`, `foldLongFences`, `chunkRich`, `tailView`, `toPlainText`, the legacy HTML converter) is mirror-internal (grep-verified: every consumer is inside `mirror.ts`) and is removed in Task 9. (The other `parse_mode: HTML` uses — small bot-generated strings in ui-dialogs/wiring — are a different mechanism, untouched.)

**Tech Stack:** TypeScript (Node ≥ 22.18, native TS type-stripping), `node:test`, no new dependencies. Source of truth for the API: live Bot API docs (read 2026-10-03, facts pinned in the section below).

**Verification (every task ends with):** `npx tsc --noEmit` (expect: no output) + `node --test` (expect: `# fail 0`).

**Branch:** `feat/rich_blocks_migration` (active 2026-10-04, branched from main @ 842eee8).

## Spike results (Task 0 — done 2026-10-04, live bot, PC client)

All probes sent via throwaway scripts (deleted after); results below pin the design. Items with ⚠️ change plan assumptions.

1. **`thinking` block in draft** — ✅ renders with native shimmer; full label incl. token suffix (`Pondering… ↑567 ↓1.2k`) visible, no clipping. R7 closed.
2. **`thinking` block in persistent send** — ✅ `400 RICH_MESSAGE_BLOCK_UNSUPPORTED`. Strip-at-finalization rule is HARD, confirmed server-side.
3. **Link entity shape** — ✅ `{ type: "url", text: RichText, url: String }` renders a clickable link (owner-verified in client). ⚠️ `url`+`href` 400s (`Can't find field "url"`); `anchor_link` is for internal anchors (requires `anchor_name`). **Task 2 link branch: `{type:"url", text, url}`.** R1 closed.
4. **Auto entity detection** — ✅ server linkifies bare URL and bare email in `paragraph` text (echo shows injected `url`/`email_address` entities); `pre` text stays plain. Same as markdown tier → NO `skip_entity_detection` needed anywhere.
5. **400 semantics** — empty `details.blocks` → `400 RICH_MESSAGE_CONTENT_REQUIRED`; 33k chars → `400 RICH_MESSAGE_TEXT_TOO_LONG`; 501 top-level paragraphs → `400 RICH_MESSAGE_BLOCKS_TOO_MANY`. ⚠️ **A 501-item `list` is ACCEPTED (200)** — the server counts the list as ONE block, NOT per-item, despite the docs wording. Our conservative `blockCount` (counts items) stays — extra-safe, occasionally over-chunks. R4: limit is per-message, top-level counting; `chunkBlocks` budgets 480 top-level blocks.
6. **Draft animation** — ⚠️ key operational rule (owner-verified): **smooth typing animation requires MODIFYING the last block's text (appending), NOT adding new blocks per update.** Live test: 25 sequential `sendRichMessageDraft` (same `draft_id: 7`) appending words to ONE paragraph + stable `thinking` block → smooth typing animation; structural changes → jump. **Design constraint for Task 6:** `tailBlocks` output must keep a STABLE block structure across ticks — the streaming tail grows in place as the LAST block(s); new blocks only appear on real structural shifts (new fence/heading/paragraph boundary). Matches the suffix design, but the draft-send path must not re-order or re-shape stable blocks between ticks.
7. **Client rendering baseline** — ✅ all shapes render: heading, inline entities (bold/italic/code/strikethrough/marked/spoiler), `pre`+language, closed `details` with `pre` inside, `divider` (client draws it like a double line — cosmetic, single block), checkbox list, `details is_open:true` expands by default. ⚠️ **Ordered lists: `value` alone renders bullets; `type: "1"` (+`value`) renders `1. 2. 3.`** (server echo `label: "1."`); `type: "i"` → roman. **Task 3: ordered lists set `type: "1"` on each item.**
8. **⚠️ Table cells (extra probe)** — `cells` must be **RichText entity OBJECTS**: bare strings and string arrays 400 (`RichBlockTableCell must be an object`); entity objects accepted (server normalizes to `{text, align:"left", valign:"middle"}`). **Plain cells must be wrapped in a benign entity — DECISION: wrap bare-string cell text in `{type: "code", text}` (monospace-in-cells acceptable; revisit if ugly).** **Borders: `is_bordered: true` REQUIRED for visible borders** (default = borderless aligned text, looked broken). **Task 3: GFM tables emit `is_bordered: true` + entity-wrapped cells.**

**Plan adjustments from spike:** (a) Task 2 link branch pinned to `{type:"url",text,url}`; (b) Task 3: ordered lists `type:"1"`+`value`, tables `is_bordered:true` + entity-wrapped cells; (c) Task 6: draft structure-stability rule (item 6); (d) `TgBlock.table` gains `is_bordered?: boolean`; cells stay `TgRichText[][]` in the type, the mdToBlocks cell emitter does the entity-wrapping (Task 3). Everything else as planned.

---

## Chunk outline

- [x] 1. Header + live API facts (2026-10-03 read)
- [x] 2. Target architecture — types, converter design, cost model, mirror rework, senders
- [x] 3. Delivery pipeline — chunking (32k + 500 blocks), tail view, fold, fallback chain
- [x] 4. Implementation tasks (TDD, spike first)
- [x] 5. Risks, open questions, non-goals

---

## Live API facts (core.telegram.org/bots/api, read 2026-10-03)

**`InputRichMessage`** — exactly ONE of:
- `blocks: Array of InputRichBlock` — "Content of the rich message to send described as a list of blocks"
- `html: String`
- `markdown: String`

Plus (common to all tiers): `media` (array, `tg://photo|video|document|audio?id=` links), `is_rtl: Boolean?`, `skip_entity_detection: Boolean?` ("Pass True to skip automatic detection of entities (URLs, email addresses, username mentions, hashtags, cashtags, bot commands, phone numbers, bank card numbers)").

**`InputRichBlock` union — the types we will use** (full union also has `map`, `buttons`, `collage`, `slideshow`, media blocks `animation|audio|document|photo|video|voice_note`, `anchor`, `expandable_blockquote`, `pullquote`, `mathematical_expression`):

| type | fields | notes |
|---|---|---|
| `paragraph` | `text: RichText` | `<p>` |
| `heading` | `text: RichText`, `size: 1-6` | `<h1>`…`<h6>`, 1 = largest |
| `pre` | `text: RichText`, `language: String?` | nested `<pre><code>`; **explicit language** |
| `footer` | `text: RichText` | `<footer>` |
| `divider` | — | `<hr/>` — native divider block (replaces our `---`/`────────` strings) |
| `list` | `items: Array of InputRichBlockListItem` | `<ul>`/`<ol>` |
| `InputRichBlockListItem` | `blocks: Array of InputRichBlock`, `has_checkbox?`, `is_checked?`, `value?: Integer` (ordered), `type?: "a"|"A"|"i"|"I"|"1"` (ordered label type) | items contain **nested blocks**, not text |
| `blockquote` | `blocks: Array of InputRichBlock`, `credit?: RichText` | `<blockquote>` |
| `table` | `cells: Array of Array of RichBlockTableCell`, `is_bordered?`, `is_striped?`, `is_compact?`, `caption?: RichText` | 2D cells; **no alignment field** |
| `details` | `summary: RichText`, `blocks: Array of InputRichBlock`, `is_open?: True` | native expandable — replaces `foldLongFences` string hack |
| `thinking` | `text: RichText` | **draft-only**: "may be used only in `sendRichMessageDraft`, therefore it can't be received in messages" — the native `<tg-thinking>` shimmer as a block |

**`RichText`** (all block text fields) — a union: `String` (plain text) | `Array of RichText` | entity object `{ type, text: RichText, … }`. Entity types: `bold`, `italic`, `underline`, `strikethrough`, `spoiler`, `date_time`, `text_mention`, `subscript`, `superscript`, `marked`, `code`, `custom_emoji`, `mathematical_expression`, `url`, `email_address`, `phone_number`, `bank_card_number`, `mention`, `hashtag`, `cashtag`, `bot_command`, `button`, `anchor`, `anchor_link`, `reference`, `reference_link`. Nesting is recursive (`text: RichText` inside each entity).

**Limits (Rich Message Limits section):** up to **32768 UTF-8 characters** in the rich message text (incl. custom-emoji alt text and formula source); up to **500 blocks, INCLUDING nested blocks, list items, ordered list items, table rows, quotation blocks, and details blocks**; up to **16 nesting levels**; 50 media; 20 table columns.

**Methods:** `sendRichMessage(chat_id, rich_message, …)`; `sendRichMessageDraft(chat_id, draft_id, rich_message, can_stop?)` — draft is ephemeral ~30 s preview, same `draft_id` = animated, different = replaced without animation. Any message sent to the chat clears the ephemeral draft (owner-verified). ⚠️ Updated 2026-10-05: the API was restructured — `sendMessage` no longer accepts `rich_message`; `sendRichMessage`/`sendRichMessageDraft` are the canonical methods (our client already uses them exclusively).

**Markdown-tier notes (for the fallback tier, read for contrast):** GFM-compatible + arbitrary inline HTML; "Markdown isn't parsed inside block HTML tags other than `<details>`, `<tg-collage>` and `<tg-slideshow>`"; table cells accept inline formatting only; the `<tg-thinking>` tag works there too (spike-verified 2026-08-31).

**Consequences pinned by the docs (drive the design):**
1. `thinking` block exists → the draft UX survives the migration. It is **draft-only** — the finalized/persistent path must never emit it (today's code already strips the spinner at finalization; the rule carries over).
2. Block text is a structured `RichText`, NOT a markdown string → we must own inline conversion for paragraph/heading/summary/credit text (new `inlineToRichText`). `pre` text is plain (code — no inline parsing; a plain `String` suffices).
3. The 32768 cap counts **rendered text** (established for the markdown tier by spike 2026-08-31: rendered ≤ source). For blocks the cost is directly computable: sum of plain-text lengths of all `RichText` leaves → exact cost model, no source-vs-rendered margin guessing.
4. The 500-block cap **counts list items, table rows and nested blocks** → chunking must count items, not just top-level blocks.
5. No block type for footnotes, and no table alignment → converter degrades those to plain (documented limitation, same as today's legacy limits).
6. Auto entity detection applies to block text too (URLs/emails in a `paragraph` get linkified unless `skip_entity_detection`); `pre` blocks are explicit → no detection inside code.

---

## Target architecture

### New module `src/rich-blocks.ts` (pure, no I/O)

**Types** (subset of the live API; named to mirror the Bot API so payload assembly is a pass-through):

```ts
// RichText: plain string | sequence | entity. Recursive, per the live docs.
export type TgRichText =
  | string
  | TgRichText[]
  | { type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "marked" | "code"; text: TgRichText }
  | { type: "url"; text: TgRichText; href: string }          // [t](url) → anchor_link? SPIKE: confirm entity name/shape
  | { type: "subscript" | "superscript"; text: TgRichText };

// The blocks we emit (InputRichBlock subset).
export type TgBlock =
  | { type: "paragraph"; text: TgRichText }
  | { type: "heading"; text: TgRichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "pre"; text: string; language?: string }
  | { type: "divider" }
  | { type: "list"; items: TgListItem[] }
  | { type: "blockquote"; blocks: TgBlock[] }
  | { type: "table"; cells: TgRichText[][] }
  | { type: "details"; summary: TgRichText; blocks: TgBlock[]; is_open?: boolean }
  | { type: "thinking"; text: TgRichText };                 // draft-only

export interface TgListItem { blocks: TgBlock[]; has_checkbox?: boolean; is_checked?: boolean; value?: number; type?: "a" | "A" | "i" | "I" | "1"; }
```

**SPIKE GATE (blocks Task 0):** the link entity's exact `type` string and field names (`anchor_link` vs `url` vs `button`-with-URL) are not fully pinned by the object tables we extracted — confirm with a throwaway-bot send in Task 0 before writing `inlineToRichText`'s link branch. Everything else above is doc-pinned.

**`inlineToRichText(line: string): TgRichText`** — the inline half of today's `inlineToHtml`, retargeted: same source constructs (`code` spans, `[t](url)`, `**b**`, `__b__`, `*i*`, `_i_`, `~~s~~`, plus the rich-markdown additions `==marked==`, `||spoiler||` — cheap to add since we're writing a parser anyway), same guarantees (balanced output, unmatched markers stay literal, code-span content verbatim). Output is nested `TgRichText`; plain text leaves are returned as bare `string`s (the API accepts them). Implementation note: build with the same stash/placeholder discipline as `inlineToHtml` (code spans first, then links, then emphasis outer→inner) so the existing edge-case expectations in `tests/markdown.test.ts` carry over almost verbatim as new assertions.

**`mdToBlocks(md: string): TgBlock[]`** — block-level converter. Reuses the `richUnits()` skeleton (fence/table/heading/list/blockquote/hr/details/paragraph recognition) and maps:
- fence → `pre` with `language` from the info string; **an unclosed fence (streaming tail) emits a `pre` as-is** — there is nothing to close; this is the structural fix for the swallowed-spinner bug
- heading → `heading` with `size` = hash count
- `---`/`***`/`___` → `divider`
- contiguous list lines → `list`; each item's text → `inlineToRichText` (GFM task-list markers → `has_checkbox`/`is_checked`); **v1: flat lists only** (indented continuation lines stay with the previous item as paragraph text — nested `ListItem.blocks` is a documented v2 extension)
- blockquote lines → `blockquote` with the inner lines converted recursively (inner content goes through `mdToBlocks` on the de-prefixed text)
- GFM table → `table` with `cells` as 2D `TgRichText` (header row is cells row 1; alignment lost — documented)
- GFM task-list items (`- [ ]` / `- [x]`) → `ListItem` with `has_checkbox` (+`is_checked`)
- `<details>…</details>` → `details` with `summary` from `<summary>`, inner blocks recursive
- paragraph lines → `paragraph` with `inlineToRichText`
- **unknown/verbatim lines (e.g. LLM-emitted inline HTML like `<aside>`)** → `paragraph` with the line's text stripped of the unparseable markup (plain-string leaf), never a parse failure — the converter must total: any string in, some blocks out

**Cost model** (replaces the markdown-source `RICH_CAP` heuristic):
```ts
export function richTextLen(rt: TgRichText): number  // sum of plain-text char lengths of string leaves
export function blocksLen(blocks: TgBlock[]): number // Σ richTextLen over text/summary/cells + item nesting
export function blockCount(blocks: TgBlock[]): number // counts nested blocks + list items + table rows, per the 500-limit wording
```
`blocksLen` is the exact rendered-text length (multibyte discount still in our favor — keep `RICH_CAP = 32_000` as the safety budget and the 500 cap as the second budget).

### `mirror.ts` rework

`blocksToMd()` is replaced by **`blocksToBlocks(): TgBlock[]`**, rendering the SAME state model with no string round trip:

| today (markdown string) | target (blocks) |
|---|---|
| narration / prompt / agentError text | `mdToBlocks(text)` (narration is LLM text → full conversion; prompt/agentError are short bot strings → `paragraph`) |
| tool block: `💭 *"why"*` + `<details><summary>⚙ name state</summary>` + json fence + optional `<pre>` error | `paragraph` (💭, italic via `inlineToRichText`) + `details` { summary: `⚙ name state`, blocks: [`pre` {language:"json"}] } + optional `paragraph`/`pre` for the ✖ error |
| `Completed ✔️ ↑in ↓out` | `paragraph` (plain string) |
| `⚠️ error: …` / `⚠️ Request was aborted` / `⏸️ Paused…` | `paragraph` (bot-generated strings become plain-string RichText leaves; `escapeHtml` retires with the markdown pipeline) |
| the `---` divider + the NBSP gap hack | **gone** — `divider` block for the error+thinking layout; no gap needed (blocks separate structurally) |
| `<tg-thinking>word… ↑in ↓out</tg-thinking>` | `thinking` block { text: `word… ↑in ↓out` } as the LAST block — the token suffix lives in the thinking text (plain string; the shimmer covers it, same as today) |
| streaming tail | `mdToBlocks(tail)` — a tail ending in an unclosed fence yields a `pre` block, and the `thinking` block after it is a **sibling**: the bug class is structurally impossible |

The layout logic (which bottom line, where the marker sits, error-end vs done vs aborted, carried-over agentError dividers) is UNCHANGED — only the emission format changes. The `⚠ incomplete` suffix on a partial error answer: `paragraph` (tail) followed by `paragraph` (`⚠ incomplete`) — or appended to the last tail block if it's a paragraph; keep the same visual rule.

**No md twin:** `content()` returns `TgBlock[]` only — `blocksToMd` has no remaining consumer and is removed in Task 9. Draft and persistent sends carry blocks; the plain demotion renders from the SAME blocks via `blocksToPlainText`, so one renderer serves both. The draft send uses `blocks` only (a draft that 400s falls into the existing failure-cooldown path — drafts have no fallback today either; see Delivery below for the persistent chain).

### `session-bridge.ts` + other senders

- `COMPACT_DRAFT_MD` / `AUTO_COMPACT_DRAFT_MD` (lane-1 drafts, the bridge's own `<tg-thinking>` drafts) → `{ blocks: [{ type: "thinking", text: … }] }`.
- `ui-dialogs.ts` stamped messages (dialog question/answer, compact stamps): short bot strings → `paragraph` blocks (or `heading`+`paragraph` where today they use `#` headings).
- `bot-commands.ts` / status card / onboarding: audit each `out.sendRich` caller; all are bot-generated strings → trivial `{blocks:[paragraph]}` or the full converter for the multi-block ones.

### What does NOT change

- Draft pacing/throttle/cooldown/429 logic, heartbeat, `draft_id = 1` stability, takeover semantics — the transport is identical, only the `rich_message` payload shape changes.
- `TelegramState`, `config.ts`, level filtering (`blocksForLevel` filters `LogBlock[]` BEFORE rendering — untouched).
- The plain-text rung — now `blocksToPlainText` + `chunkText` (the md-based `toPlainText` retires) — and the legacy `sendMessage`/`editMessageText` `parse_mode: HTML` for small bot strings (ui-dialogs stamps, wiring default) — different mechanism, out of scope.
- RETIRED (removed in Task 9, all grep-verified mirror-internal): BOTH fallback tiers — the legacy HTML converter (`chunkMarkdown`/`toUnits`/`inlineToHtml`/`markdownToHtml`/`hardSplitUnit`) and the markdown-string pipeline (`blocksToMd`/`renderToolBlock`/`foldLongFences`/`chunkRich`+`packRichUnits`+`splitFence`+`splitTable`+`unfoldDetails`/`tailView`/`toPlainText`+`stripInline`). KEPT: `richUnits` (the `mdToBlocks` skeleton), `escapeHtml`, the shared line-regex constants, `hardCut`/`MARKER`, `chunkText`, `toolArgsJson`, `extractWhy`, `RICH_CAP`.

---

## Delivery pipeline (blocks-side replacements)

All of these take/return `TgBlock[]` and live in `src/rich-blocks.ts`. They replace the markdown-string versions, which are RETIRED and removed in Task 9 (nothing serves them anymore).

**`foldBlocks(blocks, foldLines)`** — replaces `foldLongFences`: walk blocks, and for every `pre` whose line count > `foldLines` emit `details { summary: "code, <lang> (N lines)", blocks: [pre], is_open: false }`. Short fences pass through. (Today's string hack becomes a one-line structural map.)

**`tailBlocks(blocks, capChars = RICH_CAP, capBlocks = 480)`** — replaces `tailView`: keep the SUFFIX of the block array whose `blocksLen` ≤ capChars and `blockCount` ≤ capBlocks, prefix with a single `paragraph` ("⋯"). The thinking block, when present, is ALWAYS kept (it is the last block and cheap). A single oversized `pre` is hard-cut to its last lines (the draft is a live preview, same rule as today).

**`chunkBlocks(blocks, capChars, capBlocks)`** — replaces `chunkRich` for persistent sends: pack whole blocks into chunks within BOTH budgets (a fresh chunk starts a fresh 500-block count); chunks ≥ 2 get a leading `(continued)` marker block (a `paragraph`); an oversized single `pre` splits at line boundaries re-emitting the language (today's `splitFence` logic, now over the block object); an oversized `table` splits at row boundaries repeating the header row; an oversized `list` splits at item boundaries (each piece is its own `list` block; ordered lists continue numbering via the per-item `value` field — the blocks-tier equivalent of today's fence/table inner splits); an oversized `details` unwraps (summary becomes a leading paragraph) — same per-type rules as today, re-expressed structurally. **The 500-block budget is enforced here exactly like the 32k-char budget** — a 600-item LLM list becomes two chunks with a `(continued)` marker, not a 400.

**`blocksToPlainText(blocks)`** — replaces `toPlainText` for the final fallback rung: recursive walk, `pre` → bare lines, `details` → summary line + inner, `table` → pipe rows, `list` → `- ` items, `thinking` → its text (defensive: never sent persistent).

**Persistent send chain** (`mirror.ts deliverOnce` rework) — fallback granularity is **per-chunk**, and content already delivered is **never re-sent** (today's `deliverOnce` re-sends the WHOLE message through the HTML rung when any piece 400s after an earlier piece landed — a duplication hazard the new design removes by construction):

1. `chunks = chunkBlocks(foldBlocks(blocks))` (≤ 32k rendered chars AND ≤ 480 blocks each).
2. Send chunk by chunk via `sendRichMessage({ blocks: chunk })`.
3. On a **400** at chunk i (content error — 429 never triggers a demotion; it goes to the `retry_after` backoff on the SAME rung) → **demote chunk i and ALL remaining chunks to plain:** `chunkText(blocksToPlainText(chunk j))` for j = i..end, with the `(continued)` markers; chunks 0..i-1 (already in the chat) are NEVER re-sent. Plain at 4096-char chunks cannot 400 on content (nothing is parsed) — it is the terminal rung.
4. A 400 that survives the plain rung (should be impossible — length is enforced) rethrows without retry (today's rule). 429 handling, `retry_after`, `PERSIST_ATTEMPTS` backoff — unchanged (they wrap the chain).

**Why a plain rung at all** (blocks tier parses nothing server-side; the 32k-char and 500-block caps are chunking constraints enforced in `chunkBlocks` before any send, and the other rich limits — 20 table columns, 16 nesting levels, 32k rendered chars — are TIER-INDEPENDENT, so no alternate tier would have rescued them anyway). The residual 400 classes are: those hard limits on pathological LLM content, rendered-length multibyte edges, and our own converter bugs. Plain rescues ALL of them — content complete, formatting degraded. Without even it, an edge-case 400 on the FINAL answer means the user gets nothing.

**Trade-off of retiring BOTH fallback tiers:** a blocks 400 (converter bug or server quirk) degrades the affected chunk and the rest to plain text instead of a formatted render. That is the same failure mode drafts already live with — drafts have NEVER had a fallback (a 400 draft just enters the failure cooldown while the run continues), so the system already accepts "blocks fails → degraded delivery" as a working mode. The retired markdown tier's only uniquely-rescued class was converter bugs (the limit classes are tier-independent), which is also the best-covered class: TDD over the whole converter (Tasks 1–4) plus the live 400 drill in Task 9. Dropping both tiers removes two converters from the maintenance surface and eliminates the md-twin drift risk entirely.

**Draft 400 handling:** unchanged in spirit — a draft that 400s enters the long quiet failure cooldown with the state-change notifications (the draft cannot fall back to another tier mid-stream without visual churn; the persistent path still delivers everything at the end).

**`telegram-client.ts`:** `sendRichMessage`/`sendRichMessageDraft` — replace the local `InputRichMessage` parameter with a blocks-only shape `{ blocks: TgBlock[] }` (import from `rich-blocks.ts`); the `markdown`/`html` fields retire with their last consumer.

---

## Implementation tasks

Execution order is strict: Task 0 (spike) gates the design assumptions; Tasks 1–4 are pure and parallel-safe; 5–8 wire them in; 9 verifies and sweeps.

### Task 0: manual spike (throwaway bot, ~30 min, NO code)

Answers that must be pinned before Task 2/6:
1. **Thinking block in a draft**: `sendRichMessageDraft` with `blocks: [{type:"thinking", text:"Working…"}]` → does the native shimmer render (PC + Android)? Does a multi-word label + token suffix (`Pondering… ↑567 ↓1.2k`) render fully?
2. **Thinking block in a persistent send**: `sendRichMessage` containing a `thinking` block → expected 400; record the exact error (confirms the "strip at finalization" rule is hard, not cosmetic).
3. **Link entity shape**: send `paragraph` texts with candidate link entities (the `anchor_link`/`url`/`button` shapes from the RichText union) and record which renders a clickable link; pin field names. (Gates the `inlineToRichText` link branch.)
4. **Auto entity detection in blocks**: paragraph containing a bare URL and a bare email → linkified? `pre` block containing a URL → linkified? (Decides whether `skip_entity_detection` is needed anywhere — expectation: same as markdown tier, i.e. yes in paragraph, no in pre.)
5. **400 semantics**: send a deliberately malformed blocks payload (e.g. empty `details.blocks`, 501 list items, 33k chars) → record which limits 400 and the description strings (feeds the chunking tests' edge expectations).
6. **Draft animation**: re-send same `draft_id` with a blocks payload → animated? (Expectation: same as markdown tier.)
7. **Client rendering**: blocks draft containing `pre`+language, `details` (closed) with a `pre` inside, `divider`, `list` (ordered + checkbox), `table` → screenshot PC + Android (the visual baseline for Task 9).

Record results in this file under "Spike results" and adjust Tasks 2/6 if anything surprises.

### Task 1: `rich-blocks.ts` — types + cost model (TDD)

**Files:** create `src/rich-blocks.ts`; test `tests/rich-blocks.test.ts`.
**Tests first:** `richTextLen` (string / nested sequence / entity nesting / multibyte leaves), `blocksLen` (all block types, table cells, details summary+inner, list item nesting), `blockCount` (top-level + list items + table rows + nested details content per the 500-limit wording).
Commit: `feat(rich-blocks): TgBlock/TgRichText types + rendered-length cost model`

### Task 2: `inlineToRichText` (TDD)

**Files:** `src/rich-blocks.ts`, `tests/rich-blocks.test.ts`.
**Tests first:** port the `inlineToHtml` edge-case expectations to RichText assertions — code spans verbatim (plain string leaf, no formatting parsed inside), links (using the Task-0-pinned entity), `**`/`__` bold, `*`/`_` italic (word-boundary rules), `~~strike~~`, `==marked==`, `||spoiler||`, unmatched markers stay literal, nested emphasis, `&<>` never produce structure (plain text).
Commit: `feat(rich-blocks): inlineToRichText — inline markdown to RichText`

### Task 3: `mdToBlocks` (TDD)

**Files:** `src/rich-blocks.ts`, `tests/rich-blocks.test.ts`.
**Tests first:** every unit type (fence±language, **unclosed fence at EOF → `pre`**, heading sizes, hr variants → `divider`, ul/ol (+ordered `type:"1"`), blockquote (inner conversion), GFM table → 2D cells, `<details>` → `details` (unclosed details → open block), paragraphs with inline, blank-line handling, unknown/inline-HTML lines → plain paragraph (total function — no throw on any input).
Commit: `feat(rich-blocks): mdToBlocks — GFM to InputRichBlock subset`

### Task 4: blocks pipeline — fold / tail / chunk / plain (TDD)

**Files:** `src/rich-blocks.ts`, `tests/rich-blocks.test.ts`.
**Tests first:** `foldBlocks` (short fence untouched, long fence → closed `details`, lang in summary, nested/adjacent); `tailBlocks` (under cap untouched, over cap → suffix + "⋯" paragraph, thinking block always kept, oversized pre hard-cut to last lines, 500-block budget); `chunkBlocks` (both budgets, marker from chunk 2, pre inner split re-emits language, table header repeat, **list inner split at item boundaries with ordered `value` continuation**, oversized details unwrap); `blocksToPlainText` (each type, details → summary line, table → pipe rows).
Commit: `feat(rich-blocks): fold/tail/chunk/plain over TgBlock[]`

### Task 5: client types accept `blocks`

**Files:** `src/telegram-client.ts`, `tests/telegram-client.test.ts`.
Replace the rich parameter type with blocks-only `{ blocks: TgBlock[] }` (the `markdown`/`html` fields retire with their last consumer); the request builder passes it through verbatim; test: a blocks payload serializes to the API body shape (`rich_message: { blocks: [...] }`).
Commit: `feat(client): InputRichMessage accepts blocks tier`

### Task 6: mirror — `blocksToBlocks` + draft path on blocks (TDD)

**Files:** `src/mirror.ts`, `src/rich-blocks.ts`, `tests/mirror-*.test.ts`.
- `blocksToBlocks(log, { tail, bottom, tokens })` per the layout table above; the `thinking` block is last in every working layout; `divider` block for the error+thinking layout; NBSP-gap logic deleted.
- `content()` → `TgBlock[]` (no md twin); `requestUpdate`/`runDraftOnce` send `{ blocks: tailBlocks(content(), …) }`; `draftContent`'s capping moves to `tailBlocks`.
- Tests: rewrite the draft-content assertions in `mirror-stream` / `mirror-early-draft` / `mirror-end` / `mirror-retry` / `mirror-autocompact` / `mirror-tokens` to assert the BLOCKS arrays (spinner is a `thinking` block sibling after a `pre` tail — the regression test for the fence-swallow bug is a first-class case: tail with unclosed fence + thinking bottom → `pre` block followed by `thinking` block).
Commit: `feat(mirror): blocks-tier draft content (thinking block sibling to streaming pre)`

### Task 7: persistent path — blocks → plain demotion (TDD)

**Files:** `src/mirror.ts`, `tests/mirror-finalize.test.ts`, `tests/mirror-end.test.ts`.
`deliverOnce` becomes the per-chunk demotion chain per the Delivery section. Tests: happy path sends `{blocks}` (no `markdown` key); blocks-400 on chunk 0 → the WHOLE message re-sent as plain (`blocksToPlainText` + `chunkText`); **partial-delivery case: chunk 0 OK, chunk 1 400s → chunks 1..end re-sent as PLAIN only (`blocksToPlainText` + `chunkText`, `(continued)` markers), chunk 0 NOT re-sent (duplication regression)**; `disableNotification` survives the chain; 400-through-all rungs rethrows once; 429 never changes rung (backoff on the same rung).
Commit: `feat(mirror): persistent sends on blocks with plain demotion (markdown + HTML tiers retired)`

### Task 8: other senders to blocks

**Files:** `src/session-bridge.ts` (lane-1 compact drafts → `thinking` block; compact stamps, dialog acks), `src/ui-dialogs.ts` (stamped dialog segments), `src/bot-commands.ts` (status card, help), `src/onboarding.ts` — each `out.sendRich(md, …)` call becomes `out.sendRichBlocks(mdToBlocks(md))` (helper on `Out`; no md twin). Tests per file; the bridge/commands tests assert block payloads.
Commit: `feat(bridge,dialogs,commands): all rich senders on the blocks tier`

### Task 9: live verification + sweep (LIVE MATRIX — 2026-10-06)

| # | item | result |
|---|------|--------|
| 1 | dialog pause/respawn (stamp + button animation) | ✅ owner-verified (incl. the one-shot clear/kill fix) |
| 2 | working draft — spinner under a streaming code fence, tool blocks (details + pre), done end (m1 + `Completed ✔️`, m2) | ✅ owner-verified |
| 3 | ✖ tool-error block | ✅ owner-verified (read tool on a missing file → `isError` → ✖ pre block) |
| 4 | error end (⚠️ + divider + thinking while open; finalized) | ✅ owner-verified (aborted run) |
| 5 | auto-compact lane 1 + lane 2 | ⏳ pending owner test (lane 1 covered by unit tests) |
| 6 | 32k+ answer chunking (`(continued)` marker) | ✅ owner-verified |
| 7 | 400-fallback drill | ✅ owner-verified — 22-col table → plain demotion landed |
| 8 | TUI dialog mirroring (select + confirm, both directions) | ✅ owner-verified 2026-10-06 after the single-arg confirm/input signal-slot fix (`64a4149`) |

Post-migration fixes (all on this branch): streaming-transient empty-block 400, list marker-type split, table header `is_header`, answerCallbackQuery on every tap, one-shot clear/kill nonce, nested lists, and the dialog signal-slot fix.

---

### Task 9 (original spec): live verification + sweep

1. `npx tsc --noEmit` + full `node --test` green.
2. Live matrix against the Task-0 screenshots: working draft (spinner below a streaming code fence — the original bug), tool blocks (collapsed details + json pre + ✖ error pre), done end (m1 log + `Completed ✔️`, m2 answer), error end (⚠️ paragraph + divider + thinking while open; finalized error message), auto-compact lane 1 + lane 2, dialog pause/respawn, 32k+ answer chunking (`(continued)` marker), 400-fallback drill (temporarily corrupt a blocks payload → watch the md rung land).
3. Remove the retired markdown pipeline — grep-verify each symbol has zero consumers first: legacy HTML converter (`toUnits`, `inlineToHtml`, `markdownToHtml`, `chunkMarkdown`, `hardSplitUnit`) and markdown-string builders (`blocksToMd`, `renderToolBlock`, `foldLongFences`, `chunkRich`/`packRichUnits`/`splitFence`/`splitTable`/`unfoldDetails`, `tailView`, `toPlainText`/`stripInline`) from `src/markdown.ts` + `src/mirror.ts`, plus their dedicated tests. KEEP: `richUnits` (the `mdToBlocks` skeleton), `escapeHtml`, the shared line-regex constants (`FENCE_OPEN_RE`/`HEADING_RE`/`HR_RE`/`UL_RE`/`OL_RE`/`BQ_RE`/`HR_LINE`), `hardCut`/`MARKER`, `chunkText`, `toolArgsJson`, `extractWhy`, `RICH_CAP`. Re-run `npx tsc --noEmit` + `node --test`.
4. Docs sweep: README (rich-message section), stale comments in `mirror.ts`/`markdown.ts` header docs ("markdown passthrough" → "blocks primary, markdown fallback"), this file's outline boxes.
Commit: `docs: blocks-tier mirroring — sweep stale references`

---

## Risks & open questions

| # | risk / question | mitigation |
|---|---|---|
| R1 | Link entity shape unpinned (Task 0.3) — `anchor_link` vs `url` vs other | Spike gates Task 2's link branch; worst case links degrade to `text (href)` plain paragraphs (today's `toPlainText` behavior) until pinned |
| R2 | `mdToBlocks` is now a RENDERING parse over the LLM's free-form answer — a misparse degrades what the user reads (vs today's lossy-safe structural parse), and with the markdown tier retired there is no formatted fallback | Total-function contract (never throws, unknown → plain paragraph); on a blocks 400 the plain demotion renders the SAME blocks (`blocksToPlainText`) — content complete, formatting degraded; the live 400 drill (Task 9) exercises this path |
| R3 | 32768 cap counts rendered text; our `blocksLen` counts JS string units of plain text | Same relationship as today's markdown source (rendered ≤ source, multibyte discounted) — `RICH_CAP = 32_000` budget carries over; Task 0.5 probes the 33k boundary on blocks |
| R4 | 500-block cap counts list items + table rows + nested blocks — a miscount in `blockCount` would let an over-limit chunk 400 | handled like the 32k cap: `chunkBlocks` budgets `blockCount` per chunk (480 margin) with per-type inner splits (list at items, table at rows); Task 0.5 confirms the limit is per-message and the counting semantics; the fallback chain is the backstop for any residual miscount |
| R5 | ~~Flat-lists-only `mdToBlocks`~~ CLOSED 2026-10-05: nested lists implemented (stack-based GFM parser; indent > parent → nested list in the parent item's blocks; marker-type switch at same indent → sibling split; lazy materialization). Live-verified 3-level nesting (msg 1426) |
| R6 | Drafts have no fallback rung — a blocks draft that 400s sits in the failure cooldown while the run continues | Unchanged from today (drafts already don't fall back); the persistent path still delivers everything; failure notifications surface it. Acceptable — flag if live drills show draft 400s are frequent |
| R7 | `thinking` block label with token suffix — shimmer may clip long labels | Task 0.1 verifies the full `Pondering… ↑567 ↓1.2k` label renders; if clipped, move the suffix to a trailing `paragraph` (layout regression test pinned) |
| R8 | Footnotes (`[^id]`), table alignment, task-list checkboxes from LLM markdown have no/partial block equivalents | Footnotes: CLOSED 2026-10-06 (revised) — canonical shape learned from the server's own markdown→blocks conversion (forwarded msg 1516): body `[^id]` → `superscript(anchor "fnref-<id>-<k>" + reference_link "<n>" → "fn-<id>")`; line-initial definitions → `footer` block (`"N. " + reference(definition, "fn-<id>") + " " + ↩ backlink`), numbering = first-reference order, undefined refs stay literal (GFM). Math `$…$`/`$$…$$` → `mathematical_expression` block + `<a name=…>` → `anchor` block landed the same day. Alignment → default (unchanged); task lists → `has_checkbox` (done) |
| R9 | Received side: if the owner ever sends a rich message, updates carry `rich_message` blocks, not `text` | Out of scope (private chat, plain commands); the router reads `message.text` — add a defensive `rich_message` → plain-text projection in a follow-up if it ever matters |

**Explicit non-goals (stay parked):** media/map/document/voice blocks, `<tg-button>` rows, collages/slideshows, `is_compact`/styled tables, RTL, `footer`/`anchor`/`pullquote`/`expandable_blockquote` blocks, the `html` tier as a primary format. (Nested list items were a v2 non-goal — implemented 2026-10-05, see R5.)

## Why this is worth doing now (context)

The triggering bug — the `<tg-thinking>` spinner rendered inside a streaming monospace block — exists because an unclosed markdown fence swallows the rest of the document, server-side. Blocks make that impossible by construction (a `pre` block has an explicit end; the thinking block is a sibling), remove the NBSP-gap and `---` divider string hacks, replace the `foldLongFences` string surgery with a structural map, give an exact rendered-length cost model, and collapse the 400 ladder to a single plain demotion — while the plain rung keeps the delivery guarantee (content always lands) and the whole markdown-string pipeline retires with it.
