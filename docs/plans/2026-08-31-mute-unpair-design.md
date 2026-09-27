# Mute / Unpair — Design

> Stop the Telegram output flood from the phone (`/mute`, `/unmute`) and unpair the
> phone from the terminal (`/tg:unpair`).

## 1. Problem

While the TUI runs, `Mirror` keeps posting agent output (working message, tool
lines, streaming edits, final answers, permission notices) to the last-known
owner chat — even when the user is at the PC and doesn't want the phone flooded
with what's already on screen. Currently there is no way to pause this, and the
only way to unpair is deleting `~/.pi/agent/pi-telegram.json` by hand.

## 2. Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Phone-side pause | **`/mute` + `/unmute`** (not full unpair) | The use case is temporary ("I'm at the PC"). Pairing survives, so `/unmute` resumes with zero re-setup. Explicit two commands beat a toggle on a phone |
| 2 | What mute suppresses | All *new* mirror content: working message, tool lines, streaming message, final answer chunks, `ui_prompt_start` notices | Mute = "don't post agent output". Command replies must keep flowing, otherwise the user could never unmute from the phone |
| 3 | What mute does *not* suppress | Cleanup of already-posted state: a working message posted *before* the mute is still finalized on `agent_end` (otherwise the chat hangs on "🤖 Working…" forever); tool-line ✔/✖ edits for lines posted pre-mute still land | One closing line per in-flight turn is not a flood; a stuck spinner is worse |
| 4 | Mute persistence | `muted: boolean` in the persisted config | "I'm at the PC" is a multi-hour / multi-restart state; in-memory would surprise the user after a pi restart |
| 5 | Terminal-side unpair | **`/tg:unpair`** clears `cfg.ownerId` **and** the in-memory `ownerChatId` | Symmetry with `/tg:pair` (whose error message currently says "delete the config file"). Unpair must reset `ownerChatId` or `Mirror` keeps posting to the stale chat — that closure lives only in `index.ts`, which is why unpair belongs on the terminal side, not as a phone command |
| 6 | After unpair | Poller keeps running; `route()` in unpaired mode lets only `/start` through → the next account to press Start becomes the owner | Re-pairing from a phone needs no TUI round-trip |
| 7 | What unpair does *not* clear | `botToken`, `lastOffset`, `sentMessageIds` | Token is the bot's identity; offset is the poller cursor; sent-ids keep `/clear` working if the same account re-pairs |

## 3. Changes by module

**`src/config.ts`** — `muted: boolean` on `TelegramConfig` (sanitized: only a real
boolean passes, default `false`); `DEFAULTS.muted = false`.

**`src/router.ts`** — `/mute` → `{ kind: "mute", chatId }`, `/unmute` →
`{ kind: "unmute", chatId }`. Unpaired mode unchanged (only `/start` passes).

**`src/command-args.ts`** — `"mute"`, `"unmute"` added to the `PLAIN` set.

**`src/session-bridge.ts`**
- `handle("mute")`: `cfg.muted = true` → persist → reply
  `🔇 Muted — I won't post agent output (progress, tools, answers) until you send /unmute. Commands still work.`
- `handle("unmute")`: `cfg.muted = false` → persist → reply `🔊 Unmuted — agent output is back on.`
- `helpText()`: two new lines.
- `statusText()`: appends `· 🔇 muted` while muted.

**`src/mirror.ts`** — each outbound event checks `this.deps.cfg.muted`
(cfg is passed by reference; a toggle takes effect on the next event):
- `onAgentStart`, `onToolStart`, `onAssistantStart`, `onUiPromptStart`: early return while muted.
- `onAgentEnd`: still finalizes an existing working message (label becomes
  `✅ Done (muted — answer not sent)` while muted), but skips `sendAnswer`.
  A turn that *started* muted posts nothing at all (no working message existed).
- `onAssistantUpdate` / `onAssistantEnd`: unchanged — they only act on a stream
  message that exists, and an in-place edit of one message is not a flood.

**`index.ts`**
- `runUnpair(ctx)`: unpaired → notice "not paired"; else clear `cfg.ownerId`,
  set `ownerChatId = undefined`, persist, notice "unpaired — bot is silent until
  a new account presses /start".
- New `tg:unpair` command registration; `TG_USAGE` extended.
- `runPair` already-paired message now points at `/tg:unpair` instead of file surgery.

**`README.md`** — phone table: `/mute`, `/unmute`. Terminal table: `/tg:unpair`.
Config table: `muted`.

## 4. Edge cases

| Case | Behavior |
|------|----------|
| Mute mid-turn | Working message + tool lines already posted get finalized (✔ / "Done"); no new tool lines, no final answer |
| Mute during streaming | The single in-place stream message keeps updating until `agent_end` deletes it; final answer is skipped |
| Unmute mid-turn | Next mirror event posts normally |
| Mute, then pi restarts | Mute persists; `/status` shows it; `/unmute` on the phone resumes |
| `/tg:unpair` then agent starts a turn | `getChatId()` → `undefined` → all mirror events are no-ops |
| `/tg:unpair` then owner taps `/start` | Re-pairs (existing unpaired flow); `ownerChatId` refreshes on the owner's next update |
| Non-owner sends `/mute` | `notAuthorized` (routing happens before any handler) |

## 5. Test plan (TDD)

- `router.test.ts`: `/mute`, `/unmute` for owner; unpaired `/mute` → notAuthorized.
- `command-args.test.ts`: round-trip for both new kinds.
- `config.test.ts`: sanitize `muted` (true / false / absent / garbage).
- bridge: mute sets `cfg.muted` + persists + reply; unmute inverts; `helpText`
  lists both; `/status` shows muted flag.
- mirror: muted → `onAgentStart`/`onToolStart`/`onAssistantStart`/`onUiPromptStart`
  post nothing; `onAgentEnd` sends no answer; pre-mute working message still
  finalized; unmute resumes posting.
