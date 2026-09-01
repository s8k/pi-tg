# Rich Messages switch — design

- Date: 2026-08-31
- Branch: `feat/pi-telega-v1`
- Status: design validated with the owner; implementation pending
- Sources of truth: live `core.telegram.org/bots/api` (Bot API 10.2/10.3, fetched
  2026-08-31) and the current code in `src/`

## Purpose

Replace the current LLM-markdown → hand-rolled-HTML pipeline (`parse_mode: HTML`)
with Telegram's **native Rich Messages**, and unify per-turn streaming into a single
native draft lifecycle.

Pain points being solved:

1. **Tables** — LLM GFM tables currently arrive as raw pipe text (no table support
   in the old HTML path). Rich Messages render GFM tables natively.
2. **Code blocks** — the language is lost in the old path; rich preformatted blocks
   carry a language label.
3. **Scannability** — collapsible `<details>` blocks for long content.
4. **Streaming UX** — today the user watches raw markdown in a temporary message;
   rich drafts show the live answer in final formatting with a native Stop button.

## Background — what exists today

- `src/markdown.ts`: line-based markdown → limited HTML subset (inline code, links,
  bold/italic/strikethrough, headings→`<b>`, HR→`────`, `• ` lists, `❝ ` quotes,
  fenced code → `<pre>`). Chunks at 4096 chars with a `(continued)` marker;
  `toPlainText` as last-resort fallback.
- `src/mirror.ts` (per agent turn):
  1. posts `🤖 Working…` with a `[⏹ Stop]` inline button (persistent),
  2. for each assistant message posts `…` and edits it with throttled
     **plain text** (raw markdown, head-truncated at 4095), deleting it on end,
  3. tool start/end posts/edits separate `⚙ tool …` / `✔` messages,
  4. on `agent_end` edits the Working… message to a `✅ Done…` label and sends the
     final answer as 4096-char HTML chunks.
- `src/telegram-client.ts`: Bot API wrapper over `getUpdates` long polling
  (`sendMessage`, `editMessageText`, `deleteMessage`, `answerCallbackQuery`),
  429 retry with `retry_after`.
- Bot is paired to a single owner's **private chat** (`ownerId`, `/start` pairing).

## Background — the Rich Messages API (Bot API 10.2/10.3)

Key facts (from the live Bot API reference, 2026-08-31):

- **Bot API 10.2 (2026-07-14)** added Rich Messages *to the Bot API itself*:
  `sendRichMessage`, `sendRichMessageDraft`, a `rich_message` parameter on
  `editMessageText`, and a `rich_message` field on `Message`.
  **Bot API 10.3 (2026-08-24)** added inline buttons (`RichMessageButton` with
  `callback_data`), `is_compact` tables, expandable block quotations, document blocks.
  → No architectural change for us: same bot token, same polling.
- `InputRichMessage` accepts **exactly one of**:
  - `markdown` — GFM-compatible (tables with alignment, fenced code with language,
    task lists, footnotes `[^id]`, `$math$`, spoilers `|…|`, mark `==…==`,
    headings, blockquotes) **plus arbitrary inline HTML** (`<details>/<summary>`,
    `<u>`, `<sub>/<sup>`, `<aside>`, …).
  - `html` — superset (`<table bordered striped compact>` with colspan/rowspan,
    `<footer>`, `<tg-button>`/`<tg-button-row>`, `<tg-math>`, `<tg-map>`, …).
  - `blocks` — explicit block array (paragraph, heading, `pre`+language, list,
    table `cells: 2D array` + `is_bordered/is_striped/is_compact`,
    details `summary` + nested blocks + `is_open`, …).
- **Limits**: 32768 UTF-8 characters per rich message; 500 blocks; 16 nesting
  levels; 50 media; 20 table columns.
- **Streaming**: `sendRichMessageDraft(chat_id, draft_id, rich_message, can_stop?)`
  — the draft is an **ephemeral ~30-second preview**; re-sending with the **same
  `draft_id` resets the window** (verified by owner); a different `draft_id`
  replaces without animation. `can_stop: true` shows a native Stop button and
  delivers a `stopped_message_generation` update
  (`{ chat: Chat, message_thread_id?: Integer, draft_id: Integer }`).
  The draft is replaced by the persistent message when `sendRichMessage` is called
  (and dies if the bot sends any other message).
- `sendRichMessageDraft.chat_id` is **private chats only** — satisfied by
  construction (we only post to the owner's private chat).
- Auto entity detection (URLs, emails, @mentions, hashtags, …) applies;
  `skip_entity_detection` exists to disable it.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Scope: option (c)** — the rich draft *is* the working message. One live element per turn; no separate `🤖 Working…` message and no `✅ Done` label. | Cleanest chat; one message lifecycle (draft → final). Owner chose (c) over (b) (keep Working… message) after trade-off discussion. |
| 2 | **No global `rich:` config flag.** Rollback = the per-send fallback chain (rich → legacy HTML → plain) plus code revert. | Owner chose (i): least maintenance; the legacy path stays alive as the tested fallback. |
| 3 | **Input format: `markdown` field with LLM output near-verbatim.** | Zero conversion code; gets the full GFM+HTML text capability. The `html`/`blocks` tiers are v2 (see parking lot). |
| 4 | **Both v1 content additions**: (a) initial draft uses the native `<tg-thinking>` placeholder instead of plain text; (b) code fences longer than `codeFoldLines` (default 25) lines are wrapped in `<details>` (closed by default). | Owner: “do both.” Both stay in the `markdown` tier (HTML is allowed inside it). |
| 5 | **Draft heartbeat: every `draftHeartbeatMs` (default 17 000 ms, config file, clamped 5 000–25 000)** re-send the current draft content with the same `draft_id`. | Extends the 30 s ephemeral window through long tool calls / model thinking (same-`draft_id` reset verified by owner). 17 s chosen by owner; clamp keeps a hand-edit inside the window. |
| 6 | **Internal `RICH_CAP = 32000`** (margin under the documented 32768), final value to be spike-verified. | “UTF-8 characters” is ambiguous (code points vs bytes vs UTF-16); margin + spike de-risks it. |
| 7 | **>32k answers: chunk at top-level block boundaries** with per-type inner splits (fence→lines, table→rows with repeated header, oversized details→unwrap, else hard cut); marker `(continued)`. | Generalizes today's unit-packing from 4096 to 32 768; a chunk never starts mid-structure. |
| 8 | **Draft overflow: tail view** — keep the last ≤cap content, back the cut off to a block boundary, prefix a `⋯` line. | A growing document should show its tail (today's stream shows the head — wrong direction). Cosmetic only; the final send is always complete. |
| 9 | **Tool status lines and `ui_prompt_start` move inside the draft** (footer lines). | Any message sent by the bot kills the draft, so per-tool messages are impossible in (c). Footer = all in-flight + last 3 completed lines. |
| 10 | **Muted = fully silent**: no draft, no `✅ Done (muted)` line; mid-turn mute stops updates and the heartbeat, the draft expires naturally. | Mute means “I don't want output.” (The old behavior posted a Done label; dropped deliberately.) |
| 11 | **Stop**: the draft's native button (`can_stop: true`) replaces the `[⏹ Stop]` keyboard; `stopped_message_generation` routes to the *existing* `stop` action. The `/stop` text command is unchanged. | No new action kind; `MessageGenerationStopped` carries the chat id. |
| 12 | **Finalize**: `sendRichMessage`; on 400 → legacy `chunkMarkdown`/HTML path; on 400 again → `toPlainText`. | Each step triggers only on server-side parse rejection of *this* text; `markdown.ts`'s legacy code survives as the safety net, unchanged. |

Aborted-turn label spacing fix (owner): `“⏹ interrupted”` → `“⏹  interrupted”`
(space after the emoji), applied to the existing string as well.

## Architecture — one live message per turn

Per agent turn the bot maintains exactly one live element: a rich draft with a
stable `draft_id` (per-instance counter, starts at 1, in-memory only).

```
agent_start   → sendRichMessageDraft(draft_id=N, markdown=<tg-thinking>…</tg-thinking>, can_stop=true)
               + start heartbeat (every cfg.draftHeartbeatMs while turn active and !muted)
tool_start    → draft update: footer line `⚙ <tool>: <preview> …`
tool_end      → draft update: footer line marked ✔ / ✖
msg_update    → draft update (throttled by cfg.streamEditMs):
                 tailView(foldLongFences(latestAssistantText, cfg.codeFoldLines), RICH_CAP) + footer
heartbeat     → re-send current draft content (same draft_id; extends the 30 s window)
ui_prompt_start → draft update: footer line `⚠️ waiting in the terminal…`
agent_end     → stop heartbeat; finalize (see below) — the final sendRichMessage
                 replaces the draft with the persistent answer
error end     → plain sendMessage(`⚠️ error: …`) → draft dies
user Stop btn → stopped_message_generation → existing stop action → pi.abort()
```

**Draft content model** (`markdown` field):

```
<latest assistant text so far, folded + tail-viewed>

⚙ bash: git status …          ← in-flight tool(s)
✔ read: src/mirror.ts          ← last 3 completed tools (older drop off the top)
```

- Content = the **latest** assistant message's text (not concatenated), consistent
  with “final answer = last non-empty text” semantics (unchanged from today).
- Footer = all in-flight tool lines + the 3 most recently completed, newest last.
- `ui_prompt_start` adds its line to the same footer.
- Tool-line text reuses `toolPreview()` (respects `cfg.toolPreviewChars`).

**State**: the draft is tracked purely in the Mirror instance (`draftId`,
heartbeat timer handle, last-send time, tool lines map). Nothing persists — a
draft has no `message_id`, and a process death lets the draft expire naturally.
`state.ts`: `setWorking/getWorking` and the tool-msg map (`setToolMsg/getToolMsg/
clearToolMsgs`) are **deleted** (only the Mirror used them). `sentMessageIds` stays:
the final `sendRichMessage` and the small plain status lines record their
`message_id`s for `/clear` chat cleanup.

## Content pipeline (all new code in `src/markdown.ts`; legacy code untouched)

```
LLM markdown
  → foldLongFences(md, cfg.codeFoldLines)   # fence > N lines → <details> (closed)
  → richUnits(text)                          # top-level blocks: fence|table|paragraph|heading|list|details|other
  → chunkRich(units, RICH_CAP)               # final answer: pack ≤ RICH_CAP − len(marker)
  → tailView(text, RICH_CAP)                 # draft only: aligned tail
```

### `foldLongFences(md, n)`

A fenced block whose body exceeds `n` lines (default `codeFoldLines = 25`,
config, clamped 5–500) is wrapped:

```
<details><summary>code (N lines, python)</summary>

```python
…
```

</details>
```

The summary carries the line count and the language when present. The markdown
tier parses markdown inside `<details>` bodies (documented), so the fence inside
still renders as a preformatted block. Short fences pass through verbatim.

### `richUnits(md)`

Top-level block parse (the same fence/table/heading/list awareness the legacy
parser already has, generalized): returns `[{ type, text }]` where `text` is the
verbatim markdown of the block. One implementation, used by folding, chunking
and the tail view. Block types: `fence`, `table` (GFM pipe table incl. separator
row), `heading`, `list` (contiguous list lines), `blockquote`, `hr`, `details`
(an HTML `<details>…</details>` region), `paragraph` (everything else).

### `chunkRich(units, RICH_CAP)` — final answer over cap

Greedy packing of units into chunks ≤ `RICH_CAP − len("(continued)\n")`;
chunks ≥ 2 get the marker prefix (same convention as today). A single unit larger
than the whole cap is split *inside*, by type:

- **fence** → at code-line boundaries; each chunk re-emits the fence **with the
  language** (generalizes today's `hardSplitUnit`, without the `<pre>` case);
- **table** → at row boundaries; **header + separator row repeated** in every
  chunk so each piece stands alone;
- **details** (e.g. a 60k-line collapsed diff) → **unwrap** the wrapper and split
  the content normally (a collapsed block split across messages loses its meaning);
- **anything else** → hard character cut (today's last resort).

`RICH_CAP = 32000` initially (documented limit 32768; margin pending spike).
An over-cap answer simply becomes 2+ `sendRichMessage` calls — rare.

### `tailView(md, RICH_CAP)` — draft overflow

If the (folded) draft text exceeds `RICH_CAP`: keep the last `RICH_CAP`-ish chars,
back the cut off to the nearest preceding block boundary (no half table/paragraph
at the top), and prefix a single `⋯` line. Cosmetic only — the final
`sendRichMessage` always carries the complete (chunked) answer.

### Draft update failures

Mid-stream markdown is GFM-tolerant (unclosed fences/tables degrade to literal
text). If a `sendRichMessageDraft` call 400s anyway: keep the last known-good
draft content, surface via `ui.notify`, next throttled update retries. No extra
machinery.

## Finalization & fallback chain

On `agent_end` (non-error), for the final answer text:

1. `sendRichMessage(chatId, { markdown: text })` — verbatim (folded) passthrough.
   One call; no chunking under the cap.
2. **400 → legacy HTML path**: existing `chunkMarkdown` + `parse_mode: HTML`
   (4096 chunks). Note: an answer > 32k skips straight here — the legacy
   chunker handles it.
3. **400 → plain text** via `toPlainText` (today's last resort).

Each step triggers only on server-side parse rejection of *this particular
text*; step 1 stays the happy path and `markdown.ts`'s legacy code survives as
the tested safety net, unchanged. Error/abort paths send plain text (no chain
needed).

## Edge cases

| Case | Behavior |
|------|----------|
| Muted at turn start | no draft, nothing on `agent_end` — fully silent (the `✅ Done (muted)` label is gone) |
| Muted mid-turn | all handlers **and the heartbeat** check mute → updates stop; the draft expires naturally within 30 s (nothing may be sent while muted) |
| Error end | plain `⚠️ error: …` message (draft dies) |
| Aborted, partial text | plain `⏹  interrupted` line, then the rich partial answer |
| Aborted, no text | plain `⏹  interrupted` line only |
| Normal end, no reply text | plain `✅ Done (no reply text)` (as today) |
| `ui_prompt_start` | footer line inside the draft, not a message |
| Session replace / pi restart | stale draft expires on its own; new turn → new `draft_id` |
| Multiple assistant messages per turn | one draft; content = latest assistant text + tool footer; final = last non-empty text (semantics unchanged) |
| `/stop` text command | unchanged (user messages don't kill the draft) |
| Draft Stop button | `stopped_message_generation` → existing `stop` action (`pi.abort()` + `⏹ Stopping…`) |

Note: the `⏹ Stopping…` acknowledgement from the stop action is a plain message;
it lands after the user already pressed Stop, so the draft's disappearance is
expected UX, not a bug.

## Components — per-file changes

| File | Change |
|------|--------|
| `src/telegram-client.ts` | +`sendRichMessage(chatId, InputRichMessage, opts?) → TgSentMessage` (returns `message_id` + chat), +`sendRichMessageDraft(chatId, draftId, InputRichMessage, canStop?) → boolean`; +types `InputRichMessage` (`{ markdown?, html?, blocks?, is_rtl?, skip_entity_detection? }`), `MessageGenerationStopped`, `TgUpdate.stopped_message_generation?`. Existing 429-retry/error mapping applies as-is. |
| `src/session-bridge.ts` | `Out` interface: +`sendRich(chatId, md: string) → id \| undefined` (records `addSent`), +`sendDraft(chatId, draftId: number, md: string, canStop?: boolean) → boolean`. No changes to `stop` handling (reused by the new update). |
| `src/router.ts` | +`update.stopped_message_generation` case → `{ kind: "stop", chatId: u.chat.id }` (no new action kind). |
| `src/markdown.ts` | Legacy path **untouched** (it is the fallback). New exports: `RICH_CAP`, `foldLongFences(md, n)`, `richUnits(md)`, `chunkRich(md, cap?)`, `tailView(md, cap?)` (details in the Content pipeline section). |
| `src/mirror.ts` | Streaming/finalization rewritten per the Architecture section. Deps gain an injectable timer (`setTimer/clearTimer` returning a handle) so the heartbeat is testable without real sleeps. Working/tool-message machinery deleted; `"⏹  interrupted"` spacing. |
| `src/state.ts` | `setWorking/getWorking`, `setToolMsg/getToolMsg/clearToolMsgs` deleted (Mirror was the only consumer). Everything else unchanged. |
| `src/config.ts` | +`draftHeartbeatMs: number` (default `17000`, clamped 5000–25000), +`codeFoldLines: number` (default `25`, clamped 5–500). |
| `index.ts` | unchanged. |

## Tests

- `markdown.test.ts` — new: `foldLongFences` (short fence untouched, long fence wrapped, summary content, nested/adjacent fences); `chunkRich` (unit packing, marker from chunk 2, fence inner split re-emits language, table header repeat, oversized-details unwrap, hard-cut fallback, RICH_CAP edges incl. emoji); `tailView` (under cap untouched, over cap aligned tail, `⋯` line, block-boundary backoff). Legacy tests unchanged.
- `mirror-stream.test.ts` (rewritten) — draft lifecycle: `agent_start` sends `<tg-thinking>` draft with `can_stop: true`; throttled updates; heartbeat re-sends via injected timer; footer lines (in-flight + last-3-completed cap, tool errors marked ✖); `ui_prompt_start` line.
- `mirror-tools.test.ts` (rewritten) — footer-line behavior replaces the message-edit tests.
- `mirror-end.test.ts` (rewritten) — finalization: rich success → `addSent`; rich 400 → legacy HTML; both 400 → plain; error end; abort with/without partial text (spacing check); no-reply-text label; muted silence.
- `mirror-mute.test.ts` (rewritten) — muted at start (no draft); mid-turn mute stops updates **and heartbeat**.
- `telegram-client.test.ts` — new methods: payload shape, 429 retry on both, error mapping, `draft_id`/`can_stop` pass-through.
- `router.test.ts` — `stopped_message_generation` → `stop` action with the right chat id.
- `wiring.test.ts` — `makeOut` adapter: `sendRich`/`sendDraft` delegate and record sent ids.

## Spike tasks (manual, throwaway bot, first implementation task)

1. **Exact `RICH_CAP` semantics**: send strings of known length (ASCII, Cyrillic,
   emoji) to find the true ceiling — code points vs bytes vs UTF-16 — then fix
   `RICH_CAP` (start at 32000) and the corresponding tests.
2. **`<tg-thinking>` rendering**: which inner text to use (e.g.
   `<tg-thinking>🤖 working…</tg-thinking>`), and whether the label is visible
   before the first content update arrives.
3. **Entity auto-detection inside code blocks**: do phone numbers / URLs in
   test-data fences get linkified? If annoying, `skip_entity_detection` on the
   final send (and drafts) — decide after seeing it.

Already verified (by owner): re-sending a draft with the same `draft_id` resets
the ~30 s window.

## Spike results (2026-08-31, live Bot API 10.3)

1. **`RICH_CAP` semantics (question 1).** The 32 768 limit applies to the
   **rendered** rich text, not the markdown source (a 32 912-source-char
   formatted article was accepted — syntax like `#`, `|`, ``` is free).
   Pure-ASCII boundary is exact: 32 768 OK / 32 769 → 400
   `RICH_MESSAGE_TEXT_TOO_LONG`. Multibyte chars count discounted (é×65 536 /
   🎉×65 536 pass at 131–262 KB; a×32 768 + é×40 000 fails) — consistent with
   each multibyte byte counting ≈ 12.5–50 %. **`RICH_CAP = 32 000` (JS units of
   markdown source) is safe as-is**: rendered ≤ source, and per JS unit ASCII
   counts 1.0 vs 0.25 (é) / 0.25 (🎉), so the adjusted length never exceeds the
   32 000 < 32 768 boundary. No constant change.
2. **`<tg-thinking>` (question 2).** Renders our own inner text ("working…") as
   an iridescent silver label, visible immediately on the first draft send →
   keep `<tg-thinking>working…</tg-thinking>` (no emoji prefix).
3. **Entity detection (question 3).** Plain-text tier: URLs and emails are
   auto-linked; phone numbers are **not** — identical to the legacy HTML path,
   so no `skip_entity_detection`. Inside-code-fence variant left unverified
   (cosmetic only; legacy also doesn't linkify inside code).
4. **Stop button (beyond the spike list).** With `can_stop: true` the button
   appears **to the right of the input box** (not on the message bubble) and is
   visible even for one-shot, never-updated drafts. Click →
   `stopped_message_generation` with the live shape `{ chat: {…full Chat…},
   draft_id: "<string>" }` — `draft_id` arrives as a **string** (docs say
   Integer). Code fix applied: `MessageGenerationStopped.draft_id: string`,
   router test pinned to the live payload.
5. **Client rendering note.** ~32 k final messages display collapsed at ~16 k
   with a “Show more” popup; full text is intact and readable (verified with a
   unique tail marker).

## Parking lot (explicit v2 non-goals)

- Table styling (`is_bordered`/`is_striped`/`is_compact`, alignment, colspan)
  — needs the `html` or `blocks` tier; v1 uses plain GFM tables.
- `<tg-button>` / `<tg-button-row>` inline actions (Bot API 10.3) — e.g. inline
  “retry”/“clear” inside the answer.
- Media / map / document / quote blocks — `blocks` tier, out of scope for a
  text-LLM mirror.
- `blocks`-tier rendering as a replacement for the `markdown` passthrough.
- Any global `rich:` config flag (deliberately not built; see decision 2).

## Implementation order (suggested)

1. Spike tasks (15 min, manual) → lock `RICH_CAP` and `tg-thinking` text.
2. `telegram-client.ts` methods + types + tests.
3. `markdown.ts` rich functions + tests (pure, no I/O).
4. `router.ts` + `session-bridge.ts` Out surface + tests.
5. `mirror.ts` rewrite + `state.ts` trim + `config.ts` fields + full test pass.
6. Manual smoke with the real owner chat (tables, long code, stop button,
   heartbeat across a long tool call).
