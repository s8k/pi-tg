<p align="center">
  <a href="https://github.com/earendil-works/pi">
    <img alt="Pi" src="docs/images/pi_logo.svg" width="120" align="middle">
  </a>
  &nbsp;
  <b>+</b>
  &nbsp;
  <a href="https://github.com/DrKLO/Telegram">
    <img alt="Telegram" src="docs/images/tg_logo.svg" width="128" align="middle">
  </a>
</p>

<h1 align="center">
  <b>Pi-Tg</b>
</h1>

<p align="center">
  <em>A fast, lightweight Telegram extension for Pi Coding Agent</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@s8k/pi-tg">
    <img src="https://img.shields.io/npm/v/@s8k/pi-tg" alt="npm version" />
  </a>
  <a href="https://github.com/s8k/pi-tg/releases/latest">
    <img src="https://img.shields.io/github/v/release/s8k/pi-tg" alt="release" />
  </a>
  <a href="https://github.com/s8k/pi-tg/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/@s8k/pi-tg" alt="license" />
  </a>
</p>

Drive your local **Pi Coding Agent** from your phone. `pi-tg` is a Pi harness extension that bridges the live TUI session to Telegram
via Bot API long polling — phone and terminal become co-clients of the same
live session. No cloud relay; your code never leaves your machine.

```
Pi Coding Agent ⇄ Pi-Tg (extension) ⇄ Telegram Bot API ⇄ Telegram (phone)
```

**What you get:**

- Your phone drives the live Pi session — free text is a prompt, the agent works in your terminal
- One **live draft** message streams the answer with native formatting, tool status, and a **Stop** button
- A small command set for sessions, models, thinking, and output level
- Terminal dialogs (selectors, confirms, inputs) mirrored to your chat as buttons

<p align="center">
  <a href="https://github.com/user-attachments/assets/c1478d38-dba6-4c19-a6d1-f7e1947d8186">
    <img src="https://raw.githubusercontent.com/s8k/pi-tg/refs/heads/main/docs/images/Pi_Coding_Agent-Telegram_Desktop-Telegram_Phone.webp" alt="Demo: Pi Coding Agent &amp; Telegram (Desktop) &amp; Telegram (Phone)" />
  </a>
</p>

## Requirements

- Node ≥ 24.21 (native TS type-stripping for `node --test`; dev on Node 26)
- Pi ≥ 0.84 (TUI running)
- A Telegram bot token (free: @BotFather → `/newbot`)

## Setup

### Create Telegram bot (one-time)

1. Telegram: open **@BotFather** → `/newbot`
2. Pick a name and a username ending in `bot`
3. Copy the **API token** (`123456789:AAH…`) — this is the `<bot_token>` below; treat it like a password
4. *(optional)* Unlock the Pi commands picker — one-time setup, see [Pi commands picker](#pi-commands-picker) below

### Install from npm

1. `pi install npm:@s8k/pi-tg`
2. Start Pi - the extension loads automatically
3. In the TUI: `/tg:config <bot_token>`
4. `/tg:pair` → a pairing selector appears: instructions, a clickable link, and the QR
5. Phone: open the link or scan the QR → open the bot → `/start` → ✅ paired.
   From now on only your Telegram User ID is served.
   The selector closes the moment you pair — or press `Esc` / choose **Cancel**
   to dismiss it early.

<p align="center">
  <a href="https://github.com/user-attachments/assets/52930e84-aee0-40e0-b69e-c5d8e9eb051e">
    <img src="https://raw.githubusercontent.com/s8k/pi-tg/refs/heads/main/docs/images/Pairing_Pi_Coding_Agent_To_Telegram.webp" alt="Pairing Pi Coding Agent with Telegram" />
  </a>
</p>

### Install from source (development)

1. `git clone https://github.com/s8k/pi-tg.git`
2. `npm install` in the repo
3. Start Pi with the extension: `pi -e /path/to/pi-tg/index.ts`
4. Continue with `/tg:config <bot_token>` and `/tg:pair` as above.

## How it works

- The extension runs **inside** the live Pi process — the TUI is the brain:
  keep the terminal open, close it and the bot goes silent.
- A long-poll loop reads Telegram updates; only the paired owner is served.
- Free text is delivered as agent prompts.
- Session controls (`/new`, `/sessions`, `/stop`, …) execute through Pi’s own
  command context, so they behave exactly like typing them in the terminal.
- While the agent works you get one **live rich draft** (native Telegram
  rendering): the streaming answer with native tables / code blocks / collapsed
  `<details>` for long code, tool status lines in its footer (`⚙ bash: … ✔`),
  and a native **Stop** button. The draft is refreshed every 1.5 s and
  heartbeated every 17 s (it is ephemeral — Telegram auto-hides it ~30 s after
  the last refresh).
- The final answer is a rich message; long answers are chunked at block
  boundaries with a `(continued)` marker, and if Telegram rejects a rich send
  the answer is re-sent as plain text.

## Pi Coding Agent commands

| Command | Action |
|---|---|
| `/tg:config <bot_token>` | save bot token, restart poller |
| `/tg:pair` | show the pairing selector (instructions + link + QR; `Esc`/Cancel to dismiss, auto-closes on pair) |
| `/tg:unpair` | unpair the phone (the bot ignores messages again until you send `/start`) |

All three appear in the TUI’s `/` completion list (type `/tg` and Tab).
`/tg` itself is reserved for pi-tg’s internal poller → TUI dispatch — typing
it by hand just says so.

## Telegram Bot commands

| Command | Action |
|---|---|
| free text | Send a prompt |
| `/start` | Pair the bot; shows a status summary + command list |
| `/status` | Session, dir, model, thinking, context usage, message count, session cost (paid models), busy state, GPU temp/util/memory (NVIDIA, if available) |
| `/stop` | Stop the current turn |
| `/new` | New session (confirm; the old one stays in the list) |
| `/sessions` | List recent sessions (≤ 20) with buttons; tap one to switch (confirm if `askClearOnSwitch`) |
| `/name <text>` | Rename the session |
| `/models` | Model list (current marked) with buttons |
| `/thinking` | Available thinking levels (off → high) with buttons |
| `/level_mute` | Output level: mute — no agent output (commands still work) |
| `/level_minimal` | Output level: minimal — visible text only (no tools, no thinking) |
| `/level_full` | Output level: full — tool log + final answer (default) |
| `/compact` | Compact context (stoppable via Stop; result reported when done) |
| `/reload` | Hot-reload extensions, skills, prompts, themes, context files (idle only; ✔️ stamp + card = success) |
| `/kill` | Confirm → graceful TUI shutdown |
| `/help` | Bot command list + ⌨️ button to browse, search, and run other Pi commands |

Row order matches the Telegram `/` command menu (self-healing on every
poller start); `/start` is handled but deliberately not listed. Menu
internals: [docs/development.md](docs/development.md#bot-command-menu).

## Pi commands picker

Run any command in this session from your phone, without typing it.

**How to use:**
1. Open the **/help** card and press the **⌨️ Other Pi commands** button
   (or type `@bot /` in the chat input yourself).
2. A searchable list of the session's commands opens — Pi built-ins,
   extension commands, prompt templates and skills (tagged `[ext]`,
   `[tpl]`, `[skill]`).
3. Type to filter, tap a command — it is sent to the chat and runs
   immediately.

**Passing arguments:** keep typing after the command name (e.g. `/mcp
login acme`) and tap the entry — the command runs with your arguments.

**Notes:**
- A few terminal-only commands (`/tree`, `/login`, …) are not in the
  list — they only work in the Pi terminal. Typing one there shows an
  explanation.
- **One-time setup:** enable **Inline mode** for your bot — @BotFather →
  `/mybots` → *Bot Settings* → *Inline mode* → Turn On. That's the
  only step; the ⌨️ button works right after.
- If you skip it, nothing breaks: the ⌨️ button simply won't appear on
  the /help card (a note in its place explains why), and `pi-tg` mentions
  it in the terminal when you pair or run `/tg:config`. All other `pi-tg`
  features work normally without it.

## Configuration

File: `~/.pi/agent/pi-tg.json` (atomic writes; created on first `/tg:config`).
Env `PI_TELEGRAM_BOT_TOKEN` overrides the stored token.

| Field | Default | Meaning |
|---|---|---|
| `botToken` | — | Bot API token (stored base64-encoded) |
| `ownerId` | — | Telegram user ID allowed to drive the bot |
| `streamEditMs` | `1500` | throttle for rich-draft updates |
| `askClearOnSwitch` | `true` | ask “clear?” when switching sessions |
| `level` | `"full"` | agent output level: `mute` / `minimal` / `full` (set from the phone) |
| `maxSessionList` | `20` | `/sessions` list cap |
| `draftHeartbeatMs` | `17000` | rich-draft re-send cadence in ms (5000..25000, else default) |
| `errorSettleMs` | `5000` | grace before an error-ended run’s work log is posted as its own “⚠️ error” message |
| `codeFoldLines` | `25` | code fences longer than N lines collapse into a closed `<details>` (5..500, else default) |
| `mirrorDialogs` | `true` | mirror other extensions’ TUI dialogs to the chat (see below) |

Internal state fields (`ownerChatId`, `sentMessageIds`, `lastOffset`,
`seenUpdateIds`) manage polling, dedupe, and replay safety — details in
[docs/development.md](docs/development.md#internal-config-fields). Note:
after a Pi restart the bot stays silent until you send any message.

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

Caveats: `ctx.ui.custom` (arbitrary terminal UI) is terminal-only. `editor`
has no programmatic dismiss in Pi — if the phone answers first, the terminal
editor stays open until Esc (its late result is discarded). Dialogs follow
the output level (`mute` suppresses them); `"mirrorDialogs": false` in the
config file turns mirroring off entirely.

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
```

Module layout, the pi-import boundary rule, the bot-menu internals, and the
internal config fields are documented in
[docs/development.md](docs/development.md).

## Troubleshooting

- **Bot not responding** — the TUI is the brain: if the terminal is closed,
  polling stopped. Reopen Pi and the bot resumes.
- **After restarting Pi the bot is silent** — expected; it starts replying
  when you send any message.
- **Wrong user paired / “not authorized”** — `/tg:unpair` in the TUI, then
  `/tg:pair` and `/start` again.
- **Telegram rate limits** — the bot backs off automatically on 429; no
  action needed.

## Known limitations (v1)

- One owner; private chats only (no groups).
- Text in, text out (no image/file input).
- No answer-callbacks — Telegram’s spinner dismisses itself.
- Session card omits the first-prompt snippet (it appears in `/sessions` lists).
- Polling stops when the TUI closes (by design).
