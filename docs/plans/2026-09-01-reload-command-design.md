# Design: `/reload` Telegram command (hot-reload pi extensions)

Date: 2026-09-01 · Branch: `feat/tg-reload-command` (from `feat/pi-tg-v1`)

## Goal

Let the owner hot-reload pi's extensions/skills/prompts/themes/context files from
Telegram while pi is running: send `/reload`, get a confirmation that the new
extension runtime is alive.

## pi side (source of truth: pi 0.84.4 + live pi docs)

- `ctx.reload(): Promise<void>` on the extension **command** context runs the same
  flow as pi's built-in `/reload`.
- Reload sequence: `session_shutdown` (reason `"reload"`) → resources reloaded →
  `session_start` (reason `"reload"`) + `resources_discover`.
- Docs caveat: code after `await ctx.reload()` still runs from the **pre-reload**
  version; treat reload as terminal for that handler.
- Failure mode: if an extension fails to load, the pi-tg poller is dead until
  the extension is fixed and reloaded from the TUI. Accepted (user chose option C:
  no inline confirmation, refuse while busy).

## Flow (option C)

1. Owner sends `/reload` → router emits `{ kind: "reload", chatId }`.
2. Bridge:
   - **busy** (`!pi.isIdle()`) → reply "Agent is busy — send /stop first." Done.
   - **idle** → persist `cfg.pendingAction = { type: "reload", chatId }`,
     reply "🔄 Reloading extensions…", call `pi.reload(onDone)` fire-and-forget
     (same pattern as `newSession`/`switchSession` in `wiring.ts`).
3. pi replaces the runtime; the **new instance** (existing `session_start` wiring in
   `index.ts`, unchanged) sees the persisted `pendingAction`, restarts the poller,
   and posts the **session card** via `onSessionReplaced`. Card arrival = success.
   The old instance stamps its own "🔄 Reloading extensions…" message with ✔️
   (best-effort `editMessageText`; silently ignored if the message was deleted).

   (Same pattern later applied to `/stop`: "⏹ Stopping…" is stamped with ✔️ once
   `pi.waitForIdle()` confirms the aborted turn has ended.)
4. Details:
   - `onSessionReplaced` skips the "🧹 Clear chat history?" question when
     `pendingAction.type === "reload"` (session unchanged → nothing to clear).
   - `pi.reload(onDone)`: `onDone(true)` → silence (replacement took over);
     `onDone(false, detail)` → old instance is still alive and sends
     "⚠️ Reload failed: …". The old instance **never persists** after firing
     reload (stale cfg could clobber the replacement instance's config).

## Per-file changes

| File | Change |
|---|---|
| `src/router.ts` | `TgAction` union gains `{ kind: "reload"; chatId: number }`; command switch `case "reload"` |
| `src/command-args.ts` | `"reload"` added to the `PLAIN` set (chatId-only encoding) |
| `src/config.ts` | `PendingAction` gains `{ type: "reload"; chatId: number }`; `sanitizePending` accepts it |
| `src/session-bridge.ts` | `TelegramPi.reload(onDone: (ok: boolean, detail?: string) => void): void`; `handle()` `case "reload"`; `onSessionReplaced` clear-question guard for `type === "reload"`; `/help` line: `<b>/reload</b> — hot-reload extensions & resources (idle only)` |
| `src/wiring.ts` | `CtxLike` gains `reload?(): Promise<void>`; `makeTelegramPi.reload(onDone)` resolves `requireCtx()`, requires `c.reload`, `void c.reload().then(() => onDone(true), (e) => onDone(false, e instanceof Error ? e.message : String(e)))` |
| `index.ts` | none |

## Tests (TDD, node:test, matching existing suites)

- `tests/router.test.ts` — `/reload`, `/reload@botname` → `{ kind: "reload" }`.
- `tests/command-args.test.ts` — encode/parse round-trip for `reload`.
- `tests/config.test.ts` — `sanitizePending` keeps a `reload` action, drops garbage.
- Bridge suites:
  - idle: persists `pendingAction {type:"reload"}`, sends "Reloading…", calls `pi.reload`;
  - busy: "send /stop first", no persist, no `pi.reload` call;
  - `onSessionReplaced` with a `reload` pending → card posted, **no** clear question
    (control: `new`/`activate` still ask);
  - `onDone(false)` → ⚠️ message sent; `onDone(true)` → no message.
- `tests/wiring.test.ts` — `reload` forwards ok/error to callback; throws without a
  live command ctx; a command ctx without `reload` throws.

## Verification

- `npm test` (full suite) green; `tsc --noEmit` clean (repo script if present).
- Manual (optional, live bot): `/reload` while idle → "🔄…" + new card; `/reload`
  while busy → refusal; breaking an extension file → "⚠️ Reload failed" or TUI error.

## Addendum 2026-09-06: no card after /reload (decision B)

The replacement instance no longer posts the (status) card after `/reload`.
`onSessionReplaced` now skips the card AND the clear question for
`pendingAction.type === "reload"` — it only clears/persists the pending
action. The old instance's ✔️ stamp ("🔄 Reloading extensions… ✔️") is the
sole success signal; `⚠️ Reload failed: …` covers failures.

Rationale: reload is not session-related, so a session status card there is
noise. Accepted risk: if the NEW instance's `session_start` wiring fails
AFTER `ctx.reload()` resolved (e.g. `startPolling()`'s sync setup throws —
bad token, our own regression in the handler), the old instance has already
stamped ✔️ (false positive) and the bot goes silently deaf until the next
TUI interaction (restart / TUI `/reload`). The card was the only signal that
could only be produced by a live new poller; the TUI notice
(`pi-tg: <err>` on the session_start IIFE) is the only remaining trace.
Rejected alternative: a small "✅ Extensions reloaded" ack from the
replacement (kept the end-to-end proof without session noise).
