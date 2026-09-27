# Output Levels (mute / minimal / full) Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace the boolean mute with a three-level agent-output system (`mute` / `minimal` / `full`), one 1-tap command per level, implemented as a render filter over the existing single-draft rich pipeline.

**Architecture:** `TelegramConfig.muted: boolean` becomes `TelegramConfig.level: "mute" | "minimal" | "full"` (the parser migrates the legacy `muted` key). The level is a *render filter + finalize-branch flag* over the existing machinery: an exported `blocksForLevel()` drops non-visible log blocks, the draft content renders filtered blocks + the streaming tail + the unchanged `<tg-thinking>` bottom line, and `finalize()` collapses the full-level m1/m2 split into ONE persistent message for `minimal` (same notification rules). Command surface: `/level_mute` `/level_minimal` `/level_full` hard-replace `/mute` `/unmute` (router kinds, `command-args` PLAIN set, `BOT_COMMANDS`, bridge dispatch/acks, help); the status card ALWAYS shows the level suffix.

**Tech Stack:** TypeScript (Node ≥ 22.18, native TS type-stripping), `node:test`, no new dependencies. Design: `docs/plans/2026-09-06-output-levels-design.md` (source of truth for strings/behavior; this plan adapts it to the actual code — see adaptation notes).

**Verification (every task ends with):** `npx tsc --noEmit` (expect: no output) + `node --test` (expect: `# fail 0`).

**Branch:** `feat/pi-tg-v1` (already active — do not merge main into it).

## Task progress

- [ ] Task 1: config `level` + legacy `muted` migration + rename all `cfg.muted` gates
- [ ] Task 2: command surface — router kinds, command-args, bridge dispatch/acks/card/help
- [ ] Task 3: bot menu — `BOT_COMMANDS` level_* entries
- [ ] Task 4: mirror — `blocksForLevel` + minimal draft content
- [ ] Task 5: mirror — minimal finalize (one persistent message)
- [ ] Task 6: sweep — comments, README, full regression

## Adaptation notes (design → actual code, confirmed during planning)

1. The design sketch says `PairingConfig.muted`; the real code is a flat `TelegramConfig.muted` → becomes `TelegramConfig.level`.
2. The design lists the three mirror gate sites; there is a FOURTH `cfg.muted` read: `index.ts` auto-compact lane selection (`if (cfg.muted || ownerChatId === undefined) return;`). The mute level keeps suppressing auto-compact messaging exactly as today's mute does; minimal/full do not.
3. `blocksForLevel("minimal")` keeps ONLY `narration` blocks (the TUI white text). Dropped: `tool` (tool log lines), `prompt` (the mirror-generated "⚠️ terminal prompt — answer there" line — not agent output), `agentError` (carried-over ⚠️ lines). The in-flight tail (current message text = partial answer) is ALWAYS shown — it is the white text. The design delegates the exact block-type choice to planning ("types seen so far: narration, agentError, …").
4. Help-text lines: the design specifies acks and command descriptions only; the help lines follow the existing `/cmd — description` style WITHOUT the "Output level:" prefix (exact strings in Task 2).
5. Menu position: the three level entries replace `mute`/`unmute` IN PLACE (after `stop`, before `compact`); the menu grows 13 → 14 entries; relative order is mute → minimal → full per the design.
6. The README command table + config table document `/mute`/`/unmute` and `muted` — updated in Task 6 (not mentioned by the design, but they would go stale).

---

### Task 1: config `level` + legacy `muted` migration + rename all `cfg.muted` gates

**TDD scenario:** Full TDD cycle for the new config behavior (failing test first); the consumer renames are mechanical and behavior-preserving (`level === "mute"` ≡ old `muted === true`; `/unmute` sets `"full"`). The rename MUST be atomic with the config change — removing `muted` from `TelegramConfig` breaks every `cfg.muted` read (tsc + runtime), so this task is one commit.

**Files:**
- Modify: `src/config.ts` (add `OutputLevel` type; `TelegramConfig.level`; `DEFAULTS.level`; `parseLevel` in `sanitize`)
- Modify: `src/mirror.ts:512` (`startRunDraft` gate), `src/mirror.ts:816` (`requestDraftUpdate` gate), `src/mirror.ts:959` (`finalize` gate)
- Modify: `src/session-bridge.ts:388` (card — KEEP the old "muted" wording; the new always-on suffix comes in Task 2), `src/session-bridge.ts:494-502` (dispatch cases)
- Modify: `index.ts:458` (auto-compact lane gate)
- Test: `tests/config.test.ts`, `tests/helpers.ts`, `tests/bridge-core.test.ts`, `tests/bridge-mute.test.ts`, `tests/mirror-end.test.ts`, `tests/mirror-settle.test.ts`, `tests/mirror-stream.test.ts`

**Step 1: Write the failing config tests**

In `tests/config.test.ts`, replace the test `"sanitize: muted is a strict boolean, default false"` (lines 64-69) with:

```ts
test("sanitize: level — valid value passthrough, default full", () => {
  assert.equal(sanitize({}).level, "full");
  assert.equal(sanitize({ level: "mute" }).level, "mute");
  assert.equal(sanitize({ level: "minimal" }).level, "minimal");
  assert.equal(sanitize({ level: "full" }).level, "full");
  assert.equal(DEFAULTS.level, "full");
});

test("sanitize: level — corrupt value falls back to legacy muted, then default (migration)", () => {
  assert.equal(sanitize({ level: "loud" }).level, "full");
  assert.equal(sanitize({ level: "loud", muted: true }).level, "mute");
  assert.equal(sanitize({ level: "loud", muted: false }).level, "full");
  assert.equal(sanitize({ level: "mute", muted: true }).level, "mute"); // valid level wins over legacy
  assert.equal(sanitize({ level: "minimal", muted: true }).level, "minimal");
  assert.equal(sanitize({ muted: true }).level, "mute");
  assert.equal(sanitize({ muted: false }).level, "full");
  assert.equal(sanitize({ muted: "yes" }).level, "full"); // legacy must be a strict boolean
});
```

In the same file, in `"loadConfig: missing file → defaults"`, replace `assert.equal(cfg.muted, false);` with `assert.equal(cfg.level, "full");`.

**Step 2: Run the config tests to verify they fail**

Run: `node --test tests/config.test.ts`
Expected: FAIL — `sanitize({...}).level` is `undefined`, `DEFAULTS.level` is `undefined`.

**Step 3: Implement `src/config.ts`**

Add (after the `PendingAction` type):

```ts
/**
 * Agent output level — the mirror's render filter: `mute` = nothing (old
 * `muted: true`), `minimal` = visible text only (narration + answer),
 * `full` = today's behavior (draft + work log + final answer, default).
 * Commands, cards and help are unaffected by any level.
 */
export type OutputLevel = "mute" | "minimal" | "full";
```

In `TelegramConfig`, replace:

```ts
  /** When true, agent output (mirror) is suppressed; command replies still work. */
  muted: boolean;
```

with:

```ts
  /** Agent output level (see `OutputLevel`). Legacy `muted` still parses: true → "mute", false → "full". */
  level: OutputLevel;
```

In the `DEFAULTS` declaration, replace the Pick member `"muted"` with `"level"` and the value `muted: false,` with `level: "full",`.

In `sanitize`, replace:

```ts
    muted: typeof obj.muted === "boolean" ? obj.muted : DEFAULTS.muted,
```

with:

```ts
    level: parseLevel(obj),
```

and add (above `sanitize`):

```ts
/** `level`: a valid value wins; otherwise legacy `muted` (strict boolean: true → "mute", false → "full"); otherwise the default. */
function parseLevel(obj: Record<string, unknown>): OutputLevel {
  if (obj.level === "mute" || obj.level === "minimal" || obj.level === "full") return obj.level;
  if (obj.muted === true) return "mute";
  if (obj.muted === false) return "full";
  return DEFAULTS.level;
}
```

Note: `saveConfig` serializes the whole sanitized object, which no longer carries `muted` — the legacy key disappears on the next persist (design requirement, free).

**Step 4: Run the config tests to verify they pass**

Run: `node --test tests/config.test.ts`
Expected: PASS.

**Step 5: Rename the four `cfg.muted` gates (mechanical, behavior-preserving)**

- `src/mirror.ts:512`: `if (this.deps.cfg.muted || this.deps.getChatId() === undefined) return;` → `if (this.deps.cfg.level === "mute" || this.deps.getChatId() === undefined) return;`
- `src/mirror.ts:816`: `if (this.deps.cfg.muted || this.phase !== "work") return;` → `if (this.deps.cfg.level === "mute" || this.phase !== "work") return;`
- `src/mirror.ts:959`: `if (this.deps.cfg.muted) return;` → `if (this.deps.cfg.level === "mute") return;`
- `src/session-bridge.ts:388`: `${cfg.muted ? " · 🔇 muted" : ""}` → `${cfg.level === "mute" ? " · 🔇 muted" : ""}` (wording unchanged — Task 2 rewrites the line)
- `src/session-bridge.ts` dispatch: `cfg.muted = true;` → `cfg.level = "mute";` and `cfg.muted = false;` → `cfg.level = "full";` (ack texts UNCHANGED in this task — Task 2 replaces them)
- `index.ts:458`: `if (cfg.muted || ownerChatId === undefined) return;` → `if (cfg.level === "mute" || ownerChatId === undefined) return;`

**Step 6: Update the test fixtures (mechanical)**

- `tests/helpers.ts`: `muted: false,` → `level: "full",`
- `tests/bridge-core.test.ts:89`: `{ muted: true }` → `{ level: "mute" }` (the expected card line at 91 stays — old wording until Task 2)
- `tests/bridge-mute.test.ts`: `{ muted: true }` → `{ level: "mute" }`; `assert.equal(deps.cfg.muted, true)` → `assert.equal(deps.cfg.level, "mute")`; `assert.equal(deps.cfg.muted, false)` → `assert.equal(deps.cfg.level, "full")` (ack assertions unchanged — old acks still sent in this task)
- `tests/mirror-end.test.ts:317`: `{ streamEditMs: 0, muted: true }` → `{ streamEditMs: 0, level: "mute" }`
- `tests/mirror-settle.test.ts:103`: `{ muted: true }` → `{ level: "mute" }`
- `tests/mirror-stream.test.ts:234`: `{ muted: true }` → `{ level: "mute" }`

**Step 7: Verify everything**

Run: `npx tsc --noEmit` (expect: no output) and `node --test` (expect: `# fail 0`). `tsc` is the guard that no `cfg.muted` read was missed.

**Step 8: Commit**

```bash
git add src/config.ts src/mirror.ts src/session-bridge.ts index.ts tests/config.test.ts tests/helpers.ts tests/bridge-core.test.ts tests/bridge-mute.test.ts tests/mirror-end.test.ts tests/mirror-settle.test.ts tests/mirror-stream.test.ts
git commit -m "refactor(config): muted boolean → level (mute|minimal|full) with legacy migration"
```

---

### Task 2: command surface — router kinds, command-args, bridge dispatch/acks/card/help

**TDD scenario:** Full TDD cycle (new action kinds, new ack strings, always-on card level suffix, new help lines). The router kinds and the bridge `switch` cases are coupled through the `TgAction` union — they MUST land in the same commit or tsc fails (a `case` for a kind that no longer exists in the union is a type error).

**Files:**
- Modify: `src/router.ts:28-29` (`TgAction` kinds), `src/router.ts:95-96` (switch cases)
- Modify: `src/command-args.ts:3` (PLAIN set)
- Modify: `src/session-bridge.ts` (`helpText` lines 133-134, card line 388, dispatch cases 494-502)
- Test: `tests/router.test.ts`, `tests/command-args.test.ts`, `tests/bridge-core.test.ts` (card line 91), DELETE `tests/bridge-mute.test.ts` → CREATE `tests/bridge-levels.test.ts`

**Step 1: Update the router tests (failing first)**

In `tests/router.test.ts`, replace:

```ts
  assert.deepEqual(route(msgUpdate(15, owner, "/mute"), owner), { kind: "mute", chatId: 7 });
  assert.deepEqual(route(msgUpdate(16, owner, "/unmute"), owner), { kind: "unmute", chatId: 7 });
```

with:

```ts
  assert.deepEqual(route(msgUpdate(15, owner, "/level_mute"), owner), { kind: "level_mute", chatId: 7 });
  assert.deepEqual(route(msgUpdate(16, owner, "/level_minimal"), owner), { kind: "level_minimal", chatId: 7 });
  assert.deepEqual(route(msgUpdate(19, owner, "/level_full"), owner), { kind: "level_full", chatId: 7 });
  assert.deepEqual(route(msgUpdate(20, owner, "/mute"), owner), { kind: "unknown", chatId: 7, text: "/mute" });
  assert.deepEqual(route(msgUpdate(21, owner, "/unmute"), owner), { kind: "unknown", chatId: 7, text: "/unmute" });
```

(Leave the unpaired test at line 28 alone: `/mute` from a stranger is still `notAuthorized` — command name is irrelevant there.)

**Step 2: Run the router tests to verify they fail**

Run: `node --test tests/router.test.ts`
Expected: FAIL — `level_mute` etc. route to `unknown`; the old kinds no longer asserted.

**Step 3: Implement `src/router.ts`**

In `TgAction`, replace:

```ts
  | { kind: "mute"; chatId: number }
  | { kind: "unmute"; chatId: number }
```

with:

```ts
  | { kind: "level_mute"; chatId: number }
  | { kind: "level_minimal"; chatId: number }
  | { kind: "level_full"; chatId: number }
```

In the command switch, replace:

```ts
      case "mute": return { kind: "mute", chatId };
      case "unmute": return { kind: "unmute", chatId };
```

with:

```ts
      case "level_mute": return { kind: "level_mute", chatId };
      case "level_minimal": return { kind: "level_minimal", chatId };
      case "level_full": return { kind: "level_full", chatId };
```

Run: `node --test tests/router.test.ts` → PASS.

**Step 4: Update the command-args tests (failing)**

In `tests/command-args.test.ts`, replace the two entries:

```ts
    { kind: "mute", chatId: 7 },
    { kind: "unmute", chatId: 7 },
```

with:

```ts
    { kind: "level_mute", chatId: 7 },
    { kind: "level_minimal", chatId: 7 },
    { kind: "level_full", chatId: 7 },
```

Run: `node --test tests/command-args.test.ts` → FAIL (PLAIN set still has the old kinds).

**Step 5: Implement `src/command-args.ts`**

Line 3: replace `"mute", "unmute"` in the PLAIN set with `"level_mute", "level_minimal", "level_full"`.
Run: `node --test tests/command-args.test.ts` → PASS.

**Step 6: Rewrite the bridge tests — DELETE `tests/bridge-mute.test.ts`, CREATE `tests/bridge-levels.test.ts`**

Full content of the new file:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

test("level_mute: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_mute", chatId: 7 });
  assert.equal(deps.cfg.level, "mute");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔇 Level: mute — no agent output (commands still work).");
});

test("level_minimal: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_minimal", chatId: 7 });
  assert.equal(deps.cfg.level, "minimal");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔉 Level: minimal — visible text only (no tools, no thinking).");
});

test("level_full: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out, { level: "mute" });
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_full", chatId: 7 });
  assert.equal(deps.cfg.level, "full");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔊 Level: full — tool log + final answer (default).");
});

test("old /mute /unmute are gone: they land on the unknown-command path", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  await new SessionBridge(deps).dispatch({ kind: "unknown", chatId: 7, text: "/mute" });
  assert.equal(lastSend(out), "Unknown command /mute — see /help");
});

test("help lists the three level commands, not /mute or /unmute", () => {
  const h = helpText();
  assert.ok(h.includes("/level_mute"), h);
  assert.ok(h.includes("/level_minimal"), h);
  assert.ok(h.includes("/level_full"), h);
  assert.ok(!h.includes("/mute"), h);
  assert.ok(!h.includes("/unmute"), h);
});

test("status card always shows the level suffix (all three levels)", async () => {
  const header = async (level: "mute" | "minimal" | "full"): Promise<string> => {
    const pi = new FakePi({ cwd: "/proj", messageCount: 3 });
    const out = new FakeOut();
    await new SessionBridge(makeDeps(pi.build(), out, { level })).dispatch({ kind: "status", chatId: 7 });
    return (out.calls.find((c) => c.kind === "send")?.text ?? "").split("\n")[0]!;
  };
  assert.equal(await header("full"), "📌 Untitled session — idle · 🔊 full");
  assert.equal(await header("minimal"), "📌 Untitled session — idle · 🔉 minimal");
  assert.equal(await header("mute"), "📌 Untitled session — idle · 🔇 mute");
});
```

In `tests/bridge-core.test.ts:91`, replace the expected header line:

```ts
  assert.equal(lines2[0], "📌 My &lt;sess&gt; — busy · 🔇 muted");
```

with:

```ts
  assert.equal(lines2[0], "📌 My &lt;sess&gt; — busy · 🔇 mute");
```

Run: `node --test tests/bridge-levels.test.ts tests/bridge-core.test.ts`
Expected: FAIL — bridge still has the old `mute`/`unmute` cases (tsc errors too), old acks, old card wording.

**Step 7: Implement `src/session-bridge.ts`**

Import the type (add `OutputLevel` to the existing `./config.ts` import if one exists, else add):

```ts
import type { OutputLevel } from "./config.ts";
```

Add at module scope (near `helpText`):

```ts
/** The status card's always-on level suffix (and the ack emoji scale). */
const LEVEL_BADGES: Record<OutputLevel, string> = {
  mute: "🔇 mute",
  minimal: "🔉 minimal",
  full: "🔊 full",
};
```

In `helpText`, replace:

```ts
    "<b>/mute</b> — stop agent output (commands still work)",
    "<b>/unmute</b> — resume agent output",
```

with:

```ts
    "<b>/level_mute</b> — no agent output (commands still work)",
    "<b>/level_minimal</b> — visible text only (no tools, no thinking)",
    "<b>/level_full</b> — tool log + final answer (default)",
```

In `statusText`, replace the header line (388):

```ts
      `📌 ${escapeHtml(name)} — ${pi.isIdle() ? "idle" : "busy"}${cfg.level === "mute" ? " · 🔇 muted" : ""}`,
```

with:

```ts
      `📌 ${escapeHtml(name)} — ${pi.isIdle() ? "idle" : "busy"} · ${LEVEL_BADGES[cfg.level]}`,
```

In `handle`, replace the two cases (494-502):

```ts
      case "mute":
        cfg.muted = true;
        await this.deps.persist();
        await out.send(action.chatId, "🔇 Muted — I won’t post agent output (progress, tools, answers) until you send /unmute. Commands still work.");
        return;
      case "unmute":
        cfg.muted = false;
        await this.deps.persist();
        await out.send(action.chatId, "🔊 Unmuted — agent output is back on.");
        return;
```

with (exact ack strings from the design, chunk 3):

```ts
      case "level_mute":
        cfg.level = "mute";
        await this.deps.persist();
        await out.send(action.chatId, "🔇 Level: mute — no agent output (commands still work).");
        return;
      case "level_minimal":
        cfg.level = "minimal";
        await this.deps.persist();
        await out.send(action.chatId, "🔉 Level: minimal — visible text only (no tools, no thinking).");
        return;
      case "level_full":
        cfg.level = "full";
        await this.deps.persist();
        await out.send(action.chatId, "🔊 Level: full — tool log + final answer (default).");
        return;
```

**Step 8: Verify everything**

Run: `npx tsc --noEmit` (expect: no output — this catches any leftover `"mute"`/`"unmute"` kind reference) and `node --test` (expect: `# fail 0`).

**Step 9: Commit**

```bash
git add src/router.ts src/command-args.ts src/session-bridge.ts tests/router.test.ts tests/command-args.test.ts tests/bridge-core.test.ts tests/bridge-mute.test.ts tests/bridge-levels.test.ts
git commit -m "feat(commands): /level_mute /level_minimal /level_full replace /mute /unmute"
```

---

### Task 3: bot menu — `BOT_COMMANDS` level_* entries

**TDD scenario:** Modifying tested code — update the pinned-menu test first (it asserts the EXACT array, so it is the spec).

**Files:**
- Modify: `src/bot-commands.ts:17-18` (the two mute/unmute entries)
- Test: `tests/bot-commands.test.ts`

**Step 1: Update the test (failing first)**

In `tests/bot-commands.test.ts`, in the exact-menu test, replace:

```ts
    { command: "mute", description: "Stop posting agent output (commands still work)" },
    { command: "unmute", description: "Resume posting agent output" },
```

with (same position — after `stop`, before `compact`; array order = `setMyCommands` order = menu order):

```ts
    { command: "level_mute", description: "Output level: mute — no agent output (commands still work)" },
    { command: "level_minimal", description: "Output level: minimal — visible text only (no tools, no thinking)" },
    { command: "level_full", description: "Output level: full — tool log + final answer (default)" },
```

Rename the test `"BOT_COMMANDS: exact 13-command menu, in display order"` → `"BOT_COMMANDS: exact 14-command menu, in display order"`, and in the constraints test change `assert.equal(BOT_COMMANDS.length, 13);` → `assert.equal(BOT_COMMANDS.length, 14);`.

**Step 2: Run the test to verify it fails**

Run: `node --test tests/bot-commands.test.ts`
Expected: FAIL — array mismatch (mute/unmute still present, 13 entries).

**Step 3: Implement `src/bot-commands.ts`**

Replace the two entries (lines 17-18) with the three `level_*` entries exactly as in Step 1.

**Step 4: Verify**

Run: `node --test tests/bot-commands.test.ts` → PASS, then `npx tsc --noEmit` (no output) and `node --test` (`# fail 0`).

**Step 5: Commit**

```bash
git add src/bot-commands.ts tests/bot-commands.test.ts
git commit -m "feat(menu): level_* entries replace mute/unmute in setMyCommands (14 commands)"
```

---

### Task 4: mirror — `blocksForLevel` + minimal draft content

**TDD scenario:** Full TDD cycle for new behavior. The draft must stream visible text only at `minimal` (narration + partial answer) while keeping the exact same `<tg-thinking>` bottom line; `full` rendering is a regression that must not move.

**Files:**
- Modify: `src/mirror.ts` (export `blocksForLevel`; `content()` filters by level; top import of `OutputLevel`)
- Create: `tests/mirror-levels.test.ts` (new file — also hosts Task 5's finalize tests)

**Step 1: Write the failing tests — create `tests/mirror-levels.test.ts`**

```ts
// Output levels (2026-09-06 design): the level is a render filter over the
// existing single-draft pipeline — mute = nothing, minimal = visible text
// only (narration + answer) with the SAME bottom line, full = today's
// behavior (regression-covered by the existing mirror-* test files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, blocksForLevel, type LogBlock, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

type H = ReturnType<typeof makeMirrorDeps>;

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

const LOG: LogBlock[] = [
  { type: "narration", text: "Let me check." },
  { type: "tool", id: "c1", name: "read", argsJson: '{"path":"a.ts"}', state: "✔" },
  { type: "prompt", text: "⚠️ terminal prompt — answer there" },
  { type: "agentError", text: "⚠️ error: 502" },
  { type: "narration", text: "Done thinking." },
];

test("blocksForLevel: full keeps everything (same array, no copy)", () => {
  assert.equal(blocksForLevel("full", LOG), LOG);
});

test("blocksForLevel: mute keeps nothing", () => {
  assert.deepEqual(blocksForLevel("mute", LOG), []);
});

test("blocksForLevel: minimal keeps narration only", () => {
  assert.deepEqual(blocksForLevel("minimal", LOG), [
    { type: "narration", text: "Let me check." },
    { type: "narration", text: "Done thinking." },
  ]);
});

test("minimal draft: visible text only, same bottom line, no tool/thinking lines", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  // message 1: thinking + narration + tool call (committed at message_end)
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "check it" },
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "check it" },
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  // message 2: the answer starts streaming (the partial answer is visible text)
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is"));
  await tick();

  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  assert.ok(drafts.length > 0, "the draft is spawned at minimal");
  const latest = drafts[drafts.length - 1]?.text ?? "";
  assert.ok(latest.includes("Let me check."), `committed narration is in the draft: ${JSON.stringify(latest)}`);
  assert.ok(latest.includes("The answer is"), `the partial answer streams in: ${JSON.stringify(latest)}`);
  assert.ok(!latest.includes("⚙ read"), `no tool line: ${JSON.stringify(latest)}`);
  assert.ok(!latest.includes("check it"), `no thinking text: ${JSON.stringify(latest)}`);
  assert.ok(latest.includes("<tg-thinking>"), `the <tg-thinking> bottom line is present: ${JSON.stringify(latest)}`);
});

test("full draft: unchanged — tool line AND narration both render (regression)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 }); // level defaults to full
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  const drafts = h.out.calls.filter((c) => c.kind === "sendDraft");
  const latest = drafts[drafts.length - 1]?.text ?? "";
  assert.ok(latest.includes("⚙ read ✔"), `full keeps the stamped tool line: ${JSON.stringify(latest)}`);
  assert.ok(latest.includes("Let me check."), `full keeps the narration: ${JSON.stringify(latest)}`);
});
```

**Step 2: Run the tests to verify they fail**

Run: `node --test tests/mirror-levels.test.ts`
Expected: FAIL — `blocksForLevel` is not exported (import error); the minimal draft currently contains the `⚙ read` tool line.

**Step 3: Implement `src/mirror.ts`**

Add to the top imports (the `./config.ts` import line exists — extend it):

```ts
import type { OutputLevel } from "./config.ts";
```

Add the exported filter (place it right after `bottomLineText`, before `toolResultText`):

```ts
/**
 * The level's render filter over the work log: `full` → all blocks (the SAME
 * array — no copy); `minimal` → visible text only (narration blocks, the TUI
 * white text; tool / prompt / agentError lines are dropped); `mute` → nothing
 * (the pipeline is gated before rendering — this is the defensive total).
 */
export function blocksForLevel(level: OutputLevel, blocks: LogBlock[]): LogBlock[] {
  if (level === "full") return blocks;
  if (level === "minimal") return blocks.filter((b) => b.type === "narration");
  return [];
}
```

In `content()` (the single draft's content builder), filter the log by level:

```ts
  /** The single draft's full content: [log] [tail] [bottom line] — the log filtered by the level. */
  private content(bottom?: BottomLine): string {
    const log = blocksForLevel(this.deps.cfg.level, this.log);
    return blocksToMd(log, {
      tail: this.tail,
      bottom: bottom ?? this.currentBottom(),
      tokens: this.runTokens(),
    });
  }
```

(Only `content()` changes — `draftContent` caps `content`, and every draft path, including the heartbeat, flows through it. The full-level completed-state pre-edit in `finalize` is unaffected: at `full` the filter is the identity.)

**Step 4: Verify**

Run: `node --test tests/mirror-levels.test.ts` → PASS. Then `npx tsc --noEmit` (no output) and `node --test` (`# fail 0` — all existing full-level draft tests must pass unmodified).

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-levels.test.ts
git commit -m "feat(mirror): blocksForLevel + minimal draft streams visible text only"
```

---

### Task 5: mirror — minimal finalize (one persistent message per run)

**TDD scenario:** Full TDD cycle. `minimal` + clean end must skip the m1/m2 split AND the completed-state draft pre-edit, sending exactly ONE persistent message (filtered blocks + tail + `Completed ✔️` bottom) that NOTIFIES. Error/stop ends already take the single-message branch — they only gain the block filter (their tests are expected to pass immediately; they are regression guards that the filter does not break the shared mechanics: `⚠ incomplete`, error footer, stop silence — design Q3=B).

**Files:**
- Modify: `src/mirror.ts` (`finalize()`)
- Test: `tests/mirror-levels.test.ts` (append)

**Step 1: Append the failing tests to `tests/mirror-levels.test.ts`**

```ts
// ── finalize: minimal = exactly ONE persistent message per run ──

test("minimal clean end: ONE persistent message (no m1/m2 split, no pre-edit), notifies", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  // message 1: narration + tool (committed to the log — invisible at minimal)
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  m.onAssistantEnd({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  });
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  // message 2: the answer — confirms the run
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  await tick();
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `exactly one persistent message, got ${rich.length}: ${JSON.stringify(rich.map((r) => r.text))}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Let me check."), `visible narration is in the message: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("⚙ read"), `no tool line: ${JSON.stringify(text)}`);
  assert.ok(text.includes("Completed ✔️"), `the completion marker: ${JSON.stringify(text)}`);
  assert.ok(text.includes("The answer is 42."), `the answer: ${JSON.stringify(text)}`);
  const order = [text.indexOf("Let me check."), text.indexOf("Completed ✔️"), text.indexOf("The answer is 42.")];
  assert.ok(order.every((i) => i >= 0), `all parts present: ${JSON.stringify(text)}`);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `narration → marker → answer: ${JSON.stringify(text)}`);
  assert.ok(!rich[0]?.opts?.disableNotification, "the one message notifies");
  // the completed-state draft pre-edit (full's step 1) must NOT happen at minimal
  const preEdits = h.out.calls.filter((c) => c.kind === "sendDraft" && (c.text ?? "").includes("Completed"));
  assert.equal(preEdits.length, 0, "no completed-state draft pre-edit at minimal");
});

test("minimal error end: ONE message — visible text + ⚠ incomplete + error footer, notifies", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Working on it…"));
  await tick();
  await m.onAssistantEnd(textMsg("Working on it…", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentSettled(); // the stream is over — the error end persists now
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `one persistent message, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Working on it…"), `visible text so far: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠ incomplete"), `the incomplete flag: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠️ error: 502 status code (no body)"), `the error footer: ${JSON.stringify(text)}`);
  assert.ok(!rich[0]?.opts?.disableNotification, "the error end notifies");
});

test("minimal stop end: ONE message, SILENT (D4)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, level: "minimal" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Halfway there."));
  await tick();
  await m.onAssistantEnd(textMsg("Halfway there.", { stopReason: "aborted" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1, `one persistent message, got ${rich.length}`);
  const text = rich[0]?.text ?? "";
  assert.ok(text.includes("Halfway there."), `visible text: ${JSON.stringify(text)}`);
  assert.ok(text.includes("⚠️ Request was aborted"), `the stopped footer: ${JSON.stringify(text)}`);
  assert.equal(rich[0]?.opts?.disableNotification, true, "the stop end is silent");
});

test("full clean end: still TWO messages (m1 silent + m2 notifies) — regression guard", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 }); // default level = full
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Just an answer."));
  await tick();
  await m.onAssistantEnd(textMsg("Just an answer.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  assert.equal(rich[0]?.opts?.disableNotification, true, "m1 is silent");
  assert.ok(!rich[1]?.opts?.disableNotification, "m2 notifies");
});
```

**Step 2: Run the tests to verify they fail**

Run: `node --test tests/mirror-levels.test.ts`
Expected: FAIL on `"minimal clean end"` — the current code takes the full 3-step path (2 persistent sends + a completed-state pre-edit draft). The error/stop tests are expected to PASS already (regression guards — note this in the run output, don't chase them).

**Step 3: Implement `finalize()` in `src/mirror.ts`**

Replace the current body segment (from `const bottom: BottomLine =` through the `const md = blocksToMd(...)` line) with the level-aware version — the full 3-step branch runs ONLY at `full`, and the single-message branch filters the log by level:

```ts
      const level = this.deps.cfg.level;
      const bottom: BottomLine =
        this.endKind === "clean"
          ? { kind: "done" }
          : this.endKind === "error"
            ? { kind: "error", text: this.endError ?? "" }
            : { kind: "aborted" };
      if (this.endKind === "clean" && this.tail.trim() && level === "full") {
        // step 1 — the completed state in the draft. Awaited so the client sees
        // it before step 2 replaces the draft. Best effort: runDraftOnce
        // swallows failures (429/400) — the persistent messages still go out.
        if (this.draftId)
          await this.runDraftOnce(this.draftId, this.draftContent(bottom), false /* no Stop button — the run is over */);
        // step 2 — m1: the work log + the Completed marker (the answer is cut).
        // SILENT: the notification belongs to the final answer (m2) only.
        await this.sendPersistent(chatId, blocksToMd(this.log, { bottom, tokens: this.runTokens() }), { disableNotification: true });
        // step 3 — m2: the final answer, its own message — the only send that notifies.
        await this.sendPersistent(chatId, this.tail);
        return;
      }
      // minimal (or a clean end with no answer) = ONE persistent message:
      // filtered blocks + tail + the end's bottom line. Same mechanics and
      // notification rules as full — only the block filter changes by level.
      const log = blocksForLevel(level, this.log);
      const tail = this.endKind === "error" && this.tail.trim() ? `${this.tail.trimEnd()}\n\n⚠ incomplete` : this.tail;
      const md = blocksToMd(log, { tail, bottom, tokens: this.runTokens() }); // full content — chunked, never tailView-capped
      if (md.trim())
        // D4: a stop end's message is SILENT (no notification) — an error end
        // notifies (the error is the final word the user must see).
        await this.sendPersistent(chatId, md, { disableNotification: this.endKind === "stop" });
```

(Only the `const md = blocksToMd(this.log, …)` call and the 3-step guard change; the `try/finally`, the mute/no-chat early returns, and the `settle?.()` release stay exactly as they are.)

Update the `finalize()` doc comment: replace the closing line `Mute = fully silent: nothing at all.` with:

```
 * Levels: mute = fully silent (nothing at all); minimal = the 3-step split
 * never runs — ONE persistent message (filtered blocks + tail + bottom line),
 * same notification rules; full = the 3-step split above.
```

**Step 4: Verify**

Run: `node --test tests/mirror-levels.test.ts` → PASS. Then `npx tsc --noEmit` (no output) and `node --test` (`# fail 0` — the full-level m1/m2, error, and stop tests in `mirror-end.test.ts` must pass unmodified).

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-levels.test.ts
git commit -m "feat(mirror): minimal level finalizes as one persistent message"
```

---

### Task 6: sweep — comments, README, full regression

**TDD scenario:** Trivial change (comments/docs only — no behavior change). Verify by running the whole suite.

**Files:**
- Modify: `index.ts:81-84` (auto-compact lane comment), `src/mirror.ts` (file header line), `README.md` (command table + config table)

**Step 1: Apply the doc edits**

- `index.ts`, the `autoCompactLane` comment: replace `// standalone draft (bridge). Undefined = nothing to report (muted /` with `// standalone draft (bridge). Undefined = nothing to report (mute level /`.
- `src/mirror.ts`, file header: replace `Mute = fully silent: no drafts, no final messages.` with `Mute level = fully silent: no drafts, no final messages.\n * Minimal = visible text only: the draft streams narration + answer (no tool or thinking lines), and a clean end finalizes as ONE persistent message instead of the m1/m2 split (see finalize).` (keep the ` * ` comment prefix on the second line).
- `README.md` command table — replace:
  ```
  | `/mute` | stop agent output (draft, tools, answers); commands still work |
  | `/unmute` | resume agent output |
  ```
  with:
  ```
  | `/level_mute` | output level: mute — no agent output (commands still work) |
  | `/level_minimal` | output level: minimal — visible text only (no tools, no thinking) |
  | `/level_full` | output level: full — tool log + final answer (default) |
  ```
- `README.md` config table — replace:
  ```
  | `muted` | `false` | agent output suppressed (`/mute`/`/unmute` from the phone) |
  ```
  with:
  ```
  | `level` | `"full"` | agent output level: `mute` / `minimal` / `full` (set from the phone; legacy `muted` still migrates: true → `mute`, false → `full`) |
  ```

**Step 2: Full verification**

Run: `npx tsc --noEmit` (expect: no output) and `node --test` (expect: `# fail 0` — record the pass/fail counts to report).

**Step 3: Commit**

```bash
git add index.ts src/mirror.ts README.md
git commit -m "docs: output levels in comments + README (replaces /mute /unmute)"
```

---

## Execution notes

- **Batches:** execute as two batches with a checkpoint between: batch 1 = Tasks 1–3 (config + command surface + menu), batch 2 = Tasks 4–6 (mirror render filter + finalize + sweep).
- **Every task commit must be green** (tsc + full suite) — the renames are atomic by design (adaptation notes 1–2 explain why).
- **Do not touch** `docs/plans/2026-09-04-message-framework-design.md` or other historical design docs — they document superseded behavior.
- **Follow-ups explicitly out of scope** (design, chunk 3): token cache columns, card token-totals scope, `RichBlockDetails`/`RichBlockButtons` adoption.
- **After all tasks:** use the verification-before-completion skill (fresh full run of `npx tsc --noEmit` + `node --test`, evidence in the report), then finishing-a-development-branch.

## Completion criteria

- [ ] `npx tsc --noEmit` clean
- [ ] `node --test` — 0 fail (all pre-existing full-level tests unmodified and passing)
- [ ] `git log` shows the 6 task commits on `feat/pi-tg-v1`
- [ ] No `muted` identifier remains in `src/` or `index.ts` (`grep -rn "muted" src/ index.ts` → only the legacy-key strings in `config.ts`'s migration code)
