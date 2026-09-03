# LLM mirroring — two-message design (work log + answer)

Status: **design, validated with the user on 2026-09-02** — implementation not started.

Supersedes the streaming/drafting sections of `2026-08-31-rich-messages-design.md`.
That doc's delivery mechanics (rich → HTML → plain fallback chain, `tailView`,
`chunkRich`, 429 cooldown) remain valid and are reused.

## Contract

One agent run produces **at most 2 live rich drafts**, which become **at most 2
persistent rich messages**:

1. **Message 1 — work log**: chronological record of the run (model narration,
   tool calls with their "why" and params, errors). Its bottom line is a
   `<tg-thinking>` tag while work is in flight, replaced by `Completed ✔️` on a
   clean end, `⚠ Error` on error, or removed (no marker) on manual stop.
2. **Message 2 — answer**: a live "candidate slot". Every assistant message's
   text streams into it as a *final-answer candidate*. The moment a tool call
   appears in that message, the candidate is **demoted**: its text moves to the
   tail of message 1 like any other narration, and the slot returns to the
   spinner. The process repeats per message; the candidate that survives to
   `message_end` without a tool call **is** the answer and is persisted as-is.

## Progress

- [x] 0. Header, status, contract, outline
- [x] 1. Goal & final look (worked example)
- [x] 2. Architecture: state machine
- [x] 3. Message 1 — work log spec
- [x] 4. Message 2 — candidate slot spec
- [x] 5. End states & finalization mechanics
- [x] 6. Code plan & TDD order
- [x] 7. Out of scope & validation notes

## 1. Goal & final look

What the user sees in the chat for a typical run:

```
[while working]
  msg 1 (live draft):                          msg 2 (live draft):
  ┌ Let me check the failing test.             ┌ <tg-thinking>…</tg-thinking>
  │                                            └ (spinner — "composing")
  │                                            ┌ "Let me check the failing test…" ← candidate streaming
  │   toolcall_start → demoted:                │   (1–2 s)
  │   msg 2 back to spinner, msg 1 gains       └ spinner again
  │   the narration + tool block
  … (repeats per message: flicker, demote, flicker) …
  msg 1 (live draft):                          msg 2 (live draft):
  ┌ Let me check the failing test.             ┌ The fix works. Here is what I
  │ ⚙ read tests/app.test.ts ✔                 │ changed: …                        ← final candidate
  │   💭 "the test expects a 302 …"             │    streaming live, token by token
  │ ⚙ edit src/app.ts ✖                        │
  │   <pre>RangeError: …</pre>                 │
  │ <tg-thinking>…</tg-thinking>               └
  └

[after a clean end — both drafts replaced by persistent messages]
  msg 1:  Let me check the failing test.
          ⚙ read tests/app.test.ts ✔
            💭 "the test expects a 302 …"
          ⚙ edit src/app.ts ✖
            <pre>RangeError: …</pre>
          Completed ✔️

  msg 2:  The fix works. Here is what I changed: …
```

Properties:

- Never more than 2 drafts going back; never more than 2 resulting messages per run.
- Message 2 streams the real answer live (no replay, no fast-forward artifact).
- Message 1 is the complete record (full text, not the 32 k tail view) and is
  persisted on every end state that produced anything.
- The "flicker" (candidate appears in msg 2, then settles into msg 1) is the
  accepted cost of live streaming; each demotion is a sub-second visual move.

## 2. Architecture: state machine

One `Mirror` instance per run (recreated on `agent_start`, as today).

### State

```ts
log: LogBlock[]            // committed, chronological (see §3)
tail: { mode: "candidate" | "demoted" | "none", text: string }
     // in-flight text of the current assistant message (display state)
thinking: string[]         // per-message thinking parts, in content order
slot: { draftId?: string; created: boolean; hasContent: boolean }
     // message 2 — one fixed draft_id for the whole run
finalText?: string         // set at confirmation
phase: "work" | "finalized"
thinkingWord: string       // rotating heartbeat word (existing)
```

Content is always **derived from state, never stored**: draft 1 renders as
`blocksToMd(log) + tail(demoted text) + tag-or-marker`; draft 2 renders as
`tail(candidate text)` or the bare spinner. The same builder renders live
drafts and the persistent sends, so demotion, the ✔ flip, and finalization
cannot drift apart.

### Events (all already wired in `index.ts`)

| Event | Action |
|---|---|
| `agent_start` | create draft 1 (spinner, `can_stop`, `keep_on_stop`); phase = work. Muted → no drafts at all. |
| `message_start` (assistant) | open the candidate window: tail = {candidate, ""} |
| `message_update` | inspect `event.message.content` in order: `text` parts → tail (routed by mode); `thinking` parts → `thinking[]`; a `toolCall` part present → **demote** (once): tail = {demoted, ""}, wipe slot to spinner. The slot draft is created lazily on the first candidate text. |
| `message_end` | **commit** the finished message: scan content in order → narration blocks, tool blocks (`why` = last thinking sentence seen so far), error block if `errorMessage`. If `stopReason ∈ {"stop","length"}` → **confirm**: `finalText` = its text parts concatenated. (`"toolUse"`, `"deferred"` → run continues; `"aborted"`/`"error"` → end states, §5.) |
| `tool_execution_start` | mark the committed tool block (by `toolCallId`) `running` (it was committed with `…` at message_end; the start just guards ordering) |
| `tool_execution_end` | stamp the block `✔` / `✖` + capture `result` text for `✖` blocks |
| `ui_prompt_start` | append a prompt block to the log |
| `agent_end` | if not finalized → run the end-state finalization (§5) |

### Invariants

- **Max 2 drafts** at all times: draft 1 + the slot (the slot may not exist yet).
- **One slot for the run**: never a second draft_id per run; demotion wipes
  content, never the draft. Animated changes (same id) only — no 30 s ghosts.
- **Switch is one-way**: once confirmed/finalized, no more draft updates;
  the heartbeat stops.
- **Text-less candidates never flicker**: the slot wakes only on real text.
- Draft updates stay best-effort and paced (single in-flight send queue, global
  `streamEditMs` throttle, 429 cooldown — all existing mechanics). Persistent
  sends are the only retried path (§5).

## 3. Message 1 — work log spec

Chronological blocks, **each on its own lines, separated by one blank line** —
never merged into continuous prose.

### Block types

```
narration { text }     // a message's visible text, verbatim markdown
   tool { id, name, keyArg, argsJson, why?, state: "…"|"✔"|"✖", errorText? }
   prompt { text }       // user follow-ups while running (ui_prompt)
   agentError { text }   // provider/API failures, in the order they happened
```

### Tool block rendering

````
⚙ read src/app.ts            ← line 1: ⚙ + name + key-arg preview + state stamp
💭 "the test expects a 302, so I need to see the handler"   ← line 2 (only if why)
<details><summary>params</summary>

```json
{"path": "src/app.ts"}
```

</details>
<pre>RangeError: Invalid …</pre>    ← only on ✖, visible (not collapsed)
````

- `keyArg` — same heuristic as today's `toolPreview` (first meaningful arg,
  trimmed to `toolPreviewChars`).
- `why` — **one sentence that motivated the call**, only when the model
  produced thinking for this message. Extracted as the last sentence of the
  thinking stream seen before this tool call in content order (sentences split
  on `.!?` boundaries; last non-empty chunk; truncated to 200 chars). Redacted
  thinking → no `why`. Models without thinking → no `why` (the narration block
  above already carries the visible explanation). Italic, `💭`-prefixed,
  HTML-escaped — tied to this tool block, not a standalone block.
- `argsJson` — the tool's arguments, JSON, pretty but capped (~2 KB);
  HTML-escaped inside a mono fence in the collapsed `<details>`.
- `errorText` — from `tool_execution_end`'s `result`, truncated to 400 chars,
  HTML-escaped into a visible `<pre>` under the block. Success shows `✔` only.

### Bottom line (tag / marker)

| Phase | Bottom line |
|---|---|
| working | `<tg-thinking>thinkingWord…</tg-thinking>` (word rotates on heartbeat) |
| clean end | `Completed ✔️` (the tag is *replaced*, never deleted while live) |
| error end | `⚠ Error` |
| manual stop | **removed, no marker** (the bridge's `⏹ Stopping… ✔️` message carries the signal) |

### Sizing & escaping

- Live draft: `tailView` at `RICH_CAP` (32768) so the draft never overflows.
- Persisted message 1: the **full** log (chunked via `chunkRich` if needed) —
  the tail view only shapes the live draft.
- Model narration renders verbatim through the existing markdown tier
  (`inlineToHtml`); all bot-generated text (tool names, JSON, errors, markers)
  is HTML-escaped.

## 4. Message 2 — candidate slot spec

The slot is **one draft for the whole run** — a fixed `draft_id` (created
lazily), never replaced by a new one.

### States

```
absent      — run started, no candidate text yet (draft not created)
composing   — spinner only: <tg-thinking>thinkingWord…</tg-thinking>
              (initial state after creation; also the demotion state)
candidate   — streaming the current message's text (clean answer markdown,
              no tag inside the candidate content)
```

### Lifecycle per assistant message

1. `message_start` → candidate window opens (tail = candidate).
2. First `text` part arrives → slot created (if absent) / wakes from
   composing → content streams the candidate, paced like draft 1 updates.
3. A `toolCall` part appears → **demote**: tail.mode = demoted, slot content
   wiped back to the composing spinner, `hasContent` = false. (Two paced
   updates — the wipe and the draft-1 tail — may briefly show the line in
   both places; accepted, sub-second.)
4. `message_end` commits the message to the log; the tail resets to none.

### Confirmation

When `message_end` arrives with `stopReason ∈ {"stop","length"}`, the slot is
already holding the complete answer — finalization simply persists it
(§5). There is **no replay, no fast-forward**: whatever the user watched
stream is exactly what message 2 becomes.

### Rules

- The slot never contains the `<tg-thinking>` tag inside candidate content
  (the persisted answer must be a clean final message; `tg-thinking` is
  draft-only per the Bot API).
- Between candidates the slot sits at the composing spinner; the 17 s
  heartbeat keeps it alive (and draft 1's). It reads as "composing the
  answer", which is literally true while the run is in flight.
- `hasContent` = the slot currently (or last) held real candidate text —
  drives whether message 2 gets persisted on stop/error end states (§5).
- `keep_on_stop: true` on the slot draft, same as draft 1.

## 5. End states & finalization mechanics

### Finalization sequence (clean end)

Triggered at the confirming `message_end` (not `agent_end` — the answer is
complete and waiting in the slot the moment the message finishes):

1. `finalLog` = log + `Completed ✔️` bottom line.
2. Best-effort draft-1 update with `finalLog` (throttle-bypassed) so the
   spinner visibly flips to `Completed ✔️` before the message freezes.
3. **Persist message 1** — `sendRichMessage(finalLog)`, full log, chunked via
   `chunkRich` if > 32768. This persistent send kills the live drafts.
4. **Persist message 2** — `sendRichMessage(finalText)` (the slot content),
   chunked the same way.
5. Stop the heartbeat; phase = finalized.

Steps 3–4 use the existing delivery fallback chain (markdown → HTML → plain)
and **retry up to 3 times with 1 s / 2 s / 4 s backoff** (honoring `retry_after`
on 429) — these are the only retried sends in the mirror; draft updates stay
best-effort. Order matters: message 1 before message 2 (chronology).

### End-state table

| End | Message 1 persisted | Message 2 persisted | Extra |
|---|---|---|---|
| **Clean, log non-empty** | full log + `Completed ✔️` | the answer | — |
| **Clean, log empty** (zero tool calls, straight answer) | **skipped** (would be just `Completed ✔️`; draft 1 expires) | the answer | — |
| **Manual stop** | log with bottom tag **removed, no marker** (skipped if log empty) | partial candidate **as-is** (skipped if spinner-only) | bridge sends `⏹ Stopping…` then stamps `⏹ Stopping… ✔️` (unchanged) |
| **Error** (provider/API, or message `errorMessage`) | log + error block + `⚠ Error` | partial candidate + trailing `⚠ incomplete` line (skipped if spinner-only) | — |
| **Muted** | nothing | nothing | nothing (no drafts are ever created) |

Notes:

- "Log empty" = no committed blocks (no narration, no tools, no errors, no
  prompts).
- On error/stop the partial candidate is whatever the slot last held — it may
  be mid-sentence; that's the point of persisting it (the 30 s ephemeral
  window must not eat it).
- If a persistent send fails all 3 retries, the TUI gets an error notification
  (existing `safe()` path); the drafts may then expire — same known limitation
  as today, no new failure mode.
- `agent_end` after a confirmed end is a no-op (phase = finalized guard).
- Steer (new user prompt mid-run) = a new run → a fresh pair of messages;
  nothing is merged across runs.

## 6. Code plan & TDD order

### Files

| File | Change |
|---|---|
| `src/mirror.ts` | Rewrite around the §2 state machine: log model + `blocksToMd` builder, candidate slot + demotion, confirmation, end-state finalization (order, retries, chunking, fallback), heartbeat for both drafts. Public API keeps today's names (`onAgentStart`, `onAssistantStart`, `onAssistantUpdate`, `onAssistantEnd`, `onToolStart`, `onToolEnd`, `onUiPromptStart`, `onAgentEnd`). |
| `src/markdown.ts` | Small pure helpers: tool-block rendering (details/summary + mono fence + `<pre>`), `why`-sentence extraction (last-sentence + 200-char cap). Reuses `escapeHtml`, `tailView`, `chunkRich`. |
| `src/telegram-client.ts` | `keep_on_stop` param on `sendRichMessageDraft` (field + type). |
| `src/wiring.ts` | `Out.sendDraft` / `ClientLike` pass `keep_on_stop` through. |
| `index.ts` | One line: `onToolEnd(event.toolCallId, event.isError, event.result)` — result text feeds `✖` blocks. |
| `src/session-bridge.ts` | **Unchanged** — the `⏹ Stopping…` / `✔️` stamp flow already exists. The mirror drops its old plain `⏹ interrupted` and `⚠️ error:` sends (the log now carries both). |

### TDD order (red → green per step)

1. **Content builder** (pure): `blocksToMd` — block layout & blank-line
   separation, tool-block rendering (details, `why`, error `<pre>`), tag /
   marker bottom lines (spinner / `Completed ✔️` / `⚠ Error` / stripped),
   escaping, `tailView` at the cap. Plus `why`-sentence extraction (incl.
   redacted/absent cases).
2. **Slot state machine** (fake `Out`): candidate → demote → re-candidate →
   confirm; text-less candidates create no slot; spinner-only slot; demotion
   wipes content but keeps the draft_id; one-way switch after finalize.
3. **Finalization**: send order (flip → m1 → m2), chunking > 32768, fallback
   chain, 3-attempt retry with backoff and `retry_after`.
4. **End states** (all five table rows), incl. empty-log skip and
   partial-candidate persistence on stop/error.
5. **Client**: `keep_on_stop` forwarded (fake fetch).
6. **Wiring smoke**: `onToolEnd` result forwarding; bridge stop flow
   regression (existing tests keep passing).

Test files: `tests/mirror-stream.test.ts`, `mirror-tools.test.ts`,
`mirror-end.test.ts`, `mirror-failures.test.ts`, `mirror-mute.test.ts` get
rewritten against the new model; `mirror-helpers.ts` / `fake-pi.ts` extended
for multi-message runs and `tool_execution_end` results. Run with
`node --test tests/` (no timeouts issues — suite is fast and local).

## 7. Out of scope & validation notes

Out of scope (this run):

- Merging history across runs (each run = its own log + answer pair).
- Editing/undo of persisted messages; deleting drafts (drafts can only expire
  or be killed by a persistent send).
- Non-assistant messages in the log (user prompts arrive via `ui_prompt_start`
  only; raw user turns are not mirrored).
- Streaming tool *results* (only the error `result` text is captured).
- Per-block collapsing of narration (narration stays plain text).

Validate against live docs before implementing (per AGENTS.md — live docs win):

- Bot API: `keep_on_stop` semantics on `sendRichMessageDraft`; that
  `<tg-thinking>` is draft-only and a `sendRichMessage` with the same content
  replaces/kills the ephemeral draft; `can_stop` behavior on a draft whose
  content is only the spinner.
- Pi extension events: `message_start`/`message_update` ordering and that
  partial `toolCall` parts appear in `event.message.content` as they stream
  (the demotion trigger); `tool_execution_end` carries `result`.

## Implementation entry point

Start at TDD step 1 (`blocksToMd` + `why` extraction) — pure functions, no
fakes needed. The slot machine (step 2) builds on top of the builder.
