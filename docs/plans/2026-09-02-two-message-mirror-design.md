# LLM mirroring — single-draft design (work log + answer split)

Status: **implemented** — two-draft design validated 2026-09-02, revised on
2026-09-03 into the single-draft flow described here (the flow that shipped).

Supersedes the streaming/drafting sections of `2026-08-31-rich-messages-design.md`.
That doc's delivery mechanics (rich → HTML → plain fallback chain, `tailView`,
`chunkRich`, 429 cooldown) remain valid and are reused.

## Contract

One agent run produces **exactly 1 live rich draft** for the whole run, and
**at most 2 persistent rich messages**:

1. **The draft** carries everything while the run is in flight: a
   chronological **work log** (model narration, tool calls with their "why"
   and params, errors), the **in-flight message text** (the tail — the
   current message's text, streaming live), and a bottom line — a
   `<tg-thinking>` spinner while working, replaced by `Completed ✔️` on a
   clean end, or removed (no marker) on error / manual stop — on an error
   the `⚠️ error: …` log block is the only signal (no second `⚠ Error`
   line).
2. **The clean end splits into two messages**: the draft first shows the
   COMPLETED STATE (log + `Completed ✔️` + the answer, NO divider —
   the final composed message is visible in the draft), then **message 1**
   persists as the work log + `Completed ✔️` (the answer is CUT from it — and
   this send also finalizes the draft: per the Bot API, any message sent to
   the chat instantly clears the ephemeral drafts), and **message 2** is the
   final answer, sent as its own regular `sendRichMessage`. End state: the
   tool log is the previous message, the answer is the new one. Stop/error
   ends persist a single message instead — and an ERROR end persists only
   at `agent_settled` (the end of the WHOLE stream — verified in pi
   0.84.4/0.85.0: the auto-retry and its backoff run inside the prompt's
   continuation loop, BEFORE settled): never at `agent_end` (pi auto-retries
   retryable provider errors) — a retry that arrives carries over the live
   work log instead (§5.4); the grace timer (`errorSettleMs`, 5 s default)
   is the backstop only, persisting the error log if `agent_settled` is
   lost. While the stream is open the draft keeps the ⚠️ line, a `---`
   divider and the spinner (§5.4).

## Progress

- [x] 0. Header, status, contract, outline
- [x] 1. Goal & final look (worked example)
- [x] 2. Architecture: state machine
- [x] 3. Message 1 — work log spec
- [x] 4. Message 2 — candidate slot spec
- [x] 5. End states & finalization mechanics
- [x] 6. Code plan & TDD order
- [x] 7. Out of scope & validation notes
- [x] Addendum: retry carryover & settle grace (§5.4) — a 502 mid-run no longer wipes the live draft; the auto-retry's run continues the un-persisted work log, and the error log is persisted at `agent_settled` (grace timer = backstop for a lost settled)
- [x] Revision 2026-09-05: the 0.84.4/0.85.0 dist check proved the original
  premise wrong — `agent_settled` fires only AFTER the whole continuation
  loop (retries + their backoffs + compactions), never between `agent_end`
  and the retry's `agent_start`. So the error end now finalizes AT
  `agent_settled` (the grace timer demoted to backstop), and while the
  stream is open the draft shows ⚠️ line → `---` divider → spinner (the
  spinner no longer disappears for the retry's backoff). See §5.4.
- [x] Revision 2026-09-05 (token display): the live bottom-line spinner and
  the finalized `Completed ✔️` line now carry the run's cumulative token
  usage — ` ↑<input> ↓<output>` (e.g. `Thinking… ↑567 ↓12.5k`,
  `Completed ✔️ ↑567 ↓12.5k`); the session card and `/status` carry the
  session's cumulative usage on a `🪙 tokens: …` line above the messages
  line. See the 2026-09-04 message-framework design (bottom-line rule +
  change log).

## 1. Goal & final look

What the user sees in the chat for a typical run:

```
[while working — ONE live draft]
  ┌ <tg-thinking>…</tg-thinking>
  │
  │ Let me check the failing test.
  │ ⚙ read tests/app.test.ts …
  │   💭 "the test expects a 302 …"
  │ ⚙ edit src/app.ts ✖
  │   <pre>RangeError: …</pre>
  │ The fix works. Here is what I      ← the answer streams in,
  │ changed: …                            token by token, ABOVE the spinner
  │                                       ← extra blank line (NBSP) whenever
  │ <tg-thinking>…</tg-thinking>           there is text above the spinner
  └                                       (spinner only → no blank line)

[after a clean end — the draft completes, then splits into two messages]
  draft (momentarily):          msg 1 (persistent — the tool log):
  … same content, but          Let me check the failing test.
  <tg-thinking> becomes        💭 "the test expects a 302 …"
  "Completed ✔️" before        <details><summary>⚙ read tests/app.test.ts …</summary>
  the answer —                 …(args)…
  NO divider:                  💭 "the edit failed, check the error first"
  Completed ✔️                 <details><summary>⚙ edit src/app.ts ✖</summary>
  The fix works. …             <pre>RangeError: …</pre>
                                Completed ✔️

                                msg 2 (persistent — the answer):
                                The fix works. Here is what I changed: …
```

Properties:

- Exactly ONE draft for the whole run (one `draft_id`, spawned at
  `agent_start`); it is finalized by the first persistent send (any message
  sent to the chat instantly clears every ephemeral draft — Bot API,
  verified 2026-09-03).
- Never more than 2 persistent messages per run (a clean end splits into
  log + answer; stop/error ends produce one).
- The answer streams live in the draft (no replay, no fast-forward
  artifact); what the user watched stream is exactly what message 2 becomes.
- No flicker: a tool call mid-stream does NOT wipe the in-flight text (the
  old slot design wiped it — revised 2026-09-03 after live feedback); the
  text commits to the log at `message_end` and the tail clears.
- Message 1 is the complete record (full text, chunked if > 32768); the
  draft is capped by `tailView`.

## 2. Architecture: state machine

One `Mirror` instance per run (recreated on `agent_start`, as today).

### State

```ts
log: LogBlock[]            // committed, chronological (see §3)
draftId: number            // the run's single draft id (0 = not spawned yet)
tail: string               // in-flight text of the current assistant message;
                           // the confirmed answer once the run confirms
endKind: "clean" | "stop" | "error" | undefined
phase: "work" | "finalized" // one-way switch
// + pacing (shared by all draft senders): nextDraftAt, forceNext, pending,
//   inflight, drainTimer, hbTimer, thinkingWord (rotating heartbeat word),
//   draftFailStreak
```

Content is always **derived from state, never stored**: the draft renders as
`blocksToMd(log, { tail, bottom })` — `[blocks] [tail] [blank line]
[spinner]` while working (the extra blank line — an NBSP paragraph —
appears whenever there is text above the spinner; spinner alone → no
blank line), `[blocks] [Completed ✔️] [tail]` in the completed state (no
divider — the answer is its own message anyway). The
SAME builder renders the live draft, the completed-state preview, and the
persistent sends, so the split cannot drift from what the draft showed.

### Events (all already wired in `index.ts`)

| Event | Action |
|---|---|
| `agent_start` | create draft 1 (spinner, `can_stop`, `keep_on_stop`); phase = work. Muted → no drafts at all. If the previous run ended in an error and was never persisted → **carry over its live work log** (do NOT clear it — the retried/continued run appends; the draft must not visually lose the tool calls the user watched; §5.4). |
| `message_start` (assistant) | tail = "" (the message's text accumulates from its parts); the first send of a new message breaks through the throttle window (one-shot `forceNext`) |
| `message_update` | accumulate the `text` parts into the tail and request an update if the tail is non-empty. A `toolCall` part mid-stream is IGNORED — it must not wipe the in-flight text (that was the old flicker). Textless candidates never update. |
| `message_end` | **commit** the finished message: scan content in order → narration blocks (text before each tool call), tool blocks (`why` = last thinking sentence seen so far), error block if `errorMessage`. If `stopReason ∈ {"stop","length"}` **and the message has no tool calls** → **confirm**: tail = its text (the answer), endKind = clean, finalize (§5). A `"length"` stop WITH tool calls does NOT confirm (pi fails those truncated calls and the loop continues). Tool-carrying / mid-run messages: their text commits to the log, tail = "". `"aborted"`/`"error"` with no tools: the text stays as the partial-answer tail (not a log block — no duplication). |
| `tool_execution_start` | mark the committed tool block (by `toolCallId`) `running` (it was committed with `…` at message_end; the start just guards ordering) |
| `tool_execution_end` | stamp the block `✔` / `✖` + capture `result` text for `✖` blocks |
| `ui_prompt_start` | append a prompt block to the log |
| `agent_end` | if not finalized **and the end is not an error** → run the end-state finalization (§5). An ERROR end does NOT finalize — the draft stays alive (⚠️ line + `---` divider + spinner; pi is still working — it auto-retries retryable provider errors, 429/5xx/…, up to `retry.maxRetries` runs, backoff 2·2ⁿˢ, all BEFORE `agent_settled`) and it arms the settle grace timer (`errorSettleMs`) as the backstop for a LOST `agent_settled` (the primary finalize trigger; §5.4). |
| `agent_settled` | pi's “no automatic retry, compaction, or queued continuation will run” — the end of the STREAM (fires in the `finally` of `_runAgentPrompt`, AFTER the whole continuation loop — retries and their backoffs included — verified in 0.84.4/0.85.0). A run that ended with no message at all → finalize as stop. A live ERROR end is persisted HERE (the stream cannot continue anymore; a retry that came first already carried the log over — no double-post). |

### Invariants

- **Exactly 1 draft** at all times: one `draft_id` per run, spawned at
  `agent_start`; animated updates (same id) only — no 30 s ghosts.
- The in-flight tail is never wiped by a mid-stream tool call (the
  2026-09-03 flicker fix): it commits to the log at `message_end`.
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
💭 "the test expects a 302, so I need to see the handler"   ← the why first (only if why)
<details><summary>⚙ read src/app.ts ✔</summary>   ← ⚙ + name + state stamp IS the
                                             summary (no separate "params" label)

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
| error end | **no marker** (the `⚠️ error: …` log block in the work log is the signal) |
| manual stop | **removed, no marker** (the bridge's `⏹ Stopping… ✔️` message carries the signal) |

There is NO horizontal divider between the work log and the answer
ANYWHERE (revised 2026-09-04): the answer is split into its own message
anyway, so the `---` line had no purpose.

Separating the `<tg-thinking>` spinner from the text above it
(revised 2026-09-05, live A/B in the user's chat): an **extra blank
line** — a single NBSP (\u00a0) paragraph — is emitted between any text
(blocks and/or the streaming tail) and the spinner; spinner alone (fresh
run) → no blank line. The earlier `---`/`<hr/>` line was rejected in the
A/B: directly under a tool `<details>` block it rendered as a double
line (the details handle + the rule). NBSP works in BOTH render paths:
rich markdown (the server renders it as an empty line) and the local
markdown→HTML fallback (escapeHtml leaves the literal character alone);
in the plain fallback a line-trim may drop it — acceptable graceful
degradation.

### Sizing & escaping

- Live draft: `tailView` at `RICH_CAP` (32768) so the draft never overflows.
- Persisted message 1: the **full** log (chunked via `chunkRich` if needed) —
  the tail view only shapes the live draft.
- Model narration renders verbatim through the existing markdown tier
  (`inlineToHtml`); all bot-generated text (tool names, JSON, errors, markers)
  is HTML-escaped.

## 4. The tail — in-flight text (replaces the candidate slot)

The 2026-09-03 revision collapsed the second draft (the "candidate slot")
into the single draft: the current message's text is the **tail**, rendered
inside the draft between the work log and the spinner.

### Lifecycle per assistant message

1. `message_start` → tail = "".
2. `message_update` → tail = the accumulated `text` parts; the draft shows
   [log] [tail] [spinner], paced like every other draft update.
3. A `toolCall` part appears mid-stream → **nothing visible changes**: the
   tail keeps streaming (a tool call carries no text; wiping the tail here
   was the old flicker bug).
4. `message_end` commits the message: if it carried a tool call, the text
   becomes a narration block in the log and the tail clears — the text keeps
   its place, now at the end of the log. If it is the answer (no tools,
   stop/length), the tail becomes the confirmed answer and finalization runs
   (§5).

### Confirmation

Confirm = `message_end` with `stopReason ∈ {"stop","length"}` **and zero tool
calls in the message**. A `"length"` stop WITH tool calls is a pi
continuation (the truncated calls fail and the loop goes on), so it does not
confirm. There is **no replay, no fast-forward**: whatever the user watched
stream is exactly what message 2 becomes.

### Rules

- The tail never contains the `<tg-thinking>` tag (the tag is the separate
  bottom line; `tg-thinking` is draft-only per the Bot API and must not
  reach a persistent message).
- Textless candidates (only tool calls / thinking) never trigger a draft
  update — no flicker.
- `keep_on_stop: true` on the draft; the completed-state preview goes out
  with `can_stop: false` (the run is over).

## 5. End states & finalization mechanics

### Finalization sequence (clean end)

Triggered at the confirming `message_end` (not `agent_end` — the answer is
complete the moment the message finishes). THREE steps, in order:

1. **Completed-state draft** — one final `sendRichMessageDraft` on the run's
   draft: [log] `Completed ✔️` [answer] (`can_stop: false`, no divider).
   The user sees the final composed message: the spinner is replaced by
   the marker, the answer stays where it was streaming. Best effort — a
   429/400
   here does not block the persistent sends (the draft dies with m1 anyway).
2. **Message 1 — work log + `Completed ✔️`** — `sendRichMessage`, full log,
   chunked via `chunkRich` if > 32768. The answer is **CUT** from it
   (there is no divider to begin with). This send also
   **finalizes the draft**: per the Bot API, ANY message sent to the chat
   instantly clears every ephemeral draft, and `sendRichMessage` has no
   `draft_id` (no in-place promotion) — so m1 replaces the completed-state
   preview in one client-side transition.
3. **Message 2 — the answer** — `sendRichMessage(answer)`, chunked the same
   way. End state: the tool log is the previous message, the answer is the
   new one.

**Notification rule:** m1 is sent with `disable_notification: true` — the
work log is a mirror artifact and must not buzz. Only m2 (the final answer)
notifies. Drafts cannot carry `disable_notification` (the Bot API's draft
methods have no such parameter), so the silence lives on the persistent
send only. The flag survives the rich → HTML → plain fallback chain (all
three levels pass `disable_notification`), and the stop/error single-message
send still notifies — it *is* the final word.

The one-way switch flips and the heartbeat stops FIRST; no draft updates
ever follow a persistent send (verified on the wire 2026-09-03).

Steps 2–3 use the existing delivery fallback chain (markdown → HTML → plain)
and **retry up to 3 times with 1 s / 2 s / 4 s backoff** (honoring
`retry_after` on 429) — these are the only retried sends in the mirror; the
completed-state draft update stays best-effort. If m1 fails all 3 attempts,
m2 is never attempted and `finalize` rejects. Order matters: preview → m1 →
m2 (chronology).

### Stop / error ends — single message

No split: ONE persistent send with the final layout —
- **stop** (finalized at `agent_end`): [log] [partial tail] (no marker, no
  spinner);
- **error** (persisted at `agent_settled` — never at `agent_end`: pi may
  auto-retry, and the retry's continuation CARRIES THE LOG OVER instead,
  §5.4; the grace timer after `errorSettleMs` is the backstop for a lost
  settled): [log + `⚠️ error:` block] [partial tail + trailing
  `⚠ incomplete` line] — no `⚠ Error` marker (the log block says it), no
  divider, no spinner.

While the stream is open (a retry may still be in its backoff), the draft
stays alive (heartbeat) showing the error state: [log] [partial tail]
`⚠️ error: …` line, a full-width `---` divider, then the `<tg-thinking>`
spinner (pi is still working).

### Retry carryover & settle grace (§5.4)

For an auto-retry, pi emits `agent_end` → (backoff) → `agent_start` — and
`agent_settled` only at the end of the WHOLE stream (after the last retry's
attempt): the retry and its backoff delay run inside the prompt's
continuation loop (`_handlePostAgentRun` → `_prepareRetry` →
`agent.continue()`), all BEFORE the `finally` that emits `agent_settled`
(verified in pi 0.84.4/0.85.0 dist). The mirror therefore:

- **carries over**: `agent_start` while the previous run is a live error end
  (never persisted) keeps the work log — the continued run appends to it, the
  draft never visually loses the successful tool calls the user watched, and
  the continued run's final m1 carries the whole story in order: [old blocks]
  [`⚠️ error: …`] [retried blocks] [`Completed ✔️`]. The grace timer is
  cancelled — no separate error message is posted.
- **settles**: `agent_settled` while the run is a live error end (no
  continuation came) persists the error log immediately — exactly the
  stop/error single message above. The stream cannot continue anymore, so
  persisting here cannot double-post (a retry that came first already carried
  the log over).
- **grace-backstops**: if `agent_settled` never arrives (lost — a pi flush
  threw before the finally emitted it), the timer fires after `errorSettleMs`
  (5 s default) and persists the error log. Each error end re-arms the timer,
  so chained retries (backoffs 2 s / 4 s / 8 s) keep carrying over — and even
  a final backoff longer than the window can no longer split the run across
  two messages, because the stream's own `agent_settled` finalizes the
  combined log in one message.
- **fast new prompt inside the retry window** (the user sends the next prompt
  before the error was persisted, e.g. during a retry's backoff) continues
  the live log — the same session context continues, so the combined m1 is
  truthful and nothing is lost.
- **run after the settle-finalization** starts clean (the old log was already
  persisted).

Invariants: an error log is persisted **at most once** (`agent_settled`, the
lost-settled backstop, or the continued run's own end — never more); the
live draft never loses already rendered blocks across a continuation;
`whenSettled` resolves when the persistence actually happened (settle →
finalize) or when a new run started (as before).

### End-state table

| End | Draft's last state | Message 1 | Message 2 |
|---|---|---|---|
| **Clean** (answer confirmed) | completed state: log + `Completed ✔️` + answer (no divider) | log + `Completed ✔️` (answer cut) — **always sent**, even with an empty log (then just the marker) | the answer |
| **Manual stop** | (killed by m1) | log + partial tail (skipped when both are empty) | — |
| **Error** (provider/API, or message `errorMessage`; persisted at `agent_settled` — or carried into the continued run's m1) | ⚠️ line + `---` + spinner while the stream is open; then (killed by the persistent send) | log + error block (+ partial + `⚠ incomplete` when there is a partial tail) — no `⚠ Error` marker, no spinner, no divider | — |
| **Muted** | never spawned | nothing | nothing |

Notes:

- The bridge's `⏹ Stopping…` / `⏹ Stopping… ✔️` stamp flow is unchanged.
- On error/stop the partial tail is whatever the draft last showed — it may
  be mid-sentence; that's the point of persisting it (the 30 s ephemeral
  window must not eat it).
- If a persistent send fails all 3 retries, `finalize` rejects — the
  wiring's `safe()` path notifies the TUI; the drafts may then expire — same
  known limitation, no new failure mode.
- `agent_end` / `agent_settled` after a confirmed end are no-ops (phase =
  finalized guard).
- Steer (new user prompt mid-run) = a new run → a fresh draft + fresh
  messages; nothing is merged across runs.

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
3. **Finalization**: send order (m1 → m2, no flip — any persistent send
   clears all drafts), chunking > 32768, fallback chain, 3-attempt retry with
   backoff and `retry_after`.
4. **End states** (all five table rows), incl. empty-log skip and
   partial-candidate persistence on stop/error.
5. **Client**: `keep_on_stop` forwarded (fake fetch).
6. **Wiring smoke**: `onToolEnd` result forwarding; bridge stop flow
   regression (existing tests keep passing).

Test files: `tests/mirror-stream.test.ts`, `mirror-tools.test.ts`,
`mirror-end.test.ts`, `mirror-failures.test.ts`, `mirror-mute.test.ts` get
rewritten against the new model; `mirror-helpers.ts` / `fake-pi.ts` extended
for multi-message runs and `tool_execution_end` results. Run with
`node --test tests/*.test.ts` (the directory form fails on Windows).

Final test layout (single-draft revision): `mirror-tools.test.ts` (builder +
tool rendering), `mirror-stream.test.ts` (single-draft streaming: one id,
tail never wiped by tool calls, re-candidate, one-way switch),
`mirror-finalize.test.ts` (three-step clean split, chunking, fallback chain,
429/backoff, m1-failure aborts m2), `mirror-end.test.ts` (end-state table),
`mirror-mute.test.ts`, `index-smoke.test.ts` (full wiring on the wire).

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
