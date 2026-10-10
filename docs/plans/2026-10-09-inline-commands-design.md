# Design: inline command picker (browse + run any pi session command from Telegram)

Date: 2026-10-09 · Branch: `feat/tg-inline-commands` (from `main`)

## Goal

Let the owner browse the **live command list of the current pi session**
(built-ins + extension commands + prompt templates + skills) from Telegram and
run any executable one — via Bot API **inline queries**
(`switch_inline_query_current_chat` button → `inline_query` →
`answerInlineQuery` → `chosen_inline_result`).

## Decisions (approved in chat, 2026-10-09)

1. **All** session commands are listed. Built-ins are runnable wherever pi's
   extension API offers an equivalent — by mapping them onto the **same
   execution paths pi-tg already uses** (bridge actions / `ctx` operations),
   exactly like the existing `/new`, `/compact`, `/models`… commands. Built-ins
   with no extension-API equivalent are listed as "terminal only" (no Run
   button).
2. Trigger buttons on the **`/help` and `/status` cards**.
3. **Flow A (1-tap)**: execution is triggered by the `chosen_inline_result`
   update. A Run button on the auto-sent card stays as a crash-safe fallback
   (2-tap) — it also makes the feature work if the owner never enables
   BotFather "Inline feedback" (see Setup).
4. Bonus path: the prefilled input bar doubles as a direct command line —
   typing `@bot /<name> [args]` + send dispatches the command **with
   arguments** (taps have no args).

## Telegram Bot API facts (verified against the LIVE core.telegram.org/bots/api, 2026-10-09)

- `InlineKeyboardButton.switch_inline_query_current_chat`: pressing the button
  inserts `@botname <string>` into the current chat's input field and opens
  inline mode. String may be empty, **0–64 chars**. **Not supported in
  channels / channel-direct-message chats** (the client simply doesn't render
  the button → safe to attach unconditionally).
- `inline_query` update: `id`, `from`, `query` (≤256 chars; **includes** the
  `/` we prefilled), `offset`, `chat_type`, `location?`.
  ⚠️ The current API has **no `chat_id`** on `InlineQuery` — we cannot learn
  the originating chat from the query. (Flow-A limitation, see Risks.)
- `answerInlineQuery(inline_query_id, results, cache_time?, is_personal?,
  next_offset?)`: **≤ 50 results** per query. `cache_time` defaults to 300 s —
  we pass a small value (the set changes on `/reload`/`/new`). `is_personal:
  true` (owner-only results).
- `InlineQueryResultArticle`: `type:"article"`, `id` (**1–64 bytes**), `title`
  (1–64), `input_message_content` (**required** — tapping the result makes the
  BOT auto-send that message into the chat), `reply_markup?` (attached to the
  auto-sent message), `description?` (short; truncated to 70 chars — empirical
  cap, verify during implementation).
- ⚠️ **Bots never receive updates for their own sent messages** — the
  auto-sent card cannot itself be the execution trigger.
- `chosen_inline_result` update: `result_id`, `from`, `query`,
  `inline_message_id?` (present **iff** the result carried `reply_markup` —
  usable with `editMessageText(inline_message_id=…)` for stamping). **No chat
  id.** ⚠️ **Requires enabling "Inline feedback"** in @BotFather
  (Bot Settings → API Services → Inline mode → Inline feedback) — see Setup.
- `allowed_updates` must include `inline_query` and `chosen_inline_result`
  (the current `getUpdates` call passes an explicit list).

## pi side (verified against installed pi 1.1.0 types + dist source, 2026-10-09)

- `pi.getCommands(): SlashCommandInfo[]` (on `ExtensionAPI`) returns the live,
  session-accurate resource commands: **extension** commands (with their real
  `invocationName` — collision-renamed ones included), **prompt templates**,
  and **`skill:<name>`** entries. It follows runtime swaps (`/reload`, `/new`),
  so it is exactly the "commands of the current session" minus built-ins.
  Wrap in try/catch → `[]` (stale-ctx care, same as `ctxIsAlive`).
- Built-ins are **not** exposed via the extension API (`BUILTIN_SLASH_COMMANDS`
  is not exported from the package root). → curated static copy in
  `src/pi-commands.ts` (version-pinned to pi 1.1.0, with a pointer to pi's
  `slash-commands.md`), same "local structural mirror" pattern as `wiring.ts`.
- **Dispatch rules** (read `prompt()` in pi's `agent-session.js`):
  text starting with `/` executes **extension commands only**
  (`_tryExecuteExtensionCommand`); prompt templates and `skill:` commands are
  **expanded into the prompt**; built-ins run only in the TUI layer.
  Therefore, via the existing
  `pi.sendUserMessage("/name args", { expandPromptTemplates: true })` trick
  (the same path `/tg internal` uses), pi-tg can run: every extension command,
  every template, every skill. Built-ins must be mapped onto `ctx` operations
  / bridge actions (below). Only dispatch names from the live list (unknown
  names fall through to the LLM as a prompt).
- `ExtensionCommandContext` offers: `waitForIdle`, `newSession`,
  `switchSession(path)`, `reload`, `compact`, `abort`, `shutdown`, model /
  thinking setters, session naming — the building blocks for the mapping.

### Built-in → execution mapping (24 built-ins, pi 1.1.0)

| Built-in | pi-tg execution |
|---|---|
| `/new` | action `new` |
| `/compact [instructions]` | action `compact` (tap = no instructions; typed path: instructions passed as args → new action `compact` variant with text, see Per-file) |
| `/model [provider/model]` | action `modelList` (picker UI; typed args out of scope for v1) |
| `/thinking [level]` | action `thinkingList` |
| `/name [name]` | action `nameSet` (empty name → usage reply, like today) |
| `/session` | action `status` (session card) |
| `/resume` | action `sessions` (list & switch UI) |
| `/reload` | action `reload` |
| `/import <path>` | new action `importSet` → `pi.switchSession(path)` (bridge: same flow as `sessionActivate`) |
| `/quit` | action `killAsk` (the existing ☠ confirm flow; identical to `/kill`) |
| `/settings` | terminal only |
| `/tree` | terminal only (interactive navigation) |
| `/fork` | terminal only (interactive) |
| `/clone` | terminal only (no extension-API equivalent) |
| `/scoped-models` | terminal only |
| `/export [path]` | terminal only (no extension-API equivalent) |
| `/share` | terminal only |
| `/bug [description]` | terminal only |
| `/copy` | terminal only (clipboard of the terminal machine) |
| `/changelog` | terminal only |
| `/hotkeys` | terminal only |
| `/trust` | terminal only |
| `/login [provider]` | terminal only (interactive auth flow) |
| `/logout` | terminal only |

Resource commands (any `source`: extension / prompt / skill) → new action
`cmdDispatch { chatId, name, args }` → `pi.sendUserMessage("/name args",
{ expandPromptTemplates: true })`; errors (busy-queue rules, compaction in
progress, …) reported back in the chat, same tone as `prompt` failures.

## UX flow

1. **Open**: `/help` and `/status` cards carry a
   `⌨️ Pi commands` button (`switch_inline_query_current_chat: "/"`).
   (Channels: the client hides unsupported buttons — no special-casing.)
2. **Search**: input bar shows `@bot /`; as the owner types, Telegram sends
   `inline_query` (query like `/mod`). The handler:
   - unpaired / non-owner → `answerInlineQuery(id, [], is_personal: true)`
     (nothing leaks, no card can appear).
   - owner → merged list (built-ins ∪ `getCommands()`) filtered case-
     insensitively on name or description (leading `/` stripped from the
     query), capped at 50, answered as articles:
     - `title` = `/name` (truncated to 64)
     - `description` = `description` (+ `[ext]`/`[tpl]`/`[skill]` source tag
       for resources; `· 🖥 terminal only` for unmapped built-ins), ≤ 70 chars
     - `input_message_content` = `InputMessageText`
       `📋 /name — description` (the auto-sent card)
     - `reply_markup` = one row `[ ▶ Run ]` (`callback_data: "cr:<nonce>"`)
       for executable commands only; terminal-only results carry no markup
     - `id` = `c<nonce>` (7 chars ≤ 64 bytes)
   - Each announced result registers `nonce → { name, source }` in the
     bridge's **pending-runs** map (bounded, ~32 entries, oldest evicted —
     same shape as the dialog nonce map).
3. **Run (Flow A, 1 tap)**: tap → Telegram auto-sends the card AND delivers
   `chosen_inline_result` (with `result_id`, `inline_message_id`). Owner
   check → `nonce = result_id.slice(1)` → bridge `cmdRun`:
   - mapped built-in → dispatch the mapped action in `ownerChatId` (the last
     active owner chat — chosen_inline_result has no chat id, see Risks);
   - resource command → `cmdDispatch` with empty args;
   - terminal-only → reply "🖥 … is a terminal-only command — run it in the
     pi TUI."
   - **one-shot**: the nonce is consumed on first dispatch; a late/second
     trigger (fallback button, redelivered update) is ignored (silent
     `answerCallbackQuery` toast "already handled").
   - Success → best-effort stamp of the card via
     `editMessageText(inline_message_id)` → `✅ /name`; failure → `⚠️ …`.
4. **Run (fallback, 2 taps)**: `chosen_inline_result` lost (polling crash,
   or "Inline feedback" not enabled — in that case only the card appears) →
   the card's `▶ Run` button works via `callback_query` (chat id right there
   in `cb.message.chat.id`, owner-checked) → same `cmdRun` nonce path →
   stamped via the regular `editMessageText(chatId, messageId)`.
5. **Direct send (with args)**: the prefilled bar accepts
   `@bot /<name> [args]` + send. Router fallback (after the existing TG
   command switch, before `unknown`): name in the session-command table →
   mapped built-in → its action (args carried where meaningful: `/name x`,
   `/import path`, `/compact instructions`); resource name → `cmdDispatch`
   with args. Everything else keeps today's `unknown` behavior.

### Setup (one-time, owner)

Enable **Inline feedback** in @BotFather (mybots → Bot Settings → API
Services → Inline mode). Without it the feature still works via the 2-tap
fallback. Note goes into the README + a one-line hint in the `/help` card.

## Per-file changes

| File | Change |
|---|---|
| `src/pi-commands.ts` (new) | pi-free & pure: `BUILTIN_PI_COMMANDS` (24 entries: name, description, hint, `map?: <action kind>`); `SessionCommand` type; `mergeCommands(builtins, resources)` (dedupe by name — resource `invocationName` wins only when pi renamed it, built-in names are reserved by pi); `filterCommands(list, query)`; `toInlineResults(list, makeNonce)` → article payloads + nonce table; `dispatchFor(name, rest)` → `{ type: "action"; action } \| { type: "dispatch"; name; args } \| { type: "terminal" }`. All limits enforced here (50 results, 64-byte ids/titles, 70-char descriptions). |
| `src/telegram-client.ts` | `answerInlineQuery(inlineQueryId, results, opts?)` method; `TgUpdate` gains `inline_query?` (`{ id, from, query, offset }`) and `chosen_inline_result?` (`{ result_id, from, query, inline_message_id? }`); `allowed_updates += ["inline_query", "chosen_inline_result"]`; `editMessageText` gains optional `inlineMessageId` overload (or a thin `editInlineMessageText` method). |
| `src/router.ts` | `TgAction` gains `cmdRun { chatId; nonce }`, `cmdSend { chatId; name; args }`, `importSet { chatId; path }`, and `compact` gains optional `instructions?: string`; callback parser: `cr:<nonce>` (6-char) → `cmdRun`; `CMD_RE` extended to allow one `:segment` (skills, `tg:pair`); message fallback: injected `opts.sessionCommand?: (name, rest) => TgAction \| undefined` consulted after the TG switch, before `unknown`. |
| `src/command-args.ts` | Encode `cmdRun` (`internal cmdRun <chatId> <nonce>`), `cmdSend` (`internal cmdSend <chatId> <JSON {name,args}>`), `importSet` (`internal importSet <chatId> <JSON path>`), `compact` with instructions (`internal compact <chatId> <JSON instructions?>`); parse mirrors. |
| `src/session-bridge.ts` | `TelegramPi` interface gains `getCommands(): { name; description; source }[]` and `runCommand(name, args): void` (wraps `sendUserMessage`, errors surfaced by caller) and `switchSession` already exists (for `importSet`). New **pendingRuns** map (nonce → `{ name, source }`, cap 32) with `registerRun(nonce, entry): boolean`, `consumeRun(nonce): entry \| undefined`. `handle()` cases: `cmdRun` (lookup → mapped action / `runCommand` / terminal reply; stamp card), `cmdSend` (dispatch or mapped), `importSet` (switch-session flow like `sessionActivate`), `compact` with instructions. `helpBlocks()` gains a `⌨️ Pi commands — browse & run any session command (tap, then Run)` line; help & status sends attach `reply_markup` with the switch-inline button. |
| `src/wiring.ts` | `PiLike` + `CtxLike` unchanged; `TelegramPi` gains `getCommands()` (`deps.pi.getCommands()` try/catch → `[]`) and `runCommand(name, args)` (`deps.pi.sendUserMessage("/name args", { expandPromptTemplates: true })`). |
| `index.ts` | `handleUpdate`: new `update.inline_query` branch (owner check → build list via `piAdapter.getCommands()` + `BUILTIN_PI_COMMANDS` → `pi-commands.toInlineResults` → `bridge.registerRun` per result → `client.answerInlineQuery`); new `update.chosen_inline_result` branch (owner check → `route(...)` → `cmdRun` with `chatId = ownerChatId ?? ignore`). `opts.sessionCommand` wired into `route(...)` from the same merged table. Everything best-effort: an inline failure must never wedge the update loop. |
| `src/bot-commands.ts` | unchanged (bot menu already mirrors the TG commands). |

Notes:
- `cmdRun`/`cmdSend`/`importSet` travel the existing `/tg internal` path
  (`encodeInternal` → `pi.sendUserMessage("/tg internal …")` →
  `parseInternal` → `bridge.dispatch`) — the poller stays the single
  entry point into the bridge, and the TUI-side handlers keep working across
  poller restarts exactly like today's actions.
- `getCommands()` is read **at query time** (per `inline_query`), never
  cached in state — the list tracks `/reload`/`/new` for free.
- Output levels: the picker card + stamps are **command responses** →
  unaffected by mute (consistent with "mute = commands in, command responses
  out").


## Tests (TDD, node:test, matching existing suites)

- `tests/pi-commands.test.ts` (new) — merge/dedupe (resource with
  `invocationName` rename coexists with a built-in; exact-name resource
  shadowing rule); filter (case-insensitive, `/`-prefixed and bare queries,
  description match, empty query = full list); dispatch decisions (all 24
  built-ins mapped/terminal correctly, resources → dispatch); result
  payloads (≤50 cap, `id` ≤64 bytes, `title` ≤64, description ≤70,
  terminal-only results have no `reply_markup`, `input_message_content`
  shape).
- `tests/router.test.ts` — `cr:<nonce>` callback → `cmdRun` (owner only,
  malformed nonce → ignore); `/skill:foo bar` and `/tg:pair` match the
  extended `CMD_RE`; `sessionCommand` fallback: `/model` → `modelList`,
  `/resume` → `sessions`, `/quit` → `killAsk`, `/import x` → `importSet`,
  `/name x` → `nameSet`, unknown-with-args resource → `cmdSend`, genuinely
  unknown → `unknown`; existing TG commands still win over the fallback.
- `tests/telegram-client.test.ts` — `answerInlineQuery` request shape
  (inline_query_id, results, cache_time, is_personal); `allowed_updates`
  contains the two new kinds; `editInlineMessageText` shape.
- `tests/bridge-misc.test.ts` (or new `bridge-inline.test.ts`) — `cmdRun`:
  mapped built-in dispatches the action; resource → `runCommand` called with
  `/name`; terminal → explanatory reply; **nonce one-shot** (second `cmdRun`
  with same nonce → ignored, no second dispatch); `cmdSend` with args →
  `runCommand("/name args")` + busy/error reply; `importSet` → switch-session
  flow; help & status sends carry the switch-inline `reply_markup`;
  pendingRuns eviction at cap.
- `tests/command-args.test.ts` — encode/parse round-trips for `cmdRun`,
  `cmdSend`, `importSet`, `compact`+instructions.
- `tests/index-smoke.test.ts` — `inline_query` from owner → `answerInlineQuery`
  called with filtered results; from non-owner → empty answer;
  `chosen_inline_result` (owner) → `cmdRun` dispatched; (non-owner) → ignored.

## Risks & known limitations

- **Multi-chat owners**: `chosen_inline_result` (and current-API
  `inline_query`) carry no chat id → Flow-A runs execute in the **last
  active owner chat** (`ownerChatId`). The 2-tap fallback always targets the
  correct chat. Accepted (pi-tg is single-session; typical use = 1 chat).
- **BotFather prerequisite**: without "Inline feedback" the 1-tap path is
  dead; the Run-button fallback keeps the feature fully usable. Documented
  in README + `/help` hint.
- **Static built-in list**: pi upgrades can add/rename built-ins → the
  curated list drifts. Mitigation: version-pinned comment + the list is
  display/map data only; unknown typed names still safely fall to `unknown`.
- **Article description cap** (70, empirical) — verify against live behavior
  during implementation; if Telegram rejects, lower the cap (client-side
  truncation is already in `pi-commands.ts`).
- **Rate limits**: `answerInlineQuery` (30/s) and result-tap volume are far
  below caps; no special handling beyond the existing 429 retry.
- **Stale ctx**: `getCommands()` try/catch → `[]` after a runtime swap
  before the new `session_start` lands (list temporarily = built-ins only).
- **Security**: inline results are owner-gated (non-owner gets an empty
  answer); execution reuses the existing owner check on `cmdRun`/callbacks;
  only names from the live session table are ever dispatched to
  `sendUserMessage` (no LLM prompt injection via the picker).

## Definition of done

1. All tests above pass (`node --test`), `tsc --noEmit` clean.
2. Live smoke: `/help` → `⌨️ Pi commands` → type `mod` → results → tap
   `/model` → model picker opens (1 tap, card stamped ✅); tap a skill with
   args via typed send; terminal-only tap → explanation; non-owner phone gets
   empty results; fallback Run button works.
