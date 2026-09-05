# Message Framework — all commands, drafts, stamps & notifications

**Date:** 2026-09-04 · **Status:** design complete (all decisions confirmed with user), implementation pending
**Supersedes/extends:** `2026-09-02-two-message-mirror-design.md` (run finalizations D1–D4 live there;
this doc owns the command/ack/lane rules and unifies notifications across the whole bot).

Goal: every user-visible message is categorized into one of five patterns and follows the same
notification logic — no custom-made one-offs.

## Chunk tracker

- [x] Chunk 0 — header + outline
- [x] Chunk 1 — message patterns (A–E) + notification rules (N1–N6)
- [x] Chunk 2 — master tables (finalized messages, exact strings, notify flags)
- [x] Chunk 3 — behavior deltas vs current code (what changes, per command)
- [x] Chunk 4 — TDD implementation plan + verification

**Spec complete 2026-09-04. Implementation pending — Phase 1 findings get
appended to §6.1 as they are verified.**

---

## 1. Message patterns (A–E)

Every user-visible message belongs to exactly one pattern.

### A — Ack (synchronous action)

The action completes in seconds or is instantaneous (no long LLM work).

- Lifecycle: plain send → optional **edit-stamp**: ` ✔️` appended to the *same*
  message after the awaited part settles (e.g. `⏹️ Stopping…` → `⏹️ Stopping… ✔️`).
- Rejections ("busy", "idle", "expired", usage errors) are also pattern A.
- Used by: `/stop`, `/reload`, `/new`, session switch (idle), `/sessions`,
  `/model`, `/thinking`, `/name`, `/mute`, `/unmute`, `/shutdown`, `/help`,
  `/status`, unknown commands, prompt-while-busy ("⚡ queued").

### B — Lane 1 (long-running action)

The action's own work is a long LLM call. Boundary: expected duration ≳ 10 s
with model work in it (compaction qualifies; `/reload` and stop-wait do not —
no LLM, seconds → they stay pattern A).

- Lifecycle: **new ephemeral draft** showing the status text inside
  `<tg-thinking>` → on completion the **draft is updated to the stamped
  success text** (status is *replaced*, not appended) → **finalized**: sent
  persistently (notifying) and the draft is cleared.
- Failure/cancellation: the draft is finalized with the failure/cancellation
  message (notifying).
- Used by: `/compact` (idle, or after aborting a busy run — see B2).

### C — Lane 2 (auto-command)

System-triggered status around an ongoing or imminent run — the status lives
*inside the run's draft*, never as its own message. Generic mechanism;
auto-compaction is the first (and only current) instance.

- **Active draft exists** (run draft, including the early pre-run draft): the
  draft's bottom-line spinner is **replaced** by the status text
  (`🗜 Auto-compacting…`); on completion the spinner is **restored** and the
  **stamped success line is appended to the log area as a regular log line**
  (`🗜 Context auto-compacted ✔️ — <detail>`); the draft keeps going until the
  run finalizes normally.
- **No active draft** (e.g. between runs): degrades to **lane 1 (B)** with the
  auto strings.
- **Failure** (Phase-1-verified: pi **continues the prompt un-compacted** —
  `_checkCompaction` returns false and the prompt is sent anyway): the bot
  posts a **standalone notifying message** `⚠️ <pi errorMessage>` — pi's
  `session_compact_failed.errorMessage` is already formatted (`Auto-compaction
  failed: <msg>` / `Context overflow recovery failed: <msg>`), so it is used
  verbatim (no double prefix). Any live draft **continues unaffected** (the
  run proceeds). No draft finalization on failure.
  (`aborted && !errorMessage` — teardown/cancel — is silent.)
- Used by: auto-compaction (threshold/overflow).

**pi event facts (Phase 1, verified 2026-09-04/05 in pi-coding-agent
0.84.4 dist — CORRECTED 2026-09-05, see Change log):**

- The extension-visible compaction events are `session_before_compact`,
  `session_compact` and `session_compact_failed` — all three fire for **both
  manual and auto** paths. `compaction_start` / `compaction_end` are INTERNAL
  (TUI-facing) events emitted via `this._emit` and are **NOT** routed to
  extensions — the original claim here was wrong.
- `session_compact` carries `compactionEntry` (a `CompactionEntry`): it has
  `tokensBefore`, but **no** `estimatedTokensAfter` is exposed to
  extensions, and `getContextUsage().tokens` is `null` right after a
  compact → the auto `<detail>` is `<before> tokens` only (e.g.
  `128,432 tokens`). The manual `<before> → <after> tokens` detail comes
  from the `ctx.compact()` callback instead (unchanged).
- `session_compact_failed` carries `{ reason, errorMessage?, aborted,
  willRetry }`; `aborted && !errorMessage` = teardown/cancel → silent.
- `reason`: 0.84.4 auto = `"threshold"` | `"overflow"`, 0.85.0 auto =
  `"auto"`, manual = `"manual"` (both versions) — the code treats
  `reason !== "manual"` as auto (version-safe).
- `session_before_compact` hook (reason, willRetry, signal, preparation): the
  current handler intercepts `reason === "manual"` only; auto is observed by
  **not** returning `{ cancel }` / `{ compaction }`.
- Auto cases: (1) overflow-with-retry — post-`agent_end`, compact, then
  `agent.continue()` retry: the mirror draft is still alive (errorSettle grace
  pending), so lane-2 applies **between the error end and the retry start**;
  the stamped line survives the carry-over into the retried run's m1.
  (2) overflow-without-retry and (3) threshold — post-run or **pre-prompt**
  (pre-prompt check runs inside `prompt()`, before `_runAgentPrompt`).
- `isIdle()` stays **true** during pre-prompt compaction (`_isAgentRunActive`
  is only set in `_runAgentPrompt`). Consequences: a second prompt in that
  window is accepted as a **steer** ("⚡ queued") — pi explicitly delivers
  queued steering messages after auto-compaction; `/stop` in that window
  answers A2 (`Nothing to stop — session is idle.`) — the compaction is
  pi-internal, not bot-abortable.
- `newSession()` **aborts the active run first** (`teardownCurrent` →
  `await session.abort()`, then `session_shutdown`, dispose, `session_start`
  reason `"new"`) — A8 exists; the D4 silent final lands during
  `pi.newSession()`'s await, before the stamp + card.
- `CB.sessionOk` (`so:<i>`) callback data is produced **only** by the
  confirm-callback message removed in 5.5 → router entry, `handleSwitchOk`,
  and command-args INDEX entry can be deleted (tests: bridge-sessions
  `switchOk` test, command-args `switchOk` case, router `sessionOk` case).

### D — Run finalization (the mirror)

The run's own end; the live draft becomes the persistent message(s).
(Retry-carryover mechanics — see
`2026-09-02-two-message-mirror-design.md` §5.4; the settle trigger was
revised on 2026-09-05: the error end finalizes AT `agent_settled`, the
grace timer is the backstop for a lost settled.)

- **D1/D2 — clean end:** m1 = log + `Completed ✔️` (silent) → m2 = the answer
  (notifies).
- **D3 — error end** (provider error; the stream is over —
  `agent_settled`): single message = log + bottom line
  `⚠️ error: <msg>` (+ `⚠ incomplete` trailer if the answer is partial) —
  notifies, no spinner, no divider. While the stream is still open (the
  retry's backoff, a recovery compaction) the live draft shows the ⚠️ line,
  a full-width `---` divider, and the `<tg-thinking>` spinner (pi is still
  working — the spinner is no longer frozen off during the backoff).
- **D4 — aborted end** (killed by `/stop`, `/compact`-mid-run, `/new`-mid-run):
  single message = log + bottom line `⚠️ Request was aborted` — silent.
- **Bottom-line rule (unified):** the draft's bottom line (the live-spinner
  slot) is the *outcome stamp*: `Completed ✔️` / `⚠️ error: <msg>` /
  `⚠️ Request was aborted`. The ⚠️ marker appears **only** in the bottom-line
  slot — never duplicated as a line inside the log area. (This changes D3 vs
  today, where the error is also written into the log area.)

### E — System

Pairing welcome, `/start` (card + help), session cards, not-authorized,
session/model list cards. Plain sends, no drafts.

---

## 2. Notification rules (N1–N6)

- **N1** — the first message of a user-initiated event notifies (the ack).
- **N2** — the **final** message of a long event notifies: lane-1 finals
  (success, failure, cancellation), `m2` (the answer), and a standalone
  failure that follows an ack.
- **N3** — **work-log finalizations never notify:** D1 (clean m1) and D4
  (aborted single). The event's ping already went to the ack or the final.
- **N4** — edits (✔️ edit-stamps) never notify.
- **N5** — drafts never notify (no such API surface on draft methods).
- **N6** — auto-events notify **only on their final** (lane-1 auto final); in
  lane 2 they stay silent until the run's own `m2`.

**Net effect: one ping per event, on its headline message.**

Documented exceptions (confirmed with user):

- a failure *after* an ack pings again (N1 + N2) — you're waiting on the
  outcome;
- multi-message **system** events (E) ping per message (e.g. pairing:
  welcome + card + help).

---

## 3. Stamp semantics (unified)

| Stamp kind | Pattern | Mechanism | Example |
|---|---|---|---|
| edit-stamp | A | same message text + ` ✔️` (editMessageText / draft re-send) | `⏹️ Stopping…` → `⏹️ Stopping… ✔️` |
| draft-stamp | B | draft status text **replaced** by the success message, then draft finalized | `🗜 Compacting context…` → `🗜 Context compacted ✔️ — <detail>` |
| log-stamp | C | stamped line appended to the log area as a regular line; spinner restored | log += `🗜 Context auto-compacted ✔️ — <detail>` |
| bottom-line stamp | D | live-spinner slot becomes the outcome | `⋯ Thinking…` → `Completed ✔️` |

- `✔️` = success (user-confirmed or completed). `⚠️` = failure / cancellation / abort.
- `<detail>` for compaction: **manual** = `<before> → <after> tokens` (en-US
  comma thousands separators) from the `ctx.compact()` callback
  (`tokensBefore` / `estimatedTokensAfter`). **Auto** (DEVIATION 2026-09-05,
  see Change log) = `<before> tokens` only (e.g. `128,432 tokens`) — pi does
  not expose the "after" number to extensions (`session_compact` carries
  `compactionEntry.tokensBefore` only; `getContextUsage().tokens` is null
  post-compact). Omitted when unavailable.
- Glyph: `⏹️` is U+23F9 + VS16 per the confirmed spec; current code uses `⏹`
  without VS16 — standardize on the VS16 form.

**Maintenance:** this file is the source of truth for every message, stamp and
notification rule. If behavior changes during implementation, update this
file in the same change (and note it under "Change log" at the bottom).

---

## 4. Master tables (finalized — all strings exact)

🔔 = notifies · ❌ = silent

### D — Run finalizations (mirror)

| # | Trigger | Message | Notify |
|---|---|---|---|
| D1 | clean end | m1: log + `Completed ✔️` | ❌ |
| D2 | clean end | m2: the answer, verbatim | 🔔 |
| D3 | provider error (retry window expired) | log + bottom line `⚠️ error: <msg>` (+ `⚠ incomplete` if partial answer) | 🔔 |
| D4 | aborted (`/stop`, `/compact`-mid-run, `/new`-mid-run) | log + bottom line `⚠️ Request was aborted` (bottom line **only**) | ❌ |

### A — Acks (synchronous)

| # | Trigger | Lifecycle | Notify |
|---|---|---|---|
| A1 | `/stop` (busy) | `⏹️ Stopping…` → edit-stamp `⏹️ Stopping… ✔️` after the turn settles | 🔔 |
| A2 | `/stop` (idle) | `Nothing to stop — session is idle.` | 🔔 |
| A3 | `/stop` (mid-compact) | draft `⏹️ Stopping…` → draft-stamp `⏹️ Stopping… ✔️` → final `⚠️ Compaction cancelled` | 🔔 (final) |
| A4 | `/reload` (idle) | `🔄 Reloading extensions…` → edit-stamp `🔄 Reloading extensions… ✔️` | 🔔 |
| A5 | `/reload` fail | `⚠️ Reload failed: <msg> (bot keeps running — check the TUI)` | 🔔 |
| A6 | `/reload` (busy) | `Agent is busy — send /stop first.` | 🔔 |
| A7 | `/new` | `🔄 Creating new session…` → edit-stamp `🔄 Creating new session… ✔️` (on session replacement) → session card | 🔔 (ack + card) |
| A8 | `/new` mid-run | **D4 (silent)** first, then A7 | 🔔 (A7) |
| A9a | session switch (idle) | `🔄 Switching session…` → session card | 🔔 ×2 (confirmed) |
| A9b | session switch (busy) | `Agent is busy — send /stop first.` — switching is **rejected**, no waiting, no confirm callback | 🔔 |
| A10 | switch while active | `Already active.` | 🔔 |
| A11 | `/sessions` | `Sessions for this project (newest first) — tap to switch:` / `No sessions for this project yet.` | 🔔 |
| A12 | expired lists | `⚠️ List expired — send /sessions again.` / `⚠️ List expired — send /models again.` | 🔔 |
| A13 | model set | `✓ Model set to <name>.` / `⚠️ Unknown model: <id>` | 🔔 |
| A14 | thinking set / `/name` | ack / `📌 Renamed to <name>.` / `Usage: /name <text>` | 🔔 |
| A15 | prompt while busy (steer) | `⚡ queued (applies after current tool step)` | 🔔 |
| A16 | `/mute` / `/unmute` | `🔇 Muted — I won't post agent output for this chat until you send /unmute. Commands still work.` / `🔊 Unmuted — agent output is back on.` | 🔔 |
| A17 | `/shutdown` | `⚠️ This terminates the pi process — the bot goes silent until pi restarts. Sure?` → `OK — pi keeps running.` / `👋 Shutting down pi… (bot goes silent)` | 🔔 |
| A18 | `/help` / `/status` / unknown | help text / status text / `Unknown command /<x> — see /help` | 🔔 |

### B — Lane 1 (long-running)

| # | Trigger | Lifecycle | Notify |
|---|---|---|---|
| B1 | `/compact` (idle) | draft `🗜 Compacting context…` → draft-stamp `🗜 Context compacted ✔️ — <detail>` → persist | 🔔 (final) |
| B2 | `/compact` (busy) | **D4 (silent)** → B1 | 🔔 (B1 final) |
| B3 | `/compact` (already running) | `🗜 Compaction already in progress — use the Stop button to abort` | 🔔 |
| B4 | compact cancelled (Stop) | `⚠️ Compaction cancelled` | 🔔 |
| B5 | compact failed | `⚠️ Compaction Failed: <msg>` | 🔔 |
| B6 | text prompt while manual compact in flight | `🗜 Compaction already in progress — resend your prompt after it finishes` | 🔔 |

### C — Lane 2 (auto-commands)

| # | Trigger | Lifecycle | Notify |
|---|---|---|---|
| C1 | auto-compact, live draft (pre-run) | spinner → `🗜 Auto-compacting…` → spinner back + log line `🗜 Context auto-compacted ✔️ — <detail>`; draft keeps going | silence until `m2` 🔔 |
| C2 | auto-compact, no live draft (between runs) | → B with auto strings: draft `🗜 Auto-compacting…` → `🗜 Context auto-compacted ✔️ — <detail>` → persist | 🔔 |
| C3 | auto-compact fails (any window) | standalone `⚠️ <pi errorMessage>` (already formatted by pi, e.g. `⚠️ Auto-compaction failed: …`); live draft continues | 🔔 |

- A prompt sent during **in-run** auto-compact is deliberately **NOT
  rejected** (2026-09-05, verified in the 0.84.4 dist): pi's compaction
  guard in `prompt()` is manual-only (`_compactionAbortController !==
  undefined`), and an in-run compact keeps `_isAgentRunActive` true →
  `isIdle() === false` → A15's "⚡ queued" ack goes out and pi steer-queues
  the prompt; `_handlePostAgentRun` delivers it after the compact
  (`agent.continue()`). A B6-style gate on the auto path would break a flow
  that works. The one remaining loss window is a **TUI-initiated** `/compact`
  (pi throws there too, and the rejection is invisible to extensions — the
  ExtensionAPI `sendUserMessage` discards the promise and the runner routes
  it to TUI-only error listeners); out of scope for Phase 1.

`<detail>` = `<before> → <after> tokens` (e.g. `128,432 → 21,904 tokens`)
for MANUAL compaction; for AUTO it is `<before> tokens` (e.g. `128,432
tokens`) — pi exposes only `tokensBefore` to extensions (see Change log,
2026-09-05). Omitted when pi doesn't report it.

### E — System

Pairing welcome, `/start` (card + help), session cards, not-authorized,
model/thinking list cards — plain sends, 🔔 per message (documented exception).

---

## 5. Behavior deltas vs current code

Per-command changes. "Today" = working tree at 2026-09-04.

### 5.1 Mirror finalizations (`src/mirror.ts`)

- **D4 aborted end (new shape).** Today: stop-finalized message = log +
  `⚠️ error: Request was aborted` *block inside the log area* (+ tail), and it
  **notifies**. Target: the aborted assistant message contributes **no**
  log-area ⚠️ line; the bottom-line slot carries `⚠️ Request was aborted`
  (same slot as `Completed ✔️`); the final single message is sent with
  `disable_notification: true`.
- **D3 error end (bottom-line-only).** Today: the provider-error ⚠️ line is
  written into the log area (and nothing in the bottom-line slot — the draft
  just ends with the log). Target: the ⚠️ line moves to the bottom-line slot;
  log area stays clean. Notify unchanged (🔔).
  Implementation note: `assistantMessageLogLines` (or its equivalent in
  `renderLog`) stops emitting the error line for the last assistant message;
  `renderDraft`/`renderLog` put the outcome in the bottom line for both
  `endKind === "error"` and `endKind === "stop"`.
- **D1 clean end:** unchanged (already silent m1 + notifying m2).

### 5.2 `/stop` (`src/session-bridge.ts`)

- **A1:** string standardization `⏹` → `⏹️` (VS16) in both the post and the
  edit-stamp. Flow unchanged (post → `stampAfterIdle`).
- **A3 (mid-compact):** insert a draft-stamp step: when Stop is pressed during
  compaction, the compact draft gets `⏹️ Stopping…`, then — when the abort
  settles (`onDone(false, "cancelled")`) — the draft is stamped
  `⏹️ Stopping… ✔️` **before** the final `⚠️ Compaction cancelled` is sent
  (which also clears the draft). Today the draft just shows `⏹ Stopping…`
  until the final lands.
- `/stop` while busy additionally triggers D4 (the run's silent aborted
  final) — ordering: D4 lands before/with the `⏹️ Stopping…` post (same as
  today's ordering guarantee: the aborted run's persistent message lands
  before the command's own follow-ups).

### 5.3 `/compact` (`src/session-bridge.ts`, `index.ts`)

- **B1:** lifecycle change — today: the compact draft stays
  `<tg-thinking>🗜 Compacting context…</tg-thinking>` until `finishCompact`
  sends a **new** persistent message and clears the draft. Target: the draft
  is **updated to the stamped text** `🗜 Context compacted ✔️ — <detail>`
  first, then finalized (persistent send of that text, draft cleared). The
  persistent message therefore shows the stamped state (today it shows it
  too, but the draft preview never showed the stamp — now it does, briefly).
- **B2:** unchanged flow (abort first → D4 silent → B1).
- **B3:** string changed to `🗜 Compaction already in progress — use the Stop button to abort` (today: `… use the Stop button on its draft.`).
- **B5:** string changed to `⚠️ Compaction Failed: <msg>` (today: `⚠️ Compact failed: <msg>`).
- **B4:** unchanged (`⚠️ Compaction cancelled`).

### 5.4 `/new` (`src/session-bridge.ts`)

- **A7:** the ack gets an edit-stamp: `🔄 Creating new session…` →
  `🔄 Creating new session… ✔️` when the session replacement completes
  (session_start / onSessionReplaced), then the session card posts. Today the
  ack is never stamped.
- **A8:** if a run is active, `/new` first triggers the D4 silent aborted
  final for the dying run, then the A7 sequence. (Verify in Phase 1 that
  `pi.newSession()` actually ends an in-flight run; if it does not, `/new`
  mid-run behaves like A9b — busy-reject — and A8 is removed.)

### 5.5 Session switch (`src/session-bridge.ts`)

- **A9a (idle):** unchanged (2 notifications confirmed as desired).
- **A9b (busy):** the confirm-callback flow is **removed**. Tapping a session
  while the agent is running now replies `Agent is busy — send /stop first.`
  (same string as A6). Removed code: the `Agent is running — switch when the
  current turn ends?` confirm message with `[⏳ OK] [Cancel]` buttons, the
  `sessionOk` callback data + `handleSwitchOk` handler, and the
  `⏳ Waiting for the current turn end…` message. (Phase-1 check: confirm the
  `sessionOk` callback is only produced by that one message so removal is
  safe.)

### 5.6 Auto-compaction → lane 2 (new; `index.ts` + `src/mirror.ts` + `src/session-bridge.ts`)

- **Early draft (pre-run):** the run's draft now starts **when the user
  message is accepted** (prompt received / steer queued for the next run),
  not at `agent_start` — so the C1 status is visible while the pre-run
  auto-compaction runs. The draft starts empty (no log lines yet) with the
  normal bottom-line spinner; when `agent_start` fires, the existing
  onAgentStart logic takes over the *same* draft (no new draftId).
  Error handling during/after pre-run: pre-run compaction failure → C3
  (standalone `⚠️ <pi errorMessage>`, 🔔 — the draft continues untouched);
  any other pre-run failure → the draft finalizes via the normal error path
  (D3, 🔔).
- **C1 (live draft):** `session_before_compact` with `reason !== "manual"`
  (pi's default auto-compaction) is observed (not intercepted): mirror
  bottom line switches to `🗜 Auto-compacting…` (replacing the spinner); on
  `session_compact` (verified: `compactionEntry.tokensBefore` only) the
  spinner is restored **and** the line
  `🗜 Context auto-compacted ✔️ — <detail>` is appended to the log area.
  The stamped line stays in the log and therefore lands in the finalized m1
  (an early-draft run's `onAgentStart` must PRESERVE that log — no wipe,
  since no run has ended yet).
- **C2 (no live draft):** same observation path, but with no active draft the
  bridge runs the lane-1 flow with auto strings (draft `🗜 Auto-compacting…`
  → `🗜 Context auto-compacted ✔️ — <detail>` → persist, 🔔). Uses the
  compact draft id namespace (`COMPACT_DRAFT_ID_BASE`) but a SEPARATE
  `autoCompactState` (NOT `compactState` — the Stop flow checks that first
  and auto-compact has no bot-side controller: `/stop` in the window hits
  the plain idle branch A2). The draft id is claimed optimistically (it is
  client-chosen) so a `session_compact` racing the first send still stamps
  it.
- **C3 (implemented per Phase 1):** pi continues the prompt un-compacted →
  a **standalone notifying** `⚠️ <pi errorMessage>` (🔔, verbatim, plain
  text). Lane 2: the live draft continues untouched. Lane 1: the lane-1
  draft is stamped `⚠️ <msg>` and the same text is sent as a plain message.
  `aborted && !errorMessage` (teardown/cancel) → silent, no messaging.
- **Manual vs auto strings stay distinct:** manual = `Compacting context…` /
  `Context compacted ✔️`; auto = `Auto-compacting…` / `Context auto-compacted ✔️`.

### 5.7 No changes

- `/mute`/`/unmute`/`/help`/`/status`/unknown/model/thinking/name/shutdown/
  sessions/queued — strings and flows stay exactly as today (pattern A).
- Retry carryover (§5.4 of the two-message-mirror spec) — untouched by
  THIS spec; the settle trigger was revised on 2026-09-05 (the error end
  finalizes at `agent_settled`; the grace timer is the backstop) — see the
  Change log below and the two-message-mirror spec §5.4.
- System events (E) — untouched.

---

## 6. Implementation plan (TDD)

### 6.1 Phase 1 — verified against live pi (2026-09-04) ✅

All six questions resolved; full findings recorded under §1 ("pi event
facts"). Summary:

1. **Completion event:** `pi.on("session_compact")` — `compactionEntry`
   carries `tokensBefore` only (no `estimatedTokensAfter` is exposed to
   extensions) → auto detail is `<before> tokens`. (`compaction_start` /
   `compaction_end` are internal TUI events — not extension-visible; the
   original entry here was corrected on 2026-09-05, see Change log.)
2. **Observe vs intercept:** not returning `{cancel}`/`{compaction}` from
   `session_before_compact` observes; manual interception unchanged.
3. **Failure:** pi continues the prompt un-compacted → C3 = standalone
   notifying `⚠️ <errorMessage>`, live draft continues (see §4 C3).
4. **`newSession()` mid-run:** aborts the run first → **A8 exists**
   (D4 silent final during the `pi.newSession()` await, then stamp + card).
5. **`sessionOk`:** produced only by the removed confirm message → full
   deletion (router, handler, command-args INDEX, 3 test sites).
6. **Early-draft window:** `isIdle()` true during pre-run compaction →
   second prompt = steer + `⚡ queued`; `/stop` in window = A2.

Documented edge decisions:

- `/stop` during the pre-run auto-compact window: auto-compaction has no
  bot-side controller; if pi reports idle there, the answer is A2
  (`Nothing to stop — session is idle.`) and the compaction runs to
  completion. Acceptable; noted here.
- A second prompt accepted while the early draft is alive (before
  `agent_start`): same pending run — no second draft; the existing
  `onAgentStart` reset proceeds normally when the run starts.

### 6.2 Phase 2 — TDD tasks (each: failing test first, then code)

Order matters: T1 before T6 (lane 2 renders into the same bottom line).

- **T1 — D3/D4 bottom-line-only + D4 silent** (`src/mirror.ts`)
  New/updated tests (`tests/mirror-end.test.ts`, `tests/mirror-finalize.test.ts`):
  - stop end: bottom line `⚠️ Request was aborted`, **no** ⚠️ line in the log
    area, final send carries `disableNotification: true`;
  - error end: `⚠️ error: <msg>` in the bottom-line slot, not in the log area,
    final send notifies;
  - clean end unchanged (m1 silent / m2 notifies — existing tests still pass).
- **T2 — lane-1 draft-stamp** (`src/session-bridge.ts` `finishCompact`)
  Tests: success → last draft state is the stamped text (no `<tg-thinking>`,
  no Stop button) **and** the persistent message equals it (🔔); failure →
  draft finalized as `⚠️ Compaction Failed: <msg>`; B3/B5 string updates.
- **T3 — A3 draft-stamp on stop-mid-compact**
  Tests: draft states `⏹️ Stopping…` → `⏹️ Stopping… ✔️` → final
  `⚠️ Compaction cancelled`.
- **T4 — A7 `/new` edit-stamp**
  Tests: ack post → edit-stamp on session replacement → card.
- **T5 — A9b busy-reject + dead-code removal**
  Tests: tap while busy → `Agent is busy — send /stop first.`; `sessionOk`
  callback path gone. (A8 shape depends on 6.1-4.)
- **T6 — lane 2 + early draft** (`src/mirror.ts`, `index.ts`, bridge)
  Tests:
  - prompt accepted while idle → early draft exists **before** `agent_start`
    (empty log + spinner), heartbeat armed;
  - auto-compact observed during pre-run → bottom line
    `🗜 Auto-compacting…`; completion → spinner restored **and** log line
    `🗜 Context auto-compacted ✔️ — <detail>`; the line survives into the
    finalized m1; m1 silent, m2 notifies;
  - auto-compact with no active draft → lane-1 auto strings, 🔔;
  - auto-compact failure (any window) → standalone notifying `⚠️ <errorMessage>`;
    a live draft continues unaffected (run proceeds to a normal D-end);
  - `agent_start` continues the early draft (no stray draftId bump beyond the
    existing one; retry-carryover tests from `tests/mirror-retry.test.ts`
    still pass unchanged).
- **T7 — A1 glyph standardization** (`⏹` → `⏹️` everywhere, tests updated).

### 6.3 Phase 3 — verification

- `node --test "tests/*.test.ts"` — full suite green (290 + new).
- `npx tsc --noEmit` — clean.
- `docs/plans/2026-09-02-two-message-mirror-design.md` synced: D3/D4
  bottom-line rule, D4 silent final (notification-rule section), pointer to
  this doc.
- **Live checklist** (manual, Telegram; this session is the mirrored one):
  1. clean run → m1 silent, m2 pings;
  2. run + `/stop` → silent final with `⚠️ Request was aborted` bottom line,
     `⏹️ Stopping…` ping → edit-stamped `✔️`;
  3. `/compact` idle → draft `🗜 Compacting context…` → draft-stamped
     `🗜 Context compacted ✔️ — <detail>` → persistent ping;
  4. `/compact` busy → silent D4, then lane-1 compact;
  5. big prompt after a full-ish context (triggers pre-run auto-compact) →
     early draft shows `🗜 Auto-compacting…` → stamped line visible in the
     finalized m1;
  6. `/new` idle → ack ping → `✔️` stamp → card ping;
  7. `/sessions` → tap another session while a run is active →
     `Agent is busy — send /stop first.`;
  8. provider error (bad model / 502) → single notifying message, ⚠️ in the
     bottom-line slot.
- Append any implementation-time deviations to the **Change log** below.

## Change log

- 2026-09-04 — doc created (design complete, pre-implementation).
- 2026-09-04 — Phase 1 verified against pi dist: C3 changed from "draft
  finalizes with failure" to "standalone notifying message, draft continues"
  (pi continues the prompt un-compacted); `compaction_end` chosen as the
  auto-compact observation event (carries detail); A8 confirmed (newSession
  aborts first); second-prompt-during-early-window = steer + ⚡ queued;
- 2026-09-05 — T1–T7 implemented (309/309 tests). Corrections and
  deviations:
  - `compaction_start`/`compaction_end` are internal TUI events, NOT
    extension-visible — the auto lanes are wired to
    `session_before_compact` / `session_compact` / `session_compact_failed`
    (lane chosen at `session_before_compact`, `reason !== "manual"` = auto,
    version-safe across 0.84.4 `threshold|overflow` and 0.85.0 `auto`).
  - Auto `<detail>` is `<before> tokens` (`compactionEntry.tokensBefore`
    only — `estimatedTokensAfter` is not exposed to extensions and
    `getContextUsage().tokens` is null post-compact) — deviates from the
    §3/§4 `<before> → <after> tokens`; manual keeps the two-number detail.
  - C3 implemented as the standalone `⚠️ <errorMessage>` (lane 2: live draft
    continues; lane 1: draft stamped + plain send); `aborted &&
    !errorMessage` is silent.
  - Early draft: `onPromptAccepted` fires in the bridge's prompt case BEFORE
    `pi.isIdle()` (a broken ctx must not hold the draft); `onAgentStart`
    takes over the same draftId and preserves the early-draft log
    (auto-compact narration).
  - Lane 1 keeps a separate `autoCompactState` (not `compactState`), with an
    optimistic draft-id claim; `finishCompact`/`autoCompactFinish` are
    async stamp-then-send.
  - T7: last bare `⏹` (a router comment) → `⏹️`; historical plan docs are
    not retro-edited.
  `sessionOk` deletion scope confirmed.
- 2026-09-05 — settle-trigger revision (T8, after a real 502 in the field:
  the draft's spinner disappeared for the whole 2 s / 4 s / 8 s retry
  backoff, frozen on the bare ⚠️ line). The 0.84.4/0.85.0 dist check proved
  the earlier premise wrong — pi's auto-retry (including its backoff delay)
  runs INSIDE the prompt's continuation loop (`_handlePostAgentRun` →
  `_prepareRetry` → `agent.continue()`), and `agent_settled` fires in the
  `finally` of `_runAgentPrompt`, AFTER the whole loop: never between
  `agent_end` and the retry's `agent_start`. Changes:
  - The error end now finalizes **at `agent_settled`** (the stream cannot
    continue anymore — persisting there cannot double-post: a retry that
    came first already carried the log over). The grace timer
    (`errorSettleMs`, 5 s default) is the **backstop only** (fires if
    `agent_settled` is lost — a pi flush threw before the finally emitted
    it).
  - While the stream is open after an error end, the live draft renders
    [log] [tail] `⚠️ error: …` line, a full-width `---` divider (rich
    markdown horizontal line; safe here because the ⚠️ line sits between
    the tool blocks and the line — the old rejection was a bare `---`
    directly above the spinner, colliding with the `<details>` handle),
    then the `<tg-thinking>` spinner. The divider + spinner are live-draft
    only: the persistent message is unchanged (⚠️ line last, no divider).
  - `currentBottom`: the C1 status (`autoCompacting`) now also takes
    precedence over a live error end (the overflow-recovery compact runs
    while the error end is open; the draft shows the compact, not the error
    line).
  - The 8 s backoff race (a 3rd retry's backoff longer than the 5 s grace →
    the timer would have finalized mid-backoff, splitting the run across
    two messages) is gone: the stream's own `agent_settled` finalizes the
    combined log in one message.
  - Tests: 9 rewritten + 3 new (312/312); `mirror-retry` / `mirror-end` /
    `mirror-settle` / `mirror-autocompact` updated; the two-message-mirror
    spec §5.4 header, state table and `agent_end`/`agent_settled` rows
    updated to match.
- 2026-09-05 — B6: text prompt during manual compact (T9; field report:
  user ran `/compact`, then text-prompted mid-compact — the prompt
  vanished, a `tg-thinking`-only draft reappeared after the compact result
  and never went away, and the next run's answer streamed into that stale
  draft, above the user's newer prompt). Root cause, verified in the
  0.84.4 dist: a manual compaction sets `_compactionAbortController` but
  **not** `_isAgentRunActive`, so `isIdle()` stays true (no "⚡ queued" ack,
  the prompt goes out as "now") while `prompt()` throws "Cannot submit a
  prompt while compaction is in progress"; the ExtensionAPI
  `sendUserMessage` is a sync stub that discards the promise (the runner's
  `.catch` routes the rejection to TUI-only `errorListeners`), so the
  rejection is invisible to extensions. The T6 early draft was left
  orphaned (phase `work`, no run ever starting): its heartbeat
  (`draftHeartbeatMs`, 17 s default) re-sent the spinner-only draft past
  the ~30 s ephemeral expiry forever; the compact's persistent send killed
  it briefly, the heartbeat brought it back; the next run's `onAgentStart`
  reused the stale draft id (alive, positioned above the user's newer
  prompt). Fix: the bridge rejects a text prompt while its own
  `compactState` is active — before `onPromptAccepted`, so no early draft —
  with the B6 message. Deliberately NOT gated: in-run auto-compact (see the
  C-section note — the prompt is steer-queued and delivered after the
  compact). Tests: 3 new (`bridge-compact`).
