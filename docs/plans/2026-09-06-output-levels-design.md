# Output Levels (mute / minimal / full) — Design

Date: 2026-09-06 · Status: designed (brainstorm complete), awaiting implementation plan
Branch: `feat/pi-telega-v1` · Supersedes: `/mute` + `/unmute`

## Chunk progress

- [x] 1. Decisions summary + architecture context
- [x] 2. Per-level render matrix + implementation sketch + storage/migration
- [x] 3. UX surface (acks, card, help/menu) + test plan + follow-ups

## Chunk 1 — Decisions summary

Replaces the boolean mute with a three-level output system, one tap-command per level.

### Levels

| Level | Command | Agent output on Telegram |
|---|---|---|
| `mute` | `/level_mute` | nothing (today's mute) |
| `minimal` | `/level_minimal` | visible text only — the TUI "white text": narration lines + final answer. No tool log, no thinking |
| `full` (default) | `/level_full` | today's behavior: ephemeral draft preview + m1 (work log, silent) + m2 (final answer, notifies) |

### Command decisions

- Three separate zero-arg commands (not `/level <arg>`): each is a 1-tap entry in the
  Telegram command menu. Underscores in bot command names are valid per the current
  Bot API (`BotCommand.command`: "1–32 characters. Can contain only lowercase English
  letters, digits and underscores.").
- `/mute` and `/unmute` are **hard-deleted** (no aliases). Unknown commands already
  point to `/help`.
- No numeric aliases, no `/level` query command — the current level is visible on the
  status card (always shown, see chunk 3).
- `setMyCommands` menu order: `level_mute`, `level_minimal`, `level_full`
  (scale order: off → least → most).

### Per-level behavior decisions (from the brainstorm)

- **Q1 — minimal's live draft = (a) text-only stream.** The draft streams only the
  visible text (narration + answer) as it is generated; tool phases are invisible but
  the `<tg-thinking>` bottom line + heartbeat keep the ephemeral draft alive.
- **Q2 — minimal's final content = all visible text.** Intermediate "let me check X"
  lines between tool calls are white text in the TUI, so they count.
- **Q3 — errors: same mechanics as full, level-filtered content (B).** One
  `finalize()` path for all levels: error → notifies, stop → silent (D4), `⚠ incomplete`
  suffix when there was partial text. Only the block filter changes by level.
- **Q4 — bottom line kept everywhere (a).** Draft: `<tg-thinking>` spinner/heartbeat +
  live ` ↑↓`. Persisted clean end: `Completed ✔️ ↑↓` footer. One footer format for all
  three end kinds.

### Design principle

**Reuse the existing rich pipeline.** The level is a *render filter over the same
machinery* (draft pump, `blocksToMd`, `finalize`, heartbeat, settlement) — not a
parallel path. No new message-sending mechanisms; the pipeline already runs on
`sendRichMessageDraft` (drafts) + `sendRichMessage` (persistent m1/m2) with rich markdown.

## Architecture context (verified against code + live Bot API)

Current run lifecycle at `full` (the baseline `minimal` builds on):

1. **Draft** — `sendRichMessageDraft(draft_id)` (`telegram-client.ts:297`). The live
   bubble shows the bottom line only (rotating thinking word + live ` ↑↓` tokens) in a
   native `<tg-thinking>` element; `can_stop` shows the Stop button. Per the API the
   draft is **ephemeral — a temporary 30-second preview**: it must be refreshed
   (heartbeat exists for this) and disappears when the bot sends a real message.
2. **m1** — on a clean end: persistent `sendRichMessage` with the full work log
   (thinking blocks, tool lines, narration) + `Completed ✔️ ↑↓` footer. Sent **silent**
   (`mirror.ts` finalize, "the notification belongs to the final answer (m2) only").
3. **m2** — the final answer (`tail`) as its own persistent rich message — **the only
   send that notifies**.
4. **Error end** — no m1/m2 split: one persistent message = full log + partial tail +
   `⚠ incomplete` + `⚠️ error: …` footer; **notifies**. Stop end: same shape, **silent** (D4).

Facts that shape the design:

- `editMessageText`/`editRichMessage…` **never notify** — only real sends ring. The
  API's intended pattern is draft (preview) → final send (persist + notify); the
  ephemeral draft is auto-replaced by the persisted message, which is what makes the
  minimal "finalize in place" feel work with exactly one persisted bubble per run.
- `<tg-thinking>` is a native tag of `sendRichMessageDraft` (docs: "you can use the
  following tag in sendRichMessageDraft: `<tg-thinking>Thinking...</tg-thinking>`").
- The level applies to **agent output only** (mirror). Commands, cards (`/start`,
  `/new`, `/sessions`, `/status`, pairing), the `🔄 … ✔️` reload stamp, and help are
  unaffected by any level — same as today's mute.

## Chunk 2 — Render matrix, implementation sketch, storage

### Per-level render matrix

Content surfaces; "visible text" = narration lines + answer text (the TUI white text).

| Surface | `mute` | `minimal` | `full` (default) |
|---|---|---|---|
| Draft (ephemeral, during run) | not spawned | visible text so far (narration + partial answer), streaming; `<tg-thinking>` bottom line (spinner + live ` ↑↓`); Stop button | bottom line only (spinner + live ` ↑↓`); Stop button |
| Run ends clean | nothing | **1 message**: all visible text + `Completed ✔️ ↑↓` footer — **notifies**; draft auto-replaced by it | m1: full log + `Completed ✔️ ↑↓` — silent; m2: answer — **notifies** |
| Run ends in error | nothing | **1 message**: visible text so far + `⚠ incomplete` (if any) + `⚠️ error: …` footer — **notifies** | 1 message: full log + tail + `⚠ incomplete` + error footer — **notifies** |
| Run stopped by user | nothing | 1 message: visible text + stopped footer — **silent** (D4) | 1 message: full log + tail + stopped footer — **silent** (D4) |
| Heartbeat | n/a | keeps the ephemeral draft alive through tool phases (existing mechanism) | as today |

`minimal` never produces the m1/m2 split — exactly one persisted message per run.

### Implementation sketch

The level is a render filter + a finalize-branch flag over the existing pipeline.

1. **`src/config.ts`** — `PairingConfig.muted: boolean` → `level: "mute" | "minimal" | "full"`;
   `DEFAULTS.level = "full"`; parser: accept `obj.level` if valid, else legacy
   `obj.muted` (true→`"mute"`, false→`"full"`), else default; update the persisted-key
   list (the `"muted"` entry at `config.ts:55`) to `"level"`.
2. **`src/mirror.ts`** —
   - `cfg.muted` gates become `level === "mute"` (rename; same three gate sites:
     `startRunDraft`, `finalize`, `requestDraftUpdate`).
   - **Block filter** `blocksForLevel(level, blocks)`: `full` → all blocks; `minimal` →
     visible-text block types only (narration + answer text; drop thinking/tool/log
     types). The exact block-type names are confirmed against the current log model
     during planning (types seen so far: `narration`, `agentError`, …).
   - **Draft content**: today `draftContent(bottom)` is bottom-line-only. `minimal`
     renders visible blocks accumulated so far (narration + partial answer) + the same
     bottom line. The streaming plumbing already exists (per-assistant-update parts
     accumulation into `log`/`tail`); the plan wires "visible text so far" into the
     draft render.
   - **`finalize()`**: for `minimal` + clean end, skip the m1/m2 split and the
     draft-completed-state pre-edit; send **one** persistent `sendRichMessage`
     (filtered blocks + tail + `Completed ✔️ ↑↓` footer) **with notification**. Error/stop
     ends already take the single-message branch — they just get the block filter.
     Notification rules stay identical to `full` (Q3=B: same code path, same rules).
3. **`src/session-bridge.ts`** — delete the `mute`/`unmute` dispatch cases; add
   `level_mute` / `level_minimal` / `level_full`: set `cfg.level`, `await persist()`,
   send the ack (chunk 3). Card header line gains the level suffix (chunk 3).
4. **`src/bot-commands.ts`** — replace the two mute entries with the three
   `level_*` entries (descriptions per chunk 3); array order = menu order.
5. **`src/wiring.ts` / `src/telegram-client.ts`** — no new methods needed; the client
   already exposes `sendRichMessage` / `sendRichMessageDraft`. Only type updates if the
   `cfg` surface in the mirror's deps changes shape.

### Storage & migration

- Persisted pairing config: `muted: boolean` → `level: "mute" | "minimal" | "full"`.
- **Migration** (in the config parser, no version field): legacy `muted: true` →
  `level: "mute"`; `muted: false` / absent → `"full"`. New pairings default to `"full"`.
- After load, persist writes `level`; the legacy `muted` key disappears on next persist.
- Invalid/corrupt `level` value → fall back to legacy `muted`, then `"full"`.

### Scope guard (YAGNI)

- No `/level` query command (card shows the level), no numeric aliases, no per-message
  level override, no group-chat receiver scoping (ephemeral-message features are a
  different concern), no `RichBlockDetails`/`RichBlockButtons` adoption (follow-up).

## Chunk 3 — UX surface, test plan, follow-ups

### Acks (one per command, speaker-volume emoji scale)

- `/level_mute` → `🔇 Level: mute — no agent output (commands still work).`
- `/level_minimal` → `🔉 Level: minimal — visible text only (no tools, no thinking).`
- `/level_full` → `🔊 Level: full — tool log + final answer (default).`

### Status card

The header line always shows the level (replacing today's ` · 🔇 muted`, which appeared
only when muted):

```
📌 <name> — idle · 🔊 full
📌 <name> — idle · 🔉 minimal
📌 <name> — busy · 🔇 mute
```

### Help / command menu

`bot-commands.ts` entries (array order = `setMyCommands` order = menu order):

| command | description |
|---|---|
| `level_mute` | Output level: mute — no agent output (commands still work) |
| `level_minimal` | Output level: minimal — visible text only (no tools, no thinking) |
| `level_full` | Output level: full — tool log + final answer (default) |

The `/mute` and `/unmute` entries are removed.

### Test plan (TDD)

- **config** — level parsing: valid value passthrough; legacy `muted: true` → `mute`;
  legacy `muted: false` / absent → `full`; corrupt value → fallback chain; default
  `full`; persisted-key list contains `level`, not `muted`.
- **commands** — each `level_*` sets `cfg.level`, persists, sends its ack; `mute` /
  `unmute` now fall through to the unknown-command path.
- **mirror matrix** (fake-pi harness):
  - `mute`: no draft spawned, no finalize sends (existing mute tests, renamed).
  - `minimal` clean: draft content contains narration + partial answer, no tool or
    thinking lines, bottom line present; finalize sends exactly **one** persistent
    message (not two) with `Completed ✔️ ↑↓` footer; notification enabled.
  - `minimal` error: one message; visible text so far + `⚠ incomplete` (when text
    exists) + `⚠️ error: …` footer; notification enabled.
  - `minimal` stop: one message, silent.
  - `full`: all existing draft/m1/m2/error/stop tests pass unmodified (regression).
- **card** — header suffix renders all three levels; the old `muted` wording is gone.

### Follow-ups (explicitly out of scope)

1. **Token display cache columns** — pi-telega's ` ↑↓` omits `cacheRead` /
   `cacheWrite` (pi's TUI footer shows `R… W…`). On caching servers (e.g. the local
   llama server reporting prefix-cache hits) the card and bottom line under-report the
   prompt actually sent. Separate design.
2. **Card token totals scope** — the card sums assistant messages of the current
   branch; the TUI footer sums all entries incl. `toolResult` usage and
   `compaction` / `branch_summary` entry usage, so the two surfaces disagree on
   compacted/branched sessions.
3. **Rich block polish** — `RichBlockDetails` for a natively collapsible tool log in
   m1; `RichBlockButtons` for native buttons; a dedicated thinking block for the
   draft.
