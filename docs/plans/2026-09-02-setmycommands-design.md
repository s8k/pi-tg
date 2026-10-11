# Design: Telegram bot command menu (`setMyCommands`)

Date: 2026-09-02 · Branch: `feat/pi-tg-v1` · Status: validated, implementing

## Context

pi-tg's bot currently has no Telegram command menu — the phone user sees no
hint at `/` and must know the commands. The Bot API's `setMyCommands` fills the
menu with `BotCommand { command, description }` pairs (global scope, the API
default; one call, idempotent).

## The menu (13 commands, order matters — it's the display order)

| # | command | description |
|---|---------|-------------|
| 1 | `status` | Session info |
| 2 | `new` | Start a new session |
| 3 | `sessions` | List & switch sessions |
| 4 | `name` | [session_name] Rename this session |
| 5 | `models` | Pick a model |
| 6 | `thinking` | Pick the thinking level |
| 7 | `stop` | Stop the current request |
| 8 | `mute` | Stop posting agent output (commands still work) |
| 9 | `unmute` | Resume posting agent output |
| 10 | `compact` | Compact the history |
| 11 | `reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| 12 | `kill` | Shut down pi |
| 13 | `help` | Show help info |

Source of the descriptions: user-specified verbatim, except `mute`/`unmute`,
which mirror the bridge's own confirm texts (`/mute` → "I won't post agent
output … commands still work", `/unmute` → "agent output is back on").
`[session_name]` is a plain-text argument hint (BotCommand descriptions have no
argument syntax).

Telegram constraints (validated by test): `command` = 1–32 chars of `a-z0-9_`
(lowercase, no `/`); `description` = 1–257 chars. All 13 entries satisfy them.

## Code

- **`src/bot-commands.ts`** (new): `export interface BotCommand { command: string; description: string }`
  + `export const BOT_COMMANDS: BotCommand[]` — the single source of truth for
  the menu.
- **`src/telegram-client.ts`**: `setMyCommands(): Promise<unknown>` →
  `this.call("setMyCommands", { commands: BOT_COMMANDS })`. Global scope
  default, no `language_code`.
- **`index.ts` `startPolling()`**, right after `getMe()` succeeds:
  `void client.setMyCommands().catch((err) => ui("pi-tg: setMyCommands failed: …", "warning"))`
  — best-effort: a failure logs a TUI warning and never blocks or kills polling.

## When it runs

The hook lives in `startPolling()`, so the menu is set on **every poller
start** — self-healing, one idempotent call each time:

| Event | Menu set? |
|-------|-----------|
| Fresh pi run, token already saved | ✅ `session_start` → `startPolling()` → after `getMe()` |
| `/tg:config <token>` (first time or new token) | ✅ same path via `runConfig()` |
| Session restart / `/reload` / pi restart | ✅ `session_start` again |
| Token saved but not paired (waiting for `/start`) | ✅ poller runs, `getMe` works |
| No token | ⛔ `startPolling()` returns before `getMe()` — nothing attempted |

## Error handling

- `setMyCommands` failure (network, 429 after retries, bad token) → `ui`
  warning in the TUI; the poller keeps running. The next poller start retries.
- The generic `call()` already handles 429 backoff (3 retries) — no extra
  logic needed; menu-setting is fire-and-forget with a `.catch`.
- No retry loop of our own: YAGNI — restarts and the next `/tg:config` cover
  recovery.

## Tests

- **`tests/bot-commands.test.ts`** (new):
  - the exact 13 entries — order, command names, descriptions (deepEqual);
  - invariants: every `command` matches `/^[a-z0-9_]{1,32}$/` and every
    `description` is 1–257 chars (guards against future edits breaking the API).
- **`tests/telegram-client.test.ts`** (existing fake-fetch harness):
  - `setMyCommands()` POSTs to `…/setMyCommands` with body
    `{ commands: BOT_COMMANDS }` (the full 13-entry list) and returns the
    API result.
- The `index.ts` wiring is glue (consistent with the rest of the file —
  verified manually against a live bot), no new unit-test seam.

## Rollout

TDD: red tests first (both files), then `bot-commands.ts` + the client
method, then the one-line wiring in `index.ts`. Gate: `tsc --noEmit` + full
`node --test`. Commit on `feat/pi-tg-v1`, push.
