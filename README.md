# pi-tg — Pi Harness ⇄ Telegram: drive it from your phone

Drive your local **Pi Coding Agent** from your phone. `pi-tg` is a Pi harness extension that bridges the live TUI session to Telegram
via Bot API long polling — phone and terminal become co-clients of the same
live session. No cloud relay; your code never leaves your machine.

```
Telegram (phone) ⇄ Bot API long polling ⇄ pi-tg (extension) ⇄ Pi harness
```

## Requirements

- Node ≥ 22.18 (native TS type-stripping for `node --test`; dev on Node 26)
- pi ≥ 0.84 (TUI running)
- A Telegram bot token (free: @BotFather → `/newbot`)

## Setup

1. `npm install` in this repo
2. Start pi with the extension: `pi -e /abs/path/to/pi-tg/index.ts`
3. In the TUI: `/tg:config <bot_token>`
4. `/tg:pair` → a QR widget appears
5. Phone: scan the QR → open the bot → `/start` → ✅ paired.
   From now on only your Telegram user ID is served.

## How it works

- The extension runs **inside** the live TUI process (`pi -e index.ts`).
- A long-poll loop reads Telegram updates; only the paired owner is served.
- Free text is delivered as agent prompts (busy → queued as *steer*, “⚡️ Message
  queued” confirmation).
- Session controls (`/new`, `/sessions`, `/stop`, …) execute through pi’s own
  command context, so they behave exactly like typing them in the terminal.
- While the agent works you get one **live rich draft** (native Telegram
  rendering): the streaming answer with native tables / code blocks / collapsed
  `<details>` for long code, tool status lines in its footer (`⚙ bash: … ✔`),
  and a native **Stop** button. The draft is refreshed every 1.5 s and
  heartbeated every 17 s (it is ephemeral — Telegram auto-hides it ~30 s after
  the last refresh). The final answer is a rich message (Bot API 10.2+ `blocks`
  tier — structured `InputRichBlock` arrays, no markdown round-trip); answers
  over the rich limit (32 000 chars) are chunked at block boundaries with a
  `(continued)` marker. If Telegram rejects a rich send, the answer is
  re-sent as plain text.

## Pi harness commands

| Command | Action |
|---|---|
| `/tg` | session card (TUI widget or notification) |
| `/tg:config <bot_token>` | save bot token, restart poller |
| `/tg:pair` | show QR (only while unpaired) |
| `/tg:unpair` | unpair the phone (bot silent until a new `/start`) |

All four appear in the TUI’s `/` completion list (type `/tg` and Tab).
The poller also injects `/tg internal …` (machine-only, not listed).

## Telegram bot commands

| Command | Action |
|---|---|
| free text | send a prompt (busy → queued as steer + “⚡️ Message queued”) |
| `/start` | session card (name, cwd, model, thinking, messages, context %, session file) |
| `/new` | new session (confirm; the old one stays in the list) |
| `/sessions` | list recent sessions (≤ 20) with buttons |
| tap a session | switch (confirm if `askClearOnSwitch`) |
| `/models` | model list (current marked) with buttons |
| `/thinking` | available thinking levels with buttons |
| `/status` | session, dir, model, thinking, context usage, message count, busy state, GPU temp/util/memory (NVIDIA, if available) |
| `/stop` | stop the current turn |
| `/level_mute` | output level: mute — no agent output (commands still work) |
| `/level_minimal` | output level: minimal — visible text only (no tools, no thinking) |
| `/level_full` | output level: full — tool log + final answer (default) |
| `/compact` | compact context (result reported when done) |
| `/reload` | hot-reload extensions, skills, prompts, themes, context files (idle only; ✔️ stamp + card = success) |
| `/name <text>` | rename the session |
| `/kill` | confirm → graceful TUI shutdown |
| `/help` | command list |

The Telegram `/` command menu shows these commands — set via `setMyCommands`
on every poller start (self-healing; single source of truth in
`src/bot-commands.ts`).

## Inline command picker

The `/help` card carries a **⌨️ Other Pi commands** button: pressing
it opens Telegram's inline search (prefilled with `@bot /`) over the
session's command table — pi built-ins, extension commands, prompt
templates and skills (tagged `[ext]` / `[tpl]` / `[skill]`). Tapping a
result auto-sends the command itself (e.g. `/mcp`) and executes it (1 tap):
built-ins reuse
the TG command paths, resource commands run through pi's command dispatch.
Terminal-only built-ins (`/tree`, `/login`, … — no extension-API
equivalent) are NOT listed; typing them still gets a 🖥 explanation. You
can also just type `@bot /<name> [args]` — the only way to pass arguments.

**One-time setup:** @BotFather → `/mybots` → *Bot Settings* → *API
Services* → enable **Inline mode** and **Inline feedback**. Inline mode
makes the ⌨️ button and the command list work at all; Inline feedback
delivers the `chosen_inline_result` update that executes the tapped
command. Without Inline feedback a tap only auto-sends the command text —
nothing runs. If Inline mode is off, pi-tg warns about it in the TUI on
startup/reload (`getMe().supports_inline_queries`).

## Configuration

File: `~/.pi/agent/pi-telegram.json` (atomic writes; created on first `/tg:config`).
Env `PI_TELEGRAM_BOT_TOKEN` overrides the stored token.

| Field | Default | Meaning |
|---|---|---|
| `botToken` | — | Bot API token |
| `ownerId` | — | Telegram user ID allowed to drive the bot |
| `ownerChatId` | — | owner’s chat id, persisted on first message so the bot can post right after `/reload` (restored on `/reload` only, not on process start — after a restart the bot stays silent until the owner writes) |
| `streamEditMs` | `1500` | throttle for rich-draft updates |
| `askClearOnSwitch` | `true` | ask “clear?” when switching sessions |
| `level` | `"full"` | agent output level: `mute` / `minimal` / `full` (set from the phone; legacy `muted` still migrates: true → `mute`, false → `full`) |
| `maxSessionList` | `20` | `/sessions` list cap |
| `draftHeartbeatMs` | `17000` | rich-draft re-send cadence in ms (keeps the ephemeral draft alive; out-of-range 5000..25000 → default) |
| `errorSettleMs` | `5000` | grace before an error-ended run’s un-persisted work log is posted as its own “⚠️ error” message; must exceed pi’s retry backoff (2 s) so an auto-retry carries the log over instead of double-posting |
| `codeFoldLines` | `25` | code fences whose body has more than N lines collapse into a closed `<details>` (out-of-range 5..500 → default) |
| `sentMessageIds` | `[]` | recent sent message ids (dedupe; capped at 500) |
| `lastOffset` | `0` | long-poll offset (survives restarts) |
| `seenUpdateIds` | `[]` | recently handled update ids (replay guard: if the offset ever regresses — crash, 409 twin — Telegram redelivers those updates and they are skipped, not re-processed; capped at 200) |
| `mirrorDialogs` | `true` | mirror other extensions’ TUI dialogs to the chat (see below) |

## Dialog mirroring

When another extension asks you something in the terminal — `ctx.ui.select`,
`ctx.ui.confirm`, `ctx.ui.input` or `ctx.ui.editor` — the question is mirrored
to the chat at the same time:

- **select / confirm** → inline buttons (one per option, plus ✖ Cancel);
  more than 20 options → a numbered list, answer by replying with the number.
- **input / editor** → “reply to this message with your answer” (a plain
  message that misses the reply-to still lands on the oldest pending
  input/editor dialog — so you can just type your answer).
- **numbered selects** → a bare number reply works even if it misses the
  reply-to (free text is not a valid numbered answer and stays a prompt).
- **live draft pause:** if a dialog appears while the agent is streaming, the
  draft is finalized first as a persistent segment ending in
  `⏸️ Paused — answer the dialog below`; after you answer, the draft
  re-spawns below it in chronological order.

**First answer wins:**

- tap the phone → the terminal dialog dismisses itself and the message is
  stamped `✔️ <title>: answered: …`;
- press a key in the terminal → the message is stamped
  `💻 <title>: answered in the terminal`.

Caveats:

- `ctx.ui.custom` (arbitrary terminal UI) is **not** mirrorable — it stays
  terminal-only, with the usual “⚠️ terminal prompt” line in the work log.
- `editor` has no programmatic dismiss in pi: if the phone answers first, the
  terminal editor stays open until Esc (its late result is discarded).
- Dialogs follow the output level: `mute` suppresses them (commands still
  work), `minimal` and `full` mirror them live. The `mirrorDialogs` config
  field is the master switch — set `"mirrorDialogs": false` in the config
  file to turn mirroring off at any level.

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
injected interfaces (`TelegramPi`, `Out`, `FetchLike`); `tests/boundary.test.ts`
enforces the rule mechanically.

| Module | Responsibility |
|---|---|
| `src/config.ts` | config load/save, env token override, sanitize (id cap, sent-ids cap) |
| `src/telegram-client.ts` | Bot API calls, 429 retry, poller loop + offset management |
| `src/rich-blocks.ts` | the blocks tier: `TgBlock`/`TgRichText` types, cost model, `inlineToRichText`, `mdToBlocks`, `tailBlocks`/`chunkBlocks` @32k, `blocksToPlainText` (pure) |
| `src/markdown.ts` | survivors: `richUnits` block skeleton, `chunkText` plain-rung chunking, work-log helpers (`toolArgsJson` / `extractWhy`) |
| `src/thinking.ts` | `supportedThinkingLevels(model)` — mirror of pi’s selection logic (pure) |
| `src/bot-commands.ts` | Telegram bot menu (`setMyCommands`) — single source of truth for the bot command list (pure) |
| `src/ui-dialogs.ts` | in-flight mirrored dialogs: render, reply/number routing, first-answer-wins stamps (pure) |
| `src/compact.ts` | stoppable manual compaction for `/compact` — replays pi’s default summarization with its own abort controller |
| `src/gpu.ts` | NVIDIA GPU temp/util/memory probe for `/status` (never throws, bounded timeout) |
| `src/router.ts` | update → typed action (pure) |
| `src/command-args.ts` | `/tg internal …` encode/parse (pure) |
| `src/session-bridge.ts` | all phone-command logic behind the `TelegramPi` interface |
| `src/mirror.ts` | pi events → one blocks draft per turn (footer, 17 s heartbeat) + blocks→plain finalization |
| `src/onboarding.ts` | QR rendering, token validation, pairing texts (pure) |
| `src/state.ts` | per-instance state: offset, sent ids, list caches |
| `src/wiring.ts` | `makeOut` / `makeTelegramPi` adapters (structural pi mirrors) |

## Known limitations (v1)

- One owner; private chats only (no groups).
- Text in, text out (no image/file input).
- No answer-callbacks — Telegram’s spinner dismisses itself.
- Session card omits the first-prompt snippet (it appears in `/sessions` lists).
- Polling stops when the TUI closes (by design).
