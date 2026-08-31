# pi-telega

Drive your local **Pi Coding Agent** from your phone. pi-telega is a pi extension
that bridges a live TUI session to Telegram via Bot API long polling — phone and
terminal become co-clients of the same live session. No cloud relay; your code
never leaves your machine.

```
phone (Telegram) ⇄ Bot API long polling ⇄ pi-telega (in-process) ⇄ pi TUI session
```

## How it works

- The extension runs **inside** the live TUI process (`pi -e index.ts`).
- A long-poll loop reads Telegram updates; only the paired owner is served.
- Free text is delivered as agent prompts (auto-queued as *steer* when busy).
- Session controls (`/new`, `/sessions`, `/stop`, …) execute through pi’s own
  command context, so they behave exactly like typing them in the terminal.
- While the agent works you get: a **working message** with a ⏹ Stop button,
  live tool lines (`⚙ bash: … ✔`), throttled streaming reply edits (1.5 s), and
  the final answer chunked to ≤ 4096 chars per message (Telegram HTML).

## Requirements

- Node ≥ 22.18 (native TS type-stripping for `node --test`; dev on Node 26)
- pi ≥ 0.84 (TUI running)
- A Telegram bot token (free: @BotFather → `/newbot`)

## Setup

1. `npm install` in this repo
2. Start pi with the extension: `pi -e /abs/path/to/pi-telega/index.ts`
3. In the TUI: `/tg config <bot-token>`
4. `/tg pair` → a QR widget appears
5. Phone: scan the QR → open the bot → `/start` → ✅ paired.
   From now on only your Telegram user ID is served.

## Phone commands

| Command | Action |
|---|---|
| free text | send a prompt (busy → queued as steer + “⏡ queued”) |
| `/start` | session card (name, cwd, model, thinking, messages, context %, session file) |
| `/new` | new session (confirm; the old one stays in the list) |
| `/sessions` | list recent sessions (≤ 20) with buttons |
| tap a session | switch (confirm if `askClearOnSwitch`) |
| `/models` | model list (current marked) with buttons |
| `/thinking` | available thinking levels with buttons |
| `/status` | model, thinking, context usage, message count, busy state |
| `/stop` | abort the current turn |
| `/compact` | compact context (result reported when done) |
| `/name <text>` | rename the session |
| `/kill` | confirm → graceful TUI shutdown |
| `/help` | command list |

## Terminal commands

| Command | Action |
|---|---|
| `/tg` | session card (TUI widget or notification) |
| `/tg config <token>` | save bot token, restart poller |
| `/tg pair` | show QR (only while unpaired) |

## Configuration

File: `~/.pi/agent/pi-telega.json` (atomic writes; created on first `/tg config`).
Env `PI_TELEGA_BOT_TOKEN` overrides the stored token.

| Field | Default | Meaning |
|---|---|---|
| `botToken` | — | Bot API token |
| `ownerId` | — | Telegram user ID allowed to drive the bot |
| `streamEditMs` | `1500` | throttle for streaming reply edits |
| `toolPreviewChars` | `300` | tool argument preview length cap |
| `askClearOnSwitch` | `true` | ask “clear?” when switching sessions |
| `maxSessionList` | `20` | `/sessions` list cap |
| `sentMessageIds` | `[]` | recent sent message ids (dedupe; capped at 500) |
| `lastOffset` | `0` | long-poll offset (survives restarts) |

## Security model

- **Owner-only:** every update from any other user gets a “not authorized” reply and is dropped.
- **Local only:** the bot talks to *your* machine via long polling — no server, no webhook.
- The token lives only in your local config file.
- `/kill` requires an explicit confirm tap.
- The bot can only trigger the fixed command set above — no arbitrary input.

## Development

```bash
npx tsc --noEmit            # type gate (strict, erasable-TS)
node --test                 # all tests (node:test, .ts run natively)
node --test tests/router.test.ts   # single file
```

**Module boundary:** only the root `index.ts` may import
`@earendil-works/pi-coding-agent`. Every `src/` module is pi-free and takes
injected interfaces (`TelegaPi`, `Out`, `FetchLike`); `tests/boundary.test.ts`
enforces the rule mechanically.

| Module | Responsibility |
|---|---|
| `src/config.ts` | config load/save, env token override, sanitize (id cap, sent-ids cap) |
| `src/telegram-client.ts` | Bot API calls, 429 retry, poller loop + offset management |
| `src/markdown.ts` | markdown → Telegram HTML, chunking ≤ 4096, plain-text fallback |
| `src/thinking.ts` | `supportedThinkingLevels(model)` — mirror of pi’s selection logic (pure) |
| `src/router.ts` | update → typed action (pure) |
| `src/command-args.ts` | `/tg internal …` encode/parse (pure) |
| `src/session-bridge.ts` | all phone-command logic behind the `TelegaPi` interface |
| `src/mirror.ts` | pi events → Telegram (working msg, tool lines, finalize, cards) |
| `src/onboarding.ts` | QR rendering, token validation, pairing texts (pure) |
| `src/state.ts` | per-instance state: offset, sent ids, working/tool message ids |
| `src/wiring.ts` | `makeOut` / `makeTelegaPi` adapters (structural pi mirrors) |

## Known limitations (v1)

- One owner; private chats only (no groups).
- Text in, text out (no image/file input).
- No answer-callbacks — Telegram’s spinner dismisses itself.
- Session card omits the first-prompt snippet (it appears in `/sessions` lists).
- Polling stops when the TUI closes (by design).
