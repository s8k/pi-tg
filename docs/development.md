# Development

Contributor documentation for pi-tg. The README links here for
implementation details; keep user-facing behavior in `README.md`.

## Tests

```bash
npx tsc --noEmit            # type gate (strict, erasable-TS)
node --test                 # all tests (node:test, .ts run natively)
node --test tests/router.test.ts   # single file
```

## Module boundary

Only the root `index.ts` may import `@earendil-works/pi-coding-agent`.
Every `src/` module is pi-free and takes injected interfaces
(`TelegramPi`, `Out`, `FetchLike`); `tests/boundary.test.ts` enforces the
rule mechanically.

| Module | Responsibility |
|---|---|
| `src/config.ts` | config load/save, env token override, sanitize (id cap, sent-ids cap) |
| `src/telegram-client.ts` | Bot API calls, 429 retry, poller loop + offset management |
| `src/rich-blocks.ts` | the blocks tier: `TgBlock`/`TgRichText` types, cost model, `inlineToRichText`, `mdToBlocks`, `tailBlocks`/`chunkBlocks` @32k, `blocksToPlainText` (pure) |
| `src/markdown.ts` | survivors: `richUnits` block skeleton, `chunkText` plain-rung chunking, work-log helpers (`toolArgsJson` / `extractWhy`) |
| `src/thinking.ts` | `supportedThinkingLevels(model)` — mirror of Pi’s selection logic (pure) |
| `src/bot-commands.ts` | Telegram bot menu (`setMyCommands`) — single source of truth for the bot command list (pure) |
| `src/ui-dialogs.ts` | in-flight mirrored dialogs: render, reply/number routing, first-answer-wins stamps (pure) |
| `src/compact.ts` | stoppable manual compaction for `/compact` — replays Pi’s default summarization with its own abort controller |
| `src/gpu.ts` | NVIDIA GPU temp/util/memory probe for `/status` (never throws, bounded timeout) |
| `src/router.ts` | update → typed action (pure) |
| `src/command-args.ts` | `/tg internal …` encode/parse (pure) |
| `src/session-bridge.ts` | all phone-command logic behind the `TelegramPi` interface |
| `src/mirror.ts` | Pi events → one blocks draft per turn (footer, 17 s heartbeat) + blocks→plain finalization |
| `src/onboarding.ts` | QR rendering, token validation, pairing selector title, pairing texts (pure) |
| `src/state.ts` | per-instance state: offset, sent ids, list caches |
| `src/wiring.ts` | `makeOut` / `makeTelegramPi` adapters (structural Pi mirrors) |

## Bot command menu

The row order of the README’s bot-commands table matches the Telegram `/`
command menu — set via `setMyCommands` on every poller start (self-healing;
single source of truth in `src/bot-commands.ts`). `/start` is handled by the
bot but deliberately not listed in the menu.

## Internal config fields

Fields in `~/.pi/agent/pi-tg.json` that manage state rather than behavior:

| Field | Default | Meaning |
|---|---|---|
| `ownerChatId` | — | owner’s chat id, persisted on first message so the bot can post right after `/reload` (restored on `/reload` only, not on process start — after a restart the bot stays silent until the owner writes) |
| `sentMessageIds` | `[]` | recent sent message ids (dedupe; capped at 500) |
| `lastOffset` | `0` | long-poll offset (survives restarts) |
| `seenUpdateIds` | `[]` | recently handled update ids (replay guard: if the offset ever regresses — crash, 409 twin — Telegram redelivers those updates and they are skipped, not re-processed; capped at 200) |
