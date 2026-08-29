# pi-telega — Design & Technical Spec

> A pi extension that bridges a locally running Pi Coding Agent (local LLM via Docker model runner) to Telegram, so the agent can be driven from a mobile Telegram client. Terminal TUI and phone are **co-clients of the same live pi session**.

## 1. Goals / Non-goals

**Goals (v1):**
- Full remote operation of pi from Telegram (mobile-first): prompts, commands, model selection, session management.
- Shared-session model: the TUI and the phone drive the *same* `AgentSession` — input from both, output mirrored to both.
- All pi capabilities remain available remotely: skills (`/skill:name`), prompt templates, extensions (cc-safety-net permission flow, etc.).
- pi's Markdown output converted to Telegram-safe formatting (HTML parse mode).
- Smooth one-time onboarding: token paste → QR scan → first `/start` pairing → chat.
- Telegram commands: `/new`, `/models`, `/sessions` (+ activate), `/thinking`, `/status`, `/stop`, `/compact`, `/name`, `/kill`, `/help`.

**Non-goals (v1, deliberate YAGNI cuts):**
- 24/7 bot when pi is not running — pointless: the LLM is local, so if the PC is off/asleep there is no brain to drive.
- Media input (photos/files/audio from Telegram → agent) — the local model is text-only.
- Parallel driving of multiple sessions at once (one active session per pi process; see §5).
- Cross-project session listing (v1 lists sessions of the current project only, same scope as pi's own `/resume`).
- Group chats, multi-user, webhooks, MTProto user clients.

## 2. Decisions log

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Telegram transport | **Bot API + long polling** | Outbound HTTPS only (no inbound ports, works behind NAT); official; trivial. MTProto rejected (ToS risk, fragility, no added value for a private bot chat) |
| 2 | Where the code lives | **pi extension running inside the live TUI process** (`ctx.mode === "tui"`) | Single process ⇒ single session ⇒ phone and terminal are true co-clients (inputs serialize in pi's own queue). Standalone RPC bridge and headless 24/7 service rejected: availability is bounded by the local LLM either way, and an extension avoids reinventing RPC plumbing |
| 3 | Chat model | **One private chat** + session cards/inline buttons; `/sessions` command; chat-clean option on switch | Zero setup (`/start` and go). Forum topics (true per-session tabs) considered and deferred to v1.1 |
| 4 | Session scope | Sessions of the **current project** (`SessionManager.list(ctx.cwd)`) | Mirrors pi's `/resume`; cross-project (`listAll()`) later |
| 5 | Concurrency | **One active session**; other shared sessions activate via `ctx.switchSession()` with an idle guard | Single-process constraint. Escape hatch if parallelism is ever needed: extension spawns `pi --mode rpc --session <path>` child per session (v1.1) |
| 6 | Onboarding | `/tg config <token>` → `getMe()` validation → QR of `t.me/<bot>` in TUI widget → **first `/start` = owner pairing** (saves `ownerId`) | Bots cannot message users first; the first Start is Telegram's natural pairing handshake. QR makes finding the bot a 3-second job, not a search |
| 7 | Markdown | **HTML parse mode**: md→HTML converter, chunk ≤ 4096 chars, code-fence-aware; plain-text fallback on `400` parse errors | HTML escaping is far less error-prone than MarkdownV2 entity escaping; Telegram rejects malformed entities, so the converter must be golden-tested |
| 8 | Prompt while agent busy | **Auto-steer** (`deliverAs: "steer"`), acknowledged with "⚡ queued" | Matches typing-in-terminal intuition. (No "undo steer" in v1 — the extension API has no queue-removal method; `hasPendingMessages()` is read-only) |
| 9 | Chat cleaning | On `/new` / session switch: bot asks `[Clear] / [Keep]`; Clear = delete all **bot-sent** message IDs (tracked, throttled) | Telegram rule: a bot can only delete its own messages in a private chat; owner-typed messages remain |

## 3. Architecture

```
 ┌────────────┐   Telegram cloud (Bot API)   ┌──────────────────────────────────┐
 │  Smartphone │◄──────── long polling ─────►│  pi TUI process (project dir)    │
 │ (mobile)   │   outbound HTTPS only        │  ├─ TUI                        │◄─ client #1 (you, at PC)
 └────────────┘                              │  └─ pi-telega extension        │◄─ client #2 (you, on phone)
                                             │      ├─ telegram-client         │
                                             │      ├─ router                  │
                                             │      ├─ session-bridge  ◄───────┼── the ONLY module touching pi/ctx
                                             │      ├─ mirror                  │
                                             │      ├─ onboarding              │
                                             │      └─ state                   │
                                             └──────────────────────────────────┘
```

**Repo layout** (`C:\tmp\pi-telega`):

```
pi-telega/
├── index.ts                 # extension entry: wires modules, registers /tg terminal command,
│                            #   subscribes to pi events, starts poller on session_start
├── package.json             # "type": "module"; one runtime dep: qrcode (terminal QR strings)
├── tsconfig.json
├── .gitignore               # node_modules, .pi (session state)
├── README.md                # setup: BotFather, /tg config, QR pairing, install into pi
├── src/
│   ├── config.ts            # load/save ~/.pi/agent/pi-telega.json; env PI_TELEGA_BOT_TOKEN overrides
│   ├── telegram-client.ts   # Bot API over global fetch (Node ≥ 18): getMe, setMyCommands,
│   │                        #   getUpdates (long poll, offset mgmt), sendMessage, editMessageText,
│   │                        #   deleteMessage, answerCallbackQuery; 429→retry_after, network
│   │                        #   errors→exponential backoff (1s..30s), 409 conflict detection
│   ├── markdown.ts          # pi Markdown → Telegram HTML: entity escaping, ```fence → <pre><code>,
│   │                        #   inline code, **bold**, *italic*, ~~strike~~, [t](url) → <a>;
│   │                        #   chunking ≤ 4096 at line boundaries OUTSIDE code fences with
│   │                        #   continuation markers; plain-text fallback renderer
│   ├── router.ts            # Telegram update → typed action: /commands, callback_data parsing
│   │                        #   (JSON action payloads on buttons), free text → prompt action
│   ├── session-bridge.ts    # pi-API glue (only module importing the extension runtime):
│   │                        #   pi.sendUserMessage (idle→plain, busy→deliverAs:"steer"),
│   │                        #   ctx.newSession, ctx.switchSession (+ waitForIdle guard),
│   │                        #   SessionManager.list(ctx.cwd), ctx.scopedModels/ctx.modelRegistry
│   │                        #   + pi.setModel, pi.get/setThinkingLevel, ctx.abort, ctx.compact,
│   │                        #   ctx.getContextUsage, ctx.isIdle, pi.set/getSessionName, ctx.shutdown
│   ├── mirror.ts            # pi events → Telegram: message_update text deltas → throttled edits
│   │                        #   of a single "working" message (default 1500 ms);
│   │                        #   tool_execution_start/update/end → one-line status
│   │                        #   ("⚙ bash: npm test … ✔ 42 lines") + truncated result
│   │                        #   (default 300 chars); agent_end → final answer (chunked) and
│   │                        #   working-message cleanup; session_start/shutdown → session card;
│   │                        #   extension_error / retries → ⚠ notices
│   ├── onboarding.ts        # token validation via getMe; QR string (qrcode, terminal blocks)
│   │                        #   shown via ctx.ui.setWidget + plain link fallback; first-/start
│   │                        #   pairing; allowlist gate ("Not authorized")
│   └── state.ts             # runtime state: active session id/path; sent bot-message-ID list
│                            #   (persisted in the config file, capped at 500) for chat cleaning
└── tests/                   # node:test + node:assert (no framework)
    ├── fake-pi.ts           # stub implementing exactly the pi/ctx surface used by the bridge
    ├── fake-fetch.ts        # scripted Bot API responses (incl. 429/409)
    ├── markdown.test.ts     # golden cases: fences, nesting, entity escaping, 4096 boundaries,
    │                        #   chunk continuity (code never split mid-line)
    ├── router.test.ts       # command table, callback routing, allowlist, free-text passthrough
    ├── telegram-client.test.ts
    ├── config.test.ts       # env override, save/load, caps
    ├── state.test.ts
    ├── session-bridge.test.ts
    └── mirror.test.ts       # scripted event sequences → expected send/edit/delete call sequence
```

**Dependency policy:** exactly one runtime dependency (`qrcode`). HTTP via Node ≥ 18 global `fetch`. Tests via built-in `node --test`. (pi resolves npm deps from a `package.json` + `node_modules` next to the extension — per extensions.md.)

## 4. Telegram UX

One private chat. Message inventory:

- **owner prompts** (typed, or `/name <text>` etc.)
- **"working" message** — created at `agent_start`, edited with throttled streaming text; removed/replaced when the answer finalizes
- **tool status lines** — one line per tool call: `⚙ <tool>: <arg summary> … ✔/✖ <truncated result>`
- **final assistant answer** — chunked if > 4096 chars, full Markdown→HTML
- **session card** — `📌 <name>` / cwd / model / thinking / message count / context % / first-prompt snippet / `[Activate]` (and `★ current` marker)
- **confirmation prompts** — inline buttons for: clear chat, activate session (+ busy guard), model pick, thinking-level pick

**Bot commands** (registered via `setMyCommands`):

| Command | Action |
|---|---|
| `/start` | First use: pairing + welcome + current session card. Later: re-shows session card + help |
| *(any text)* | Prompt to the active session. Idle → immediate. Busy → auto-**steer** + "⚡ queued (applies after current tool step)" acknowledgement |
| `/new` | `ctx.newSession()` → new session card → "Clear chat history? **[Clear]** / **[Keep]**" |
| `/sessions` | Lists current project's sessions (newest first, cap 20): `name — model, N msgs, <age>` as buttons → tap → activate flow (below) |
| `/models` | Buttons for available models (`ctx.scopedModels`, or full catalogue when unscoped), current marked `★` → tap → `pi.setModel()` → confirmation |
| `/thinking` | Buttons for the levels the current model supports → `pi.setThinkingLevel()` |
| `/status` | Session name, cwd, model, thinking, context usage %, message count, busy/idle |
| `/stop` | `ctx.abort()` |
| `/compact` | `ctx.compact()` (progress notice, then summary result) |
| `/name <text>` | `pi.setSessionName()` (visible in `/sessions` and cards) |
| `/kill` | Confirm button → `ctx.shutdown()` (terminates the pi process; bot goes silent) |
| `/help` | This table |

**Activate-session flow** (`/sessions` tap):
1. Target == current session → "already active".
2. Agent busy → "Agent is running — switch when the current turn ends? **[OK]** / **[Cancel]**" (OK = `waitForIdle()` then switch).
3. `ctx.switchSession(path)` → if cancelled by another extension (`session_before_switch`), report it.
4. Post the new session card, then "Clear chat history? **[Clear]** / **[Keep]**" (config `askClearOnSwitch`, default true).

**Chat cleaning:** deletes all tracked bot-sent message IDs (newest first, throttled ~20 req/s with a progress edit), then a "✓ cleared" note. Owner-typed messages remain (Telegram limitation, noted in README).

**Terminal commands** (`pi.registerCommand`):

| Command | Action |
|---|---|
| `/tg` | Unpaired → pair (QR + link, §5). Paired → push current session card to the chat (bookmark) |
| `/tg config <token>` | Store token (config file), validate via `getMe()`, start poller |
| `/tg pair` | Re-pair: clears `ownerId`, shows QR again |

## 5. Concurrency model (the honest part)

One pi process has exactly **one active session**:

- The **active session** is fully shared: phone input drives it, terminal input drives it, both see all output. Inputs serialize in pi's own queue (idle → immediate; busy → steer).
- **Other shared sessions** (shared earlier via `/tg` or listed via `/sessions`) are *lanes*, not parallel sessions: activating one switches the process (and, if you're at the PC, the terminal view) to it. The terminal's `/resume` still works for post-hoc switching.
- If "drive session B on phone while A runs in terminal" ever becomes a real need: v1.1 option = extension spawns `pi --mode rpc --session <path>` child per remote session and bridges it (per-topic dialogs → Telegram buttons). Explicitly out of v1 scope.

## 6. Onboarding flow (agreed)

```
1. @BotFather → /newbot → copy token
2. pi terminal:  /tg config 123456:ABC-...     (saved to ~/.pi/agent/pi-telega.json)
3. pi terminal:  /tg
   → getMe() validates token (fast, clear error if bad)
   → TUI widget above editor: QR (terminal Unicode blocks) + "or open t.me/<bot>"
   → "Waiting for you to press Start…"
4. Scan with phone (Telegram opens bot profile) → [START]
5. Bot: first from.id auto-approved → ownerId saved →
   "✅ Paired. Only your account (ID …) can use this bot now."
6. Bot immediately posts current session card + /help → chatting.
```

Afterwards: zero onboarding. Token persisted ⇒ poller auto-starts on every `session_start`. `/tg` (no args) becomes the session-card bookmark command.

## 7. Data flows (happy paths)

1. **Prompt:** phone text → poller update → router → bridge `sendUserMessage` → `agent_start` (create working msg) → `message_update` deltas (throttled `editMessageText`) → `tool_execution_*` (status lines) → `agent_end` (finalize: chunked final answer, remove working msg).
2. **Model switch:** `/models` → bridge lists (`scopedModels`) → buttons → callback `setModel:<idx>` → `pi.setModel` → confirmation with model name.
3. **Session switch:** `/sessions` → `SessionManager.list(cwd)` → buttons → activate flow (§4) → `switchSession` → card + clean prompt.
4. **New session:** `/new` → `ctx.newSession()` → card → clean prompt.
5. **Bookmark:** terminal `/tg` → card posted to chat (title = session name or first-prompt snippet).

## 8. Error handling

| Failure | Behavior |
|---|---|
| Bad/rotated token (`getMe` 401) | TUI notification with the API error; no poller started |
| `409 Conflict` (token used by another poller, e.g. duplicate pi instance) | TUI notification: "token is already in use elsewhere"; stop polling |
| `429 Too Many Requests` | Honor `retry_after`, then continue |
| Network errors while polling | Exponential backoff 1 s → 30 s; TUI status widget updated; no data loss (offset persisted per poll) |
| Telegram `400` bad entities (malformed Markdown) | Retry the message as plain text (fallback renderer); log original |
| `switchSession` cancelled by another extension | Report "switch cancelled by <extension>" in chat |
| pi killed by `/kill` or terminal closed | Poller stops with the process; on next `pi -c` the bot returns automatically; sent-ID tracker persists so `/new`-clean still works |
| LLM/Docker down mid-run | pi surfaces the error as message events → mirrored as `⚠` with the error text |
| Extension handler throws | All handlers wrapped; failure → `ctx.ui.notify` in TUI, never crashes the process |
| Unknown Telegram user | "Not authorized" (all commands incl. repeated `/start`) |

## 9. Security

- **Single-owner allowlist**: `ownerId` from first `/start`; every update from any other ID is rejected.
- **Token at rest**: env `PI_TELEGA_BOT_TOKEN` (preferred) or `~/.pi/agent/pi-telega.json` inside the user profile (private to the user account on Windows by default). Never logged, never sent anywhere except `api.telegram.org`.
- **Outbound-only network**: long polling means no inbound ports; nothing is exposed on the LAN.
- **cc-safety-net stays in charge**: its confirmations are answered in the terminal (native TUI dialog); the extension observes `tool_call` events and pushes a best-effort heads-up to the phone ("🛡 safety net is asking about: `rm -rf …`") — it does not bypass or duplicate the policy.

## 10. Configuration

`~/.pi/agent/pi-telega.json` (env `PI_TELEGA_BOT_TOKEN` overrides `botToken`):

```json
{
  "botToken": "123456:ABC-...",
  "ownerId": 12345678,
  "streamEditMs": 1500,
  "toolPreviewChars": 300,
  "askClearOnSwitch": true,
  "maxSessionList": 20,
  "sentMessageIds": [ 214, 215, 216 ]
}
```

## 11. Testing strategy (TDD)

- Every module in `src/` is a pure function of (inputs, fakes) — no module touches the real Bot API or pi except `session-bridge.ts`, which receives the pi/ctx surface as an interface.
- `tests/fake-pi.ts`: stub of exactly the used surface (`sendUserMessage`, `newSession`, `switchSession`, `modelRegistry`, `setModel`, `compact`, `abort`, …). `tests/fake-fetch.ts`: scripted Bot API responses including 429/409.
- Golden tests for `markdown.ts` (the riskiest module): fences, nested emphasis, entity escaping, 4096 boundaries, chunk continuity.
- Integration test: fake-pi + fake-fetch, scripted event sequence → assert the exact expected sequence of send/edit/delete calls.
- Manual smoke checklist (README): real bot, real pi, real phone — pairing, prompt, steer-while-busy, /models, /sessions, /new+clear, /kill.
- CI: `tsc --noEmit` + `node --test`.

## 12. Operations

- **Dev install**: `npm install` in repo; add `C:/tmp/pi-telega/index.ts` to `~/.pi/agent/settings.json` → `extensions`; `/reload`.
- **Later**: publish as a pi package (`npm:pi-telega`) so it installs with one line.
- **Restart semantics**: `pi -c` (or `/resume`) restores the session; the extension reconnects automatically.
- **Windows**: pure JS, no native deps; runs in Windows Terminal / any terminal that hosts pi.

## 13. v1.1 backlog (explicitly deferred)

- Media input: photos → `ImageContent` in user messages; documents → saved to an inbox folder with path reference (needs a multimodal local model for photos).
- Parallel sessions: `pi --mode rpc --session <path>` child per remote session.
- Cross-project session listing (`SessionManager.listAll()`).
- Forum-topic chat mode (true per-session tabs).
- Steer "undo" (blocked on a pi queue-removal API).
- Webhook mode, group-chat mode, voice transcription.
