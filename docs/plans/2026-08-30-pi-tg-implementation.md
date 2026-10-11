# pi-tg Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.
> Design spec: `docs/plans/2026-08-29-pi-tg-design.md` (this plan implements it; where they conflict, this plan wins and the conflict is noted inline).

**Goal:** A pi extension that bridges a local Pi Coding Agent (TUI process) to Telegram via Bot API long polling, so the phone and the terminal are co-clients of the same live session.

**Architecture:** One pi extension running inside the live TUI process. Modules are pure functions of (inputs, fakes) and communicate through a small `Out` interface (send/edit/delete/answer) and an injected `TelegramPi` interface (the pi API surface). The Telegram poller is a per-extension-instance loop started at `session_start`, stopped at `session_shutdown`. Session-control operations (`newSession`/`switchSession`/`waitForIdle`) are only available on pi's command context, so the bridge dispatches them by sending `/tg internal <action>` through `pi.sendUserMessage(..., { expandPromptTemplates: true })`, which pi executes *immediately* (even mid-stream) with a full `ExtensionCommandContext`. Because `newSession`/`switchSession` replace the extension instance (old instance `session_shutdown` → new instance `session_start`), anything that must survive the replacement (pending Telegram actions, poll offset, sent message IDs) is persisted to `~/.pi/agent/pi-telegram.json` before the call and consumed by the new instance on `session_start`.

**Tech Stack:** TypeScript (erasable syntax only — Node type-stripping), Node ≥ 22.6 (dev on 26.x), global `fetch`, one runtime dep `qrcode@1.5.4` (QR matrix via `QRCode.create`, rendered `█`/`▁`), `@earendil-works/pi-coding-agent` as devDependency for types only, tests via built-in `node:test` + `node:assert`. No build step: pi loads `index.ts` via jiti, `tsc --noEmit` is the type gate, `node --test` runs `.ts` tests directly.

---

## Progress tracker (chunks)

| Chunk | Content | Status |
|-------|---------|--------|
| A | Skeleton, API facts, conventions | ✅ |
| B | Phase 1 — scaffolding (Tasks 1–2) | ✅ |
| C | Phase 2 — `config.ts` (Task 3) | ✅ |
| D | Phase 3a — `markdown.ts` escape + inline (Task 4) | ✅ |
| E | Phase 3b — `markdown.ts` fences, chunking, plain fallback (Tasks 5–6) | ✅ |
| F | Phase 4 — `telegram-client.ts` (Tasks 7–9) | ✅ |
| G | Phase 5 — `router.ts` (Task 10) | ✅ |
| H | Phase 6 — `state.ts` + `onboarding.ts` (Tasks 11–12) | ✅ |
| I | Phase 7 — `session-bridge.ts` (Tasks 13–15) | ✅ |
| J | Phase 8 — `mirror.ts` (Tasks 16–18) | ✅ |
| K | Phase 9 — `command-args.ts` + `wiring.ts` + `index.ts` (Tasks 19–21) | ✅ |
| L | Phase 10 — README, CI, final verification (Tasks 22–23) | ✅ |

Checkpoint after each chunk (and at phase boundaries B/C, F, I, K): run `npx tsc --noEmit && node --test` — both must pass before starting the next chunk.

## Verified API facts (pi 0.84.4 — verified in source, do not re-derive)

1. **Extension entry:** `export default function (pi: ExtensionAPI) { pi.on(...); pi.registerCommand(...) }` from `@earendil-works/pi-coding-agent`. Loaded via jiti; TS works without build. Do not start background resources in the factory — defer to `session_start`; register an idempotent `session_shutdown` handler.
2. **Command-context dispatch (the load-bearing trick):** `pi.sendUserMessage("/tg internal <action> <arg>", { expandPromptTemplates: true })` → pi's `prompt()` checks `text.startsWith("/")` *first* and executes registered extension commands **immediately, even while streaming**, via `runner.createCommandContext()` (full `waitForIdle`/`newSession`/`switchSession`). No user message is appended to the session. If no command matches, the text falls through as a prompt — so only ever dispatch known command names.
3. **Context liveness:** every `ExtensionContext` member is a lazy getter (`runner.assertActive()` + resolve at call time), so one ctx captured at `session_start` stays valid for the whole instance lifetime. After `newSession`/`switchSession` the old instance is torn down and a **new extension instance** is created (new factory run → new `session_start`).
4. **`pi.sendUserMessage(text, { deliverAs, expandPromptTemplates })`** is fire-and-forget (returns `void`; internal errors are caught by pi and shown in the TUI). `deliverAs: "steer"` queues while streaming (matches terminal Esc-interrupt intuition). `expandPromptTemplates: true` also expands `/skill:name` and prompt templates — use it for free text from the phone so skills work remotely.
5. **Events we use** (`pi.on`): `session_start {reason: "startup"|"reload"|"new"|"resume"|"fork", previousSessionFile?}`, `session_shutdown {reason}`, `session_info_changed {name?}`, `agent_start`, `agent_end {messages: AgentMessage[]}`, `message_start/message_update/message_end {message: AgentMessage}`, `tool_execution_start {toolCallId, toolName, args}`, `tool_execution_update`, `tool_execution_end {toolCallId, toolName, result, isError}`, `ui_prompt_start {kind: "confirm"|..., title?}` (fired for any blocking `ctx.ui.confirm` — the cc-safety-net signal). Assistant `AgentMessage.content` is `(TextContent|ImageContent)[]`; aborted turns end with `stopReason: "aborted"` (partial text kept).
6. **`ctx` surface:** `mode` ("tui" guarded), `cwd`, `isIdle()`, `abort()` (Esc-equivalent: aborts active turn + restores queued steer text to terminal editor), `hasPendingMessages()`, `shutdown()` (graceful, deferred until idle), `compact({customInstructions?, onComplete?(result), onError?(error)})`, `getContextUsage() → {tokens: number|null, contextWindow, percent: number|null} | undefined`, `model: Model | undefined` `{id, name, provider, reasoning, thinkingLevelMap?}`, `thinkingLevel?`, `scopedModels: readonly {model, thinkingLevel?}[]` (empty = unscoped), `modelRegistry.getAvailable(): Model[]`, `sessionManager` (read-only: `getSessionFile()`, `getSessionName()`, `getBranch(): SessionEntry[]` — entries with `type === "message"`), `ui.setWidget(key, string[] | undefined)`, `ui.notify(msg, "info"|"warning"|"error")`.
7. **`SessionManager.list(cwd)`** (static import from pi package) → `Promise<SessionInfo[]>`, `SessionInfo = { path, id, cwd, name?, created: Date, modified: Date, messageCount, firstMessage, allMessagesText }`.
8. **Thinking levels:** pi's exact selection logic (mirror it in `src/thinking.ts`): `EXTENDED = ["off","minimal","low","medium","high","xhigh","max"]`; non-reasoning model → `["off"]` only; reasoning model → every level except those with `thinkingLevelMap[level] === null`, **and** `xhigh`/`max` only if `thinkingLevelMap` has an explicit (non-null) entry for them. `pi.setThinkingLevel(level)` clamps automatically.
9. **Telegram Bot API gotchas:** callback data ≤ 64 bytes (use short JSON keys `{"a":"act","i":2}`); `deleteMessage` on an already-deleted/too-old message returns `ok:false, error_code:400, description:"Message to delete not found"` — treat as success; `429` carries `parameters.retry_after` (seconds); `409` = token polled elsewhere; `400 "can't parse entities"` = HTML fallback trigger; `sendMessage`/`editMessageText` limit is 4096 chars; omitting `reply_markup` on edit removes buttons.
10. **Windows/Node test commands:** `node --test` (bare, auto-discovers `**/*.test.ts` — Node 26 native type-stripping) and `node --test tests/<file>.test.ts`. `node --test tests/` (directory) does NOT work on Windows — never use it. `tsc --noEmit` for types.
11. **QR:** `QRCode.create(text, { errorCorrectionLevel: "L" })` is synchronous → `{ modules: { size, data: Uint8Array } }` (row-major, 1 = dark). `https://t.me/<username>` needs a 25×25 matrix at ECC-L. Render rows with `█`/`▁` — do NOT use `QRCode.toString(..., {type:"terminal"})` (ANSI escapes, 554 chars wide).
12. **Config location:** `getAgentDir()` from pi exports `~/.pi/agent` — config file is `join(getAgentDir(), "pi-telegram.json")`.

## Conventions

- **TDD for every task:** failing test → run (see it fail) → minimal implementation → run (see it pass) → `tsc --noEmit` → commit. Each step below is 2–5 minutes of work.
- **Commits:** `git add <exact files> && git commit -m "<type>: <imperative summary>"`; types: `chore|feat|test|docs`. Commit at every task step 5.
- **Module boundary rule:** only `index.ts` imports `@earendil-works/pi-coding-agent` at runtime (types + `getAgentDir` + `SessionManager`); all `src/` modules take interfaces (`TelegramPi`, `Out`, `FetchLike`) and stay pi-free. `tests/fake-pi.ts` implements exactly `TelegramPi`; `tests/fake-fetch.ts` scripts Bot API responses.
- **Erasable-TS only:** no `enum`, no namespace, no constructor parameter properties. Use `interface`/`type` + string-literal unions.
- **Reply language:** all Telegram texts are English; emoji as specified in the design doc §4.

## File layout (target state)

```
pi-tg/
├── index.ts                  # entry: wiring, /tg command, poller lifecycle (only runtime pi importer)
├── package.json              # "type":"module"; dep: qrcode; devDep: pi-coding-agent (types), typescript, @types/node
├── tsconfig.json
├── .gitignore
├── README.md
├── src/
│   ├── config.ts             # load/save ~/.pi/agent/pi-telegram.json; PI_TELEGRAM_BOT_TOKEN override
│   ├── telegram-client.ts    # Bot API: call/429/409/400-parse, methods, poller loop + offset
│   ├── markdown.ts           # md→Telegram HTML + chunking ≤4096 + plain-text fallback
│   ├── thinking.ts           # supportedThinkingLevels(model) — mirror of pi's logic
│   ├── router.ts             # update → typed TgAction (pure)
│   ├── command-args.ts       # encode/parse `/tg internal …` command args (pure)
│   ├── session-bridge.ts     # TelegramPi interface + all bot command logic
│   ├── mirror.ts             # pi events → Telegram (working msg, tools, finalize, cards, notes)
│   ├── onboarding.ts         # QR rendering, token validation, pairing/allowlist (pure)
│   ├── state.ts              # TelegramState: sent IDs (cap 500), offset, working/tool msg ids
│   └── wiring.ts             # makeOut + makeTelegramPi adapters (pi-free, structural types)
└── tests/
    ├── fake-pi.ts, fake-fetch.ts, helpers.ts
    ├── smoke, config, markdown, telegram-client, router, state, onboarding, thinking .test.ts
    ├── mirror-helpers.ts
    ├── bridge-core, bridge-sessions, bridge-misc, mirror-tools, mirror-stream, mirror-end .test.ts
    ├── command-args, wiring, boundary .test.ts
```

---

## Phase 1 — Scaffolding

### Task 1: Project manifest + toolchain

**TDD scenario:** Trivial change (no behavior yet) — no test, verify with `tsc`.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/vendor/qrcode.d.ts` (qrcode ships no types; local declaration keeps deps at exactly one)

**Step 1: Write `package.json`**

```json
{
  "name": "pi-tg",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "pi extension: drive your local Pi Coding Agent from Telegram (Bot API, long polling)",
  "dependencies": {
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.84.4",
    "@types/node": "^26.4.0",
    "typescript": "^5.9.3"
  }
}
```

Notes: `@earendil-works/pi-coding-agent` is a devDependency **for types only** — `index.ts` imports it at runtime under pi (which provides it), never under `node --test`. Pin typescript to 5.x deliberately (7.x is the new Go compiler; stay on the known-good flag surface).

**Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

Notes: `allowImportingTsExtensions` + `noEmit` → relative imports use the real `.ts` extension (`import { x } from "./src/config.ts"`) — required by Node type-stripping at test time and understood by jiti at pi runtime. `verbatimModuleSyntax` enforces `import type` for type-only imports (they are erased, keeping modules pi-free).

**Step 3: Write `.gitignore`**

```
node_modules/
.pi/
```

**Step 4: Write `src/vendor/qrcode.d.ts`**

```ts
declare module "qrcode" {
  export interface QRCodeModules {
    size: number;
    /** Row-major; 1 = dark module. */
    data: Uint8Array;
  }
  export interface QRCodeResult {
    modules: QRCodeModules;
  }
  export function create(text: string, options?: Record<string, unknown>): QRCodeResult;
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>;
  const QRCode: {
    create: typeof create;
    toString: typeof toString;
  };
  export default QRCode;
}
```

**Step 5: Install + typecheck**

Run: `npm install` (repo root `C:\tmp\pi-tg`)
Then: `npx tsc --noEmit`
Expected: install succeeds; tsc prints nothing (no errors).

**Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/vendor/qrcode.d.ts
git commit -m "chore: scaffold pi-tg (package, tsconfig, qrcode types)"
```

### Task 2: Test-runner smoke test

**TDD scenario:** New infrastructure — prove `node --test` executes TypeScript on this machine before the plan depends on it.

**Files:**
- Create: `tests/smoke.test.ts`

**Step 1: Write `tests/smoke.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("scaffolding: node --test runs TypeScript directly", () => {
  const n: number = 41;
  assert.equal(n + 1, 42);
});
```

**Step 2: Run**

Run: `node --test`
Expected: `ℹ tests 1` / `ℹ pass 1` / `ℹ fail 0`. (Bare `node --test` auto-discovers `**/*.test.ts` on Node 26. Do NOT use `node --test tests/` — directory form fails on Windows.)

**Step 3: Commit**

```bash
git add tests/smoke.test.ts
git commit -m "test: smoke test for native TS test runner"
```

**Checkpoint B:** `npx tsc --noEmit && node --test` → both green before Phase 2.

---

## Phase 2 — Configuration

Design §10. The config file also carries the two runtime values that must survive a session replacement (extension-instance swap): `lastOffset` (polling cursor) and `pendingAction` (Telegram-initiated `/new` or session-activate, consumed by the new instance on `session_start`).

### Task 3: `src/config.ts`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Step 1: Write the failing test `tests/config.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, getBotToken, loadConfig, sanitize, saveConfig } from "../src/config.ts";

function tempPath(): { opts: { path: string }; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-tg-cfg-"));
  const path = join(dir, "pi-telegram.json");
  return { opts: { path }, path };
}

test("configPath: default under ~/.pi/agent, override honored", () => {
  assert.equal(configPath(), join(homedir(), ".pi", "agent", "pi-telegram.json"));
  assert.equal(configPath({ path: "/x/y.json" }), "/x/y.json");
});

test("loadConfig: missing file → defaults", () => {
  const { opts } = tempPath();
  const cfg = loadConfig(opts);
  assert.equal(cfg.botToken, undefined);
  assert.equal(cfg.ownerId, undefined);
  assert.equal(cfg.streamEditMs, DEFAULTS.streamEditMs);
  assert.equal(cfg.toolPreviewChars, DEFAULTS.toolPreviewChars);
  assert.equal(cfg.askClearOnSwitch, true);
  assert.equal(cfg.maxSessionList, 20);
  assert.deepEqual(cfg.sentMessageIds, []);
});

test("saveConfig/loadConfig round-trip", () => {
  const { opts } = tempPath();
  const cfg = { ...loadConfig(opts), botToken: "123:ABC", ownerId: 42, lastOffset: 999, sentMessageIds: [1, 2, 3] };
  saveConfig(cfg, opts);
  const back = loadConfig(opts);
  assert.equal(back.botToken, "123:ABC");
  assert.equal(back.ownerId, 42);
  assert.equal(back.lastOffset, 999);
  assert.deepEqual(back.sentMessageIds, [1, 2, 3]);
});

test("getBotToken: env override wins, blank env falls through", () => {
  const { opts } = tempPath();
  const cfg = { ...loadConfig(opts), botToken: "file-token" };
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGRAM_BOT_TOKEN: "env-token" } }), "env-token");
  assert.equal(getBotToken(cfg, { ...opts, env: {} }), "file-token");
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGRAM_BOT_TOKEN: "  " } }), "file-token");
});

test("loadConfig: corrupt JSON → defaults, no throw", () => {
  const { opts, path } = tempPath();
  writeFileSync(path, "{not json", "utf-8");
  assert.deepEqual(loadConfig(opts).sentMessageIds, []);
});

test("sanitize: sentMessageIds capped at 500 (newest kept) + deduped + invalid dropped", () => {
  const ids = Array.from({ length: 600 }, (_, i) => i + 1); // 1..600
  const cfg = sanitize({ sentMessageIds: [...ids, 600, "nope", -5] });
  assert.equal(cfg.sentMessageIds.length, 500);
  assert.equal(cfg.sentMessageIds[0], 101);   // oldest 1..100 dropped
  assert.equal(cfg.sentMessageIds[499], 600);  // newest kept
});

test("sanitize: clamps and drops invalid fields", () => {
  const cfg = sanitize({
    streamEditMs: 10,        // below min → default
    toolPreviewChars: "x",   // not a number → default
    maxSessionList: 999,     // above max → default
    askClearOnSwitch: "yes", // not a boolean → default
    ownerId: "42",           // not a number → undefined
    botToken: "",            // empty → undefined
    pendingAction: { type: "activate", chatId: 7 }, // missing path → undefined
  });
  assert.equal(cfg.streamEditMs, DEFAULTS.streamEditMs);
  assert.equal(cfg.toolPreviewChars, DEFAULTS.toolPreviewChars);
  assert.equal(cfg.maxSessionList, DEFAULTS.maxSessionList);
  assert.equal(cfg.askClearOnSwitch, DEFAULTS.askClearOnSwitch);
  assert.equal(cfg.ownerId, undefined);
  assert.equal(cfg.botToken, undefined);
  assert.equal(cfg.pendingAction, undefined);
  const ok = sanitize({ pendingAction: { type: "activate", chatId: 7, path: "C:/x/s.jsonl" } });
  assert.deepEqual(ok.pendingAction, { type: "activate", chatId: 7, path: "C:/x/s.jsonl" });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.ts`.

**Step 3: Write the implementation `src/config.ts`**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PendingAction =
  | { type: "new"; chatId: number }
  | { type: "activate"; chatId: number; path: string };

export interface TelegramConfig {
  botToken?: string;
  ownerId?: number;
  streamEditMs: number;
  toolPreviewChars: number;
  askClearOnSwitch: boolean;
  maxSessionList: number;
  /** IDs of bot-sent messages, for chat cleaning (capped at 500, newest last). */
  sentMessageIds: number[];
  /** Polling cursor, persisted so a restart/instance-swap resumes without re-read. */
  lastOffset?: number;
  /** Set before newSession/switchSession; consumed by the replacement instance. */
  pendingAction?: PendingAction;
}

export interface ConfigOptions {
  /** Override the config file path (tests). */
  path?: string;
  /** Process env for the token override (tests). */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULTS: Pick<
  TelegramConfig,
  "streamEditMs" | "toolPreviewChars" | "askClearOnSwitch" | "maxSessionList" | "sentMessageIds"
> = {
  streamEditMs: 1500,
  toolPreviewChars: 300,
  askClearOnSwitch: true,
  maxSessionList: 20,
  sentMessageIds: [],
};

export function configPath(opts?: ConfigOptions): string {
  return opts?.path ?? join(homedir(), ".pi", "agent", "pi-telegram.json");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const v = Math.round(value);
    if (v >= min && v <= max) return v;
  }
  return fallback;
}

function capSentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0 && !seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids.slice(-500);
}

function sanitizePending(value: unknown): PendingAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.chatId !== "number" || !Number.isFinite(p.chatId)) return undefined;
  if (p.type === "new") return { type: "new", chatId: p.chatId };
  if (p.type === "activate" && typeof p.path === "string" && p.path !== "") {
    return { type: "activate", chatId: p.chatId, path: p.path };
  }
  return undefined;
}

/** Repair a raw (possibly hand-edited/corrupt) config object into a valid one. */
export function sanitize(raw: unknown): TelegramConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    botToken: typeof obj.botToken === "string" && obj.botToken.trim() !== "" ? obj.botToken : undefined,
    ownerId: typeof obj.ownerId === "number" && Number.isFinite(obj.ownerId) ? obj.ownerId : undefined,
    streamEditMs: clampInt(obj.streamEditMs, DEFAULTS.streamEditMs, 500, 10_000),
    toolPreviewChars: clampInt(obj.toolPreviewChars, DEFAULTS.toolPreviewChars, 50, 1_000),
    askClearOnSwitch: typeof obj.askClearOnSwitch === "boolean" ? obj.askClearOnSwitch : DEFAULTS.askClearOnSwitch,
    maxSessionList: clampInt(obj.maxSessionList, DEFAULTS.maxSessionList, 5, 50),
    sentMessageIds: capSentIds(obj.sentMessageIds),
    lastOffset: typeof obj.lastOffset === "number" && Number.isFinite(obj.lastOffset) ? obj.lastOffset : undefined,
    pendingAction: sanitizePending(obj.pendingAction),
  };
}

export function loadConfig(opts?: ConfigOptions): TelegramConfig {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(opts), "utf-8")));
  } catch {
    return sanitize({}); // missing or corrupt → defaults (never crash pi on a bad file)
  }
}

/** Effective bot token: env `PI_TELEGRAM_BOT_TOKEN` (preferred) beats the stored value. */
export function getBotToken(cfg: TelegramConfig, opts?: ConfigOptions): string | undefined {
  const env = opts?.env ?? process.env;
  const fromEnv = env.PI_TELEGRAM_BOT_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return cfg.botToken;
}

/** Atomic-ish write (tmp + rename) so a crash never leaves a torn config file. */
export function saveConfig(cfg: TelegramConfig, opts?: ConfigOptions): void {
  const path = configPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmp, path);
}
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.ts`
Expected: `pass 7 / fail 0`. Then `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config load/save with env token override, caps, pendingAction"
```

**Checkpoint C:** `npx tsc --noEmit && node --test` → all green before Phase 3.

---

## Phase 3a — Markdown: escape + inline

Design §3, decision 7 (the riskiest module — golden-tested). This task covers escaping and **inline** conversion. Block-level (fences) and chunking come in Phase 3b.

**Contract:** `inlineToHtml` takes ONE line of markdown (no newlines) and returns Telegram HTML. It guarantees **balanced tags**: every emitted open tag has its close, and unmatched markers stay literal. If Telegram ever rejects the HTML (`400 can't parse entities`), the caller falls back to plain text (Phase 3b) — that is the safety net, not an expectation.

**Order of operations (why):** code spans are stashed first so no formatting is parsed inside them; links second (URL never touched by emphasis passes, link text fully parsed recursively); the rest is escaped; then bold → strike → italic pass over the escaped string; placeholders restored last. Bold runs before italic so `**bold *ital* bold**` and `*ital **bold** ital*` both resolve (bold content class admits single stars; italic pass then formats inside it).

### Task 4: `src/markdown.ts` — `escapeHtml`, `escapeAttr`, `inlineToHtml`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/markdown.ts`
- Test: `tests/markdown.test.ts` (this task adds the `describe("inline")` block; Phase 3b appends block/chunk tests to the same file)

**Step 1: Write the failing test `tests/markdown.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAttr, escapeHtml, inlineToHtml } from "../src/markdown.ts";

describe("escape", () => {
  test("escapeHtml: & < >", () => {
    assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  });
  test("escapeAttr: also quotes", () => {
    assert.equal(escapeAttr('a"b&c'), "a&quot;b&amp;c");
  });
});

describe("inline", () => {
  test("code span: content verbatim + escaped, no formatting inside", () => {
    assert.equal(inlineToHtml("`a<b> & **x**`"), `<code>a&lt;b&gt; &amp; **x**</code>`);
  });
  test("bold ** and __", () => {
    assert.equal(inlineToHtml("**hi**"), "<b>hi</b>");
    assert.equal(inlineToHtml("__hi__"), "<b>hi</b>");
  });
  test("italic * and _", () => {
    assert.equal(inlineToHtml("*hi*"), "<i>hi</i>");
    assert.equal(inlineToHtml("_hi_"), "<i>hi</i>");
  });
  test("strikethrough ~~", () => {
    assert.equal(inlineToHtml("~~old~~"), "<s>old</s>");
  });
  test("link: url attr-escaped, text parsed recursively", () => {
    assert.equal(inlineToHtml("[t](http://x/?a=1&b=2)"), `<a href="http://x/?a=1&amp;b=2">t</a>`);
    assert.equal(inlineToHtml("[**b**](u)"), `<a href="u"><b>b</b></a>`);
  });
  test("nested emphasis, both directions", () => {
    assert.equal(inlineToHtml("**bold *ital* bold**"), "<b>bold <i>ital</i> bold</b>");
    assert.equal(inlineToHtml("*ital **bold** ital*"), "<i>ital <b>bold</b> ital</i>");
  });
  test("intraword underscores stay literal (identifiers)", () => {
    assert.equal(inlineToHtml("snake_case_name"), "snake_case_name");
    assert.equal(inlineToHtml("foo__bar__"), "foo__bar__");
  });
  test("unmatched markers stay literal; tags always balanced", () => {
    assert.equal(inlineToHtml("*unterminated"), "*unterminated");
    assert.equal(inlineToHtml("**no close"), "**no close");
    const samples = ["a * b ** c ` d", "**bold *x", "100% * 2 ~ 3 _ v1.2_", "[broken](", "`unclosed"];
    for (const s of samples) {
      const out = inlineToHtml(s);
      for (const [open, close] of [
        [/<b>/g, "</b>"],
        [/<i>/g, "</i>"],
        [/<s>/g, "</s>"],
        [/<code>/g, "</code>"],
      ]) {
        assert.equal((out.match(open) ?? []).length, (out.match(new RegExp(close, "g")) ?? []).length,
          `unbalanced in ${JSON.stringify(out)} from ${JSON.stringify(s)}`);
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/markdown.test.ts`
Expected: FAIL — cannot find module `../src/markdown.ts`.

**Step 3: Write the implementation `src/markdown.ts`**

```ts
/** Escape HTML text content (not attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

const WORD = /[A-Za-z0-9]/;

/**
 * Convert ONE line of markdown to Telegram HTML.
 * Supports: `code`, [t](url), **bold**, __bold__, *italic*, _italic_, ~~strike~~.
 * Guarantees balanced tags: unmatched markers remain literal (never an unclosed tag).
 * Documented v1 limits: no triple emphasis (`***x***`), no parens in URLs,
 * a `*` pair with text between renders as italic even if the intent was a bullet.
 */
export function inlineToHtml(src: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  // 1) code spans — content verbatim (escaped), no formatting parsed inside
  let s = src.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  // 2) links — URL untouched by later passes; text fully parsed (recursive)
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, text: string, url: string) =>
    keep(`<a href="${escapeAttr(url)}">${inlineToHtml(text)}</a>`),
  );

  // 3) escape the rest
  s = escapeHtml(s);

  // 4) emphasis — bold before italic (bold content admits single stars)
  s = s.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__((?:[^_]|\_(?!_))+?)__/g, "<b>$1</b>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");

  // 5) restore stashed code spans / links
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)]);
}
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/markdown.test.ts`
Expected: `pass 10 / fail 0`. Then `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat: markdown escape + inline converter (balanced tags guaranteed)"
```

---

## Phase 3b — Markdown: fences, chunking, plain fallback

### Task 5: `markdownToHtml` — block-level rendering

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/markdown.ts`
- Test: `tests/markdown.test.ts` (append `describe("blocks")`)

**Block rules (v1 subset, documented in code):** fence → `<pre>` (escaped, `\n` preserved; an **unclosed** fence — normal mid-stream — renders as `<pre>` to EOF); `#…######` → bold (trailing `#`s stripped); `-`/`*`/`+` bullets → `• `, ordered `1.` kept; `>` → `❝ `; `---`/`***`/`___`/`- - -` → `────────`; blank lines dropped; every source line becomes one output line (no paragraph collapsing — safer for streaming).

**Step 1: Append the failing tests** (to `tests/markdown.test.ts`)

```ts
describe("blocks", () => {
  test("fence → <pre>, content escaped, newlines kept", () => {
    assert.equal(markdownToHtml("```js\nconst a = 1 < 2;\n```"), "<pre>const a = 1 &lt; 2;</pre>");
  });
  test("unclosed fence (streaming) renders to EOF", () => {
    assert.equal(markdownToHtml("```\npartial ="), "<pre>partial =</pre>");
  });
  test("tilde fences work; fence longer than 3 closes", () => {
    assert.equal(markdownToHtml("~~~\nx\n~~~"), "<pre>x</pre>");
    assert.equal(markdownToHtml("````\n```inner```\n````"), "<pre>```inner```</pre>");
  });
  test("headings → bold", () => {
    assert.equal(markdownToHtml("# Title"), "<b>Title</b>");
    assert.equal(markdownToHtml("## Sub #"), "<b>Sub</b>");
  });
  test("lists, quote, hr", () => {
    assert.equal(markdownToHtml("- one\n* two\n1. num"), "• one\n• two\n1. num");
    assert.equal(markdownToHtml("> quoted"), "❝ quoted");
    assert.equal(markdownToHtml("---"), "────────");
    assert.equal(markdownToHtml("- - -"), "────────");
  });
  test("combined document", () => {
    const md = "## Plan\n\n- do `x`\n\n```\na < b\n```\n\n**done**";
    assert.equal(markdownToHtml(md), "<b>Plan</b>\n• do <code>x</code>\n<pre>a &lt; b</pre>\n<b>done</b>");
  });
});
```

(Add `markdownToHtml` to the import from `../src/markdown.ts` at the top of the test file.)

**Step 2: Run to verify failure**

Run: `node --test tests/markdown.test.ts`
Expected: FAIL — `markdownToHtml is not exported` / undefined.

**Step 3: Implement in `src/markdown.ts`** (append below `inlineToHtml`)

```ts
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const HR_RE = /^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d{1,9})\.\s+(.*)$/;
const BQ_RE = /^\s*>\s?(.*)$/;
const HR_LINE = "────────";

function fenceCloseRe(open: string): RegExp {
  const ch = open[0] === "`" ? "`" : "~";
  return new RegExp("^\\s*" + ch + "{" + open.length + ",}\\s*$");
}

interface Unit {
  html: string;
}

/** Parse markdown into render units; a whole code fence is ONE unit (never split later). */
export function toUnits(md: string): Unit[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const buf: string[] = [];
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence (EOF = still streaming)
      units.push({ html: `<pre>${escapeHtml(buf.join("\n"))}</pre>` });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const h = HEADING_RE.exec(line);
    const hr = HR_RE.exec(line);
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    const bq = BQ_RE.exec(line);
    let html: string;
    if (h) html = `<b>${inlineToHtml(h[1].replace(/\s+#+\s*$/, ""))}</b>`;
    else if (hr) html = HR_LINE;
    else if (ul) html = `• ${inlineToHtml(ul[1])}`;
    else if (ol) html = `${ol[1]}. ${inlineToHtml(ol[2])}`;
    else if (bq) html = `❝ ${inlineToHtml(bq[1])}`;
    else html = inlineToHtml(line);
    units.push({ html });
    i++;
  }
  return units;
}

/** Full document → one HTML string (for single-message sends and tests). */
export function markdownToHtml(md: string): string {
  return toUnits(md).map((u) => u.html).join("\n");
}
```

**Step 4: Run to verify pass**

Run: `node --test tests/markdown.test.ts` → all pass; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat: markdown block rendering (fences as atomic units, headings, lists)"
```

### Task 6: `chunkMarkdown`, `chunkText`, `toPlainText`

**TDD scenario:** New feature — full TDD cycle.

**Contract:** `chunkMarkdown(md, maxLen=4096) → string[]`. Every chunk ≤ maxLen. Chunk 1 has no prefix; chunks ≥ 2 start with `(continued)\n` (marker budget is subtracted from their capacity). Code fences are atomic: a fence that fits in one chunk is never split; a fence larger than a chunk is re-wrapped as multiple valid `<pre>` blocks split at code-line boundaries (a single code line longer than the limit is hard-cut — documented last resort). `chunkText(plain, maxLen)` does the same for plain text (line boundaries). `toPlainText(md)` strips all markdown syntax (the 400-fallback renderer).

**Files:**
- Modify: `src/markdown.ts`
- Test: `tests/markdown.test.ts` (append `describe("chunking")`)

**Step 1: Append the failing tests**

```ts
describe("chunking", () => {
  const MARKER = "(continued)\n";

  test("small doc → one chunk, no marker", () => {
    assert.deepEqual(chunkMarkdown("hello world"), ["hello world"]);
  });

  test("split: marker on 2nd chunk only, all chunks ≤ maxLen", () => {
    const a = "x".repeat(4000);
    const b = "y".repeat(900);
    const chunks = chunkMarkdown(a + "\n" + b, 4096);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], a);
    assert.ok(chunks[1].startsWith(MARKER));
    assert.equal(chunks[1].slice(MARKER.length), b);
    for (const c of chunks) assert.ok(c.length <= 4096);
  });

  test("code fence stays whole; trailing text moves to next chunk", () => {
    const code = Array.from({ length: 240 }, () => "line").join("\n"); // 1439 chars
    const md = "```\n" + code + "```\ntrailing";
    const chunks = chunkMarkdown(md, 1230);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith("<pre>") && chunks[0].endsWith("</pre>"));
    assert.ok(chunks[1].startsWith(MARKER));
    assert.equal(chunks[1].slice(MARKER.length), "trailing");
    for (const c of chunks) assert.ok(c.length <= 1230);
  });

  test("oversized fence re-wrapped as multiple valid <pre> blocks, content preserved", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `l${i}x`);
    const md = "```\n" + codeLines.join("\n") + "```";
    const chunks = chunkMarkdown(md, 1500);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      const body = c.startsWith(MARKER) ? c.slice(MARKER.length) : c;
      assert.ok(body.startsWith("<pre>") && body.endsWith("</pre>"), body.slice(0, 40));
    }
    const reconstructed = chunks
      .map((c) => (c.startsWith(MARKER) ? c.slice(MARKER.length) : c))
      .map((c) => c.slice(5, -6)) // strip <pre> / </pre>
      .join("\n");
    assert.equal(reconstructed, codeLines.join("\n"));
  });

  test("empty doc → no chunks", () => {
    assert.deepEqual(chunkMarkdown(""), []);
    assert.deepEqual(chunkMarkdown("  \n\n"), []);
  });

  test("chunkText: line-boundary split, reconstructable", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ` + "x".repeat(100));
    const text = lines.join("\n");
    const chunks = chunkText(text, 300);
    for (const c of chunks) assert.ok(c.length <= 300);
    const joined = chunks.map((c, i) => (i ? c.slice(MARKER.length) : c)).join("\n");
    assert.equal(joined, text);
  });
});

describe("toPlainText", () => {
  test("strips markers, keeps content", () => {
    const md = "# Title\n\n- `x` item\n- two\n1. num\n\n**bold** and [t](http://u) ~~gone~~\n\n---\n\n> quote";
    assert.equal(
      toPlainText(md),
      ["Title", "", "• x item", "• two", "1. num", "", "bold and t (http://u) gone", "", "────────", "", "quote"].join("\n"),
    );
  });
  test("fence content kept verbatim (no HTML)", () => {
    assert.equal(toPlainText("```\n<a & b>\n```"), "<a & b>");
  });
});
```

(Extend the import with `chunkMarkdown, chunkText, toPlainText`.)

**Step 2: Run to verify failure** — `node --test tests/markdown.test.ts` → FAIL (not exported).

**Step 3: Implement** (append to `src/markdown.ts`)

```ts
export const TG_MAX_LEN = 4096;
const MARKER = "(continued)\n";

function hardCut(text: string, cap: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    out.push(rest.slice(0, cap));
    rest = rest.slice(cap);
  }
  if (rest !== "") out.push(rest);
  return out;
}

/** Split one over-limit unit: <pre> blocks re-wrap at code-line boundaries; anything else hard-cuts. */
function hardSplitUnit(html: string, maxLen: number): string[] {
  const cap = maxLen - MARKER.length;
  const m = /^<pre>([\s\S]*)<\/pre>$/.exec(html);
  if (!m) return hardCut(html, cap);
  const lineCap = cap - "<pre>".length - "</pre>".length;
  const codeLines = m[1].split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (buf.length > 0) {
      out.push(`<pre>${buf.join("\n")}</pre>`);
      buf = [];
      len = 0;
    }
  };
  for (const cl of codeLines) {
    if (cl.length > lineCap) {
      // single code line over the limit: hard-cut (documented last resort)
      flush();
      for (const piece of hardCut(cl, lineCap)) out.push(`<pre>${piece}</pre>`);
      continue;
    }
    const add = (buf.length > 0 ? 1 : 0) + cl.length;
    if (len + add <= lineCap) {
      buf.push(cl);
      len += add;
    } else {
      flush();
      buf.push(cl);
      len = cl.length;
    }
  }
  flush();
  return out;
}

/** Pack rendered units into chunks ≤ maxLen; chunks ≥ 2 get the continuation marker. */
export function chunkMarkdown(md: string, maxLen = TG_MAX_LEN): string[] {
  const raw: string[] = [];
  let cur = "";
  const push = () => {
    if (cur !== "") {
      raw.push(cur);
      cur = "";
    }
  };
  for (const u of toUnits(md)) {
    const piece = u.html;
    if (piece.length > maxLen - MARKER.length) {
      push();
      raw.push(...hardSplitUnit(piece, maxLen));
      continue;
    }
    const cap = raw.length === 0 ? maxLen : maxLen - MARKER.length;
    const sep = cur === "" ? 0 : 1;
    if (cur.length + sep + piece.length <= cap) {
      cur = cur === "" ? piece : cur + "\n" + piece;
    } else {
      push();
      cur = piece;
    }
  }
  push();
  return raw.map((r, idx) => (idx === 0 ? r : MARKER + r));
}

/** Same line-boundary packing for plain (fallback) text. */
export function chunkText(plain: string, maxLen = TG_MAX_LEN): string[] {
  const raw: string[] = [];
  let cur = "";
  const push = () => {
    if (cur !== "") {
      raw.push(cur);
      cur = "";
    }
  };
  for (const line of plain.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") continue;
    if (line.length > maxLen - MARKER.length) {
      push();
      raw.push(...hardCut(line, maxLen - MARKER.length));
      continue;
    }
    const cap = raw.length === 0 ? maxLen : maxLen - MARKER.length;
    const sep = cur === "" ? 0 : 1;
    if (cur.length + sep + line.length <= cap) {
      cur = cur === "" ? line : cur + "\n" + line;
    } else {
      push();
      cur = line;
    }
  }
  push();
  return raw.map((r, idx) => (idx === 0 ? r : MARKER + r));
}

function stripInline(s: string): string {
  return s
    .replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, "$1 ($2)")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+__)__|__([^_]+)__/g, (_m, _a, b) => (b ?? _m))
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1$2");
}

/** Strip all markdown syntax → plain text (used when Telegram rejects the HTML). */
export function toPlainText(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      continue;
    }
    if (line.trim() === "") { out.push(""); i++; continue; }
    const h = HEADING_RE.exec(line);
    const hr = HR_RE.exec(line);
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    const bq = BQ_RE.exec(line);
    if (h) out.push(stripInline(h[1].replace(/\s+#+\s*$/, "")));
    else if (hr) out.push(HR_LINE);
    else if (ul) out.push("• " + stripInline(ul[1]));
    else if (ol) out.push(`${ol[1]}. ` + stripInline(ol[2]));
    else if (bq) out.push(stripInline(bq[1]));
    else out.push(stripInline(line));
    i++;
  }
  return out.join("\n");
}
```

**Step 4: Run to verify pass** — `node --test tests/markdown.test.ts` → all pass; `npx tsc --noEmit` → clean. If the `__`-strip regex misbehaves, simplify it to `/__([^_]+)__/g → "$1"` (intraword `__` then stays literal — acceptable for a fallback).

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat: telegram chunking (fence-atomic, continuation markers) + plain-text fallback"
```

**Checkpoint E:** `npx tsc --noEmit && node --test` → all green before Phase 4.

---

## Phase 4 — Telegram Bot API client

Design §1 (no webhooks, long polling, one client). The client owns HTTP concerns: URL building, JSON, `ok:false` → `TgError`, 429 retry-after, network errors, and the poll loop. Everything above the wire is driven by the client from `index.ts`.

**Task 7 adds `tests/fake-fetch.ts`** — the scripted fetch stand-in used by every client test (and later the integration test).

### Task 7: `call` core + error model + fake fetch

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `tests/fake-fetch.ts`
- Create: `src/telegram-client.ts`
- Test: `tests/telegram-client.test.ts`

**Step 1: Write `tests/fake-fetch.ts`**

```ts
import type { FetchLike } from "../src/telegram-client.ts";

export interface CapturedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

export interface ScriptedResponse {
  status: number;
  body: unknown;
}

type Handler = (url: string, init?: CapturedCall["init"]) => ScriptedResponse | never;

/**
 * Scripted fetch stand-in. Responses come from `queue` (FIFO) first, then `handler`.
 * Every call is recorded in `calls` for assertions.
 */
export function makeFakeFetch(handler?: Handler): {
  fetchImpl: FetchLike;
  calls: CapturedCall[];
  queue: ScriptedResponse[];
  setHandler(h: Handler): void;
} {
  const calls: CapturedCall[] = [];
  const queue: ScriptedResponse[] = [];
  let h = handler;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    let r = queue.shift();
    if (!r && h) r = h(url, init);
    if (!r) throw new Error(`fake-fetch: no response scripted for ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  };
  return { fetchImpl, calls, queue, setHandler: (x) => (h = x) };
}
```

**Step 2: Write the failing test `tests/telegram-client.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, TgError, TgNetworkError } from "../src/telegram-client.ts";
import { makeFakeFetch } from "./fake-fetch.ts";

test("call: ok:true → result, correct URL + JSON body", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { hello: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.deepEqual(await c.call("anyMethod", { a: 1 }), { hello: 1 });
  assert.equal(ff.calls[0].url, "https://api.telegram.org/botT/anyMethod");
  assert.equal(ff.calls[0].init?.method, "POST");
  assert.equal(ff.calls[0].init?.body, JSON.stringify({ a: 1 }));
});

test("call: ok:false → TgError(method, code, description)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "chat not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(
    c.call("sendMessage"),
    (e: unknown) => e instanceof TgError && e.code === 400 && e.description === "chat not found" && e.method === "sendMessage",
  );
});

test("call: 429 → sleep(retry_after) then retry", async () => {
  const sleeps: number[] = [];
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: "ok-now" } }));
  ff.queue.push({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } });
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(await c.call("getUpdates"), "ok-now");
  assert.deepEqual(sleeps, [7000]);
  assert.equal(ff.calls.length, 2);
});

test("call: 429 exhausted (3 retries) → throws TgError(429)", async () => {
  const ff = makeFakeFetch(() => ({ status: 429, body: { ok: false, error_code: 429, description: "slow down", parameters: { retry_after: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  await assert.rejects(c.call("getUpdates"), (e: unknown) => e instanceof TgError && e.code === 429);
  assert.equal(ff.calls.length, 4);
});

test("call: network failure → TgNetworkError", async () => {
  const ff = makeFakeFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.call("getMe"), TgNetworkError);
});
```

**Step 3: Run to verify failure** — `node --test tests/telegram-client.test.ts` → FAIL (module not found).

**Step 4: Write `src/telegram-client.ts`** (core only; methods added in Task 8, poll loop in Task 9)

```ts
/** Structural fetch — the real global `fetch` satisfies it; tests inject a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TgError extends Error {
  method: string;
  code: number;
  description: string;
  retryAfter?: number;
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`${method}: ${code} ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

export class TgNetworkError extends Error {
  method: string;
  constructor(method: string, cause: unknown) {
    super(`network error calling ${method}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.method = method;
    this.cause = cause;
  }
}

export interface ClientOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_429_RETRIES = 3;

export class TelegramClient {
  token: string;
  private fetchImpl: FetchLike;
  private sleep: (ms: number) => Promise<void>;

  constructor(token: string, opts: ClientOptions = {}) {
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One Bot API call: JSON POST, ok:false → TgError, 429 → sleep retry_after & retry (max 3). */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
      } catch (err) {
        throw new TgNetworkError(method, err);
      }
      let data: {
        ok: boolean;
        result?: unknown;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new TgNetworkError(method, new Error(`non-JSON response (HTTP ${res.status})`));
      }
      if (data.ok) return data.result;
      const code = data.error_code ?? 0;
      if (code === 429 && attempt < MAX_429_RETRIES) {
        attempt++;
        await this.sleep((data.parameters?.retry_after ?? 3) * 1000);
        continue;
      }
      throw new TgError(method, code, data.description ?? "unknown error", data.parameters?.retry_after);
    }
  }
}
```

**Step 5: Run to verify pass** — `node --test tests/telegram-client.test.ts` → `pass 5 / fail 0`; `npx tsc --noEmit` → clean.

**Step 6: Commit**

```bash
git add tests/fake-fetch.ts src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat: telegram client core (call, error model, 429 retry) + fake fetch"
```

### Task 8: Message methods

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/telegram-client.ts`
- Test: `tests/telegram-client.test.ts` (append)

**Step 1: Append failing tests**

```ts
test("sendMessage: HTML request with reply", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 5, chat: { id: 1, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  const msg = await c.sendMessage(1, "**hi**", { parseMode: "HTML", replyToId: 4 });
  assert.equal(msg.message_id, 5);
  const body = JSON.parse(ff.calls[0].init?.body ?? "{}");
  assert.deepEqual(body, { chat_id: 1, text: "**hi**", parse_mode: "HTML", reply_to_message: { message_id: 4 } });
});

test("sendMessage: parseMode null → no parse_mode key (plain fallback)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 6, chat: { id: 1, type: "plain" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.sendMessage(1, "<raw>", { parseMode: null });
  const body = JSON.parse(ff.calls[0].init?.body ?? "{}");
  assert.equal("parse_mode" in body, false);
  assert.equal(body.text, "<raw>");
});

test("editMessageText: ok → true; 'Message is not modified' → false (no throw)", async () => {
  const ok = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c1 = new TelegramClient("T", { fetchImpl: ok.fetchImpl });
  assert.equal(await c1.editMessageText(1, 2, "x"), true);
  const nm = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Message is not modified" } }));
  const c2 = new TelegramClient("T", { fetchImpl: nm.fetchImpl });
  assert.equal(await c2.editMessageText(1, 2, "same"), false);
});

test("editMessageText: real error → throws TgError", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "message to edit not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.editMessageText(1, 999, "x"), TgError);
});

test("deleteMessage: 'Message to delete not found' → resolves (idempotent)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Message to delete not found" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.deleteMessage(1, 999); // must not throw
});

test("deleteMessage: real error → throws", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too old" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.deleteMessage(1, 1), TgError);
});

test("answerCallbackQuery: sends callback_query_id (+ optional text)", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.answerCallbackQuery("cb-1", "ok");
  const body = JSON.parse(ff.calls[0].init?.body ?? "{}");
  assert.deepEqual(body, { callback_query_id: "cb-1", text: "ok" });
});
```

**Step 2: Run to verify failure** — `node --test tests/telegram-client.test.ts` → FAIL (methods undefined).

**Step 3: Implement — types + methods** (append to `src/telegram-client.ts`)

```ts
export interface TgChat {
  id: number;
  type: string; // "private" | "group" | "supergroup" | "channel"
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

export interface TgFrom {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgFrom;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgFrom;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgBotMe {
  id: number;
  is_bot: true;
  first_name: string;
  username?: string;
}

export interface TgSentMessage {
  message_id: number;
  chat: TgChat;
  date: number;
  text?: string;
}
```

And methods on `TelegramClient` (before the closing brace):

```ts
  getMe(): Promise<TgBotMe> {
    return this.call("getMe") as Promise<TgBotMe>;
  }

  sendMessage(
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown },
  ): Promise<TgSentMessage> {
    const p: Record<string, unknown> = { chat_id: chatId, text };
    if (opts?.parseMode) p.parse_mode = opts.parseMode;
    if (opts?.replyToId) p.reply_to_message = { message_id: opts.replyToId };
    if (opts?.replyMarkup) p.reply_markup = opts.replyMarkup;
    return this.call("sendMessage", p) as Promise<TgSentMessage>;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown },
  ): Promise<boolean> {
    try {
      const p: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
      if (opts?.parseMode) p.parse_mode = opts.parseMode;
      if (opts?.replyMarkup) p.reply_markup = opts.replyMarkup;
      await this.call("editMessageText", p);
      return true;
    } catch (err) {
      if (err instanceof TgError && err.code === 400 && /not modified/i.test(err.description)) return false;
      throw err;
    }
  }

  /** Idempotent: "Message to delete not found" (already deleted / too old) resolves. */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch (err) {
      if (err instanceof TgError && err.code === 400 && /not found/i.test(err.description)) return;
      throw err;
    }
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
    const p: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) p.text = text;
    return this.call("answerCallbackQuery", p);
  }
```

**Step 4: Run to verify pass** — `node --test tests/telegram-client.test.ts` → all pass; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat: telegram message methods (send/edit/delete/answer, idempotent delete)"
```

### Task 9: `getUpdates` + poll loop

**TDD scenario:** New feature — full TDD cycle.

**Contract:** `pollLoop(deps)` runs `getUpdates(offset, 50s)` in a loop. On a non-empty batch: `onUpdates(batch)` then `setOffset(last.update_id + 1)` (offset persisted by the caller — it must survive process restarts and instance swaps, hence it lives in the config, not in the loop). On error: `onError(err)`, exponential backoff 1s → 2s → … → 30s cap (reset on success); `TgError` with code 409 (token polled elsewhere) → stop immediately. `shouldStop()` checked at every loop iteration. If `onUpdates` throws, the offset is NOT advanced → the batch is redelivered (bridge must be idempotent).

**Files:**
- Modify: `src/telegram-client.ts`
- Test: `tests/telegram-client.test.ts` (append)

**Step 1: Append failing tests**

```ts
test("getUpdates: offset, timeout, allowed_updates", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: [] } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await c.getUpdates(42, 30);
  const body = JSON.parse(ff.calls[0].init?.body ?? "{}");
  assert.deepEqual(body, { offset: 42, timeout: 30, allowed_updates: ["message", "callback_query", "edited_message"] });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("pollLoop: delivers batches, advances offset, stops on flag", async () => {
  const delivered: number[][] = [];
  let offset = 0;
  let stop = false;
  const ff = makeFakeFetch();
  ff.queue.push(
    { status: 200, body: { ok: true, result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, date: 1 } },
      { update_id: 2, message: { message_id: 2, chat: { id: 7, type: "private" }, date: 2 } },
    ] } },
    { status: 200, body: { ok: true, result: [] } },
  );
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (n) => (offset = n),
    onUpdates: async (u) => delivered.push(u.map((x) => x.update_id)),
    onError: () => {},
    shouldStop: () => stop,
    sleep: async () => {},
  });
  await waitFor(() => delivered.length === 1);
  stop = true;
  await p;
  assert.deepEqual(delivered, [[1, 2]]);
  assert.equal(offset, 3);
});

test("pollLoop: network error → backoff(1s) then retry succeeds", async () => {
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const ff = makeFakeFetch();
  ff.queue.push({ status: 200, body: { ok: true, result: [{ update_id: 9, message: { message_id: 9, chat: { id: 7, type: "private" }, date: 9 } }] } });
  // first call: simulate network failure via a throwing handler, then queued success
  const ff2 = makeFakeFetch(() => {
    throw new Error("boom");
  });
  ff2.queue.push({ status: 200, body: { ok: true, result: [{ update_id: 9, message: { message_id: 9, chat: { id: 7, type: "private" }, date: 9 } }] } });
  let offset = 0;
  let stop = false;
  const delivered: number[][] = [];
  const client = new TelegramClient("T", { fetchImpl: ff2.fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  const p = pollLoop({
    client,
    getOffset: () => offset,
    setOffset: (n) => (offset = n),
    onUpdates: async (u) => delivered.push(u.map((x) => x.update_id)),
    onError: (e) => errors.push(e),
    shouldStop: () => stop,
    sleep: async (ms) => sleeps.push(ms),
  });
  await waitFor(() => delivered.length === 1);
  stop = true;
  await p;
  assert.deepEqual(delivered, [[9]]);
  assert.equal(offset, 10);
  assert.equal(errors.length, 1);
  assert.ok(sleeps.includes(1000));
});

test("pollLoop: 409 conflict → reports and stops (no retry)", async () => {
  const ff = makeFakeFetch(() => ({ status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }));
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  const errors: unknown[] = [];
  const p = pollLoop({
    client,
    getOffset: () => 0,
    setOffset: () => {},
    onUpdates: async () => {},
    onError: (e) => errors.push(e),
    shouldStop: () => false,
    sleep: async () => {},
  });
  await p;
  assert.equal(ff.calls.length, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof TgError && (errors[0] as TgError).code === 409);
});

test("pollLoop: already stopping → returns without any call", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: [] } }));
  const client = new TelegramClient("T", { fetchImpl: ff.fetchImpl, sleep: async () => {} });
  await pollLoop({
    client,
    getOffset: () => 0,
    setOffset: () => {},
    onUpdates: async () => {},
    onError: () => {},
    shouldStop: () => true,
    sleep: async () => {},
  });
  assert.equal(ff.calls.length, 0);
});
```

**Step 2: Run to verify failure** — `node --test tests/telegram-client.test.ts` → FAIL (`getUpdates`/`pollLoop` undefined).

**Step 3: Implement** (append to `src/telegram-client.ts`)

```ts
  getUpdates(offset: number, timeoutSec = 50): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query", "edited_message"] }) as Promise<TgUpdate[]>;
  }
```

And at module level (after the class):

```ts
export interface PollerDeps {
  client: TelegramClient;
  getOffset(): number;
  setOffset(n: number): void;
  onUpdates(updates: TgUpdate[]): Promise<void>;
  onError(err: unknown): void;
  shouldStop(): boolean;
  sleep(ms: number): Promise<void>;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export async function pollLoop(deps: PollerDeps): Promise<void> {
  let backoff = BACKOFF_START_MS;
  for (;;) {
    if (deps.shouldStop()) return;
    try {
      const updates = await deps.client.getUpdates(deps.getOffset(), 50);
      if (updates.length > 0) {
        await deps.onUpdates(updates);
        deps.setOffset(updates[updates.length - 1].update_id + 1);
      }
      backoff = BACKOFF_START_MS;
    } catch (err) {
      if (deps.shouldStop()) return;
      deps.onError(err);
      if (err instanceof TgError && err.code === 409) return; // another poller owns the token
      await deps.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}
```

**Step 4: Run to verify pass** — `node --test tests/telegram-client.test.ts` → all pass; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat: getUpdates + resilient poll loop (offset, backoff, 409 stop)"
```

**Checkpoint F:** `npx tsc --noEmit && node --test` → all green before Phase 5.

---

## Phase 5 — Router

Pure function `route(update, ownerId) → TgAction` (design §4, §9). Owns: pairing/allowlist gate, command parsing (incl. `@BotName` suffixes), and the compact **callback-data** vocabulary — all ≤ 64 bytes, indexing into cached lists (never paths):

| `callback_data` | Meaning |
|---|---|
| `stop` | ⏹ Stop (working-message button, Esc-equivalent) |
| `s:<i>` | activate session at index `i` of the cached `/sessions` list |
| `so:<i>` | busy → "OK, switch when idle" for session `i` |
| `m:<i>` / `t:<i>` | set model / thinking level at list index `i` |
| `k:1` / `k:0` | kill (shutdown) yes / no |
| `c:1` / `c:0` | clear chat history yes / no (post-`/new` / post-switch) |

### Task 10: `src/router.ts`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

**Step 1: Write the failing test `tests/router.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, CB } from "../src/router.ts";
import type { TgUpdate } from "../src/telegram-client.ts";

const chat = { id: 7, type: "private" };
const from = (id: number, bot = false) => ({ id, is_bot: bot });
const msgUpdate = (updateId: number, id: number, text: string, bot = false): TgUpdate => ({
  update_id: updateId,
  message: { message_id: 1, date: 1, chat, from: from(id, bot), text },
});
const cbUpdate = (updateId: number, id: number, data: string): TgUpdate => ({
  update_id: updateId,
  callback_query: { id: "cb" + updateId, from: from(id), message: { message_id: 1, date: 1, chat }, data },
});

test("ignore: no message, non-text, bot messages", () => {
  assert.deepEqual(route({ update_id: 1 }, 5), { kind: "ignore" });
  assert.deepEqual(route({ update_id: 2, edited_message: { message_id: 9, date: 1, chat, from: from(5), text: "x" } }, 5), { kind: "ignore" });
  assert.deepEqual(route(msgUpdate(3, 5, "hello", true), 5), { kind: "ignore" });
});

test("unpaired: /start → pair, anything else → notAuthorized", () => {
  assert.deepEqual(route(msgUpdate(1, 42, "/start"), undefined), { kind: "pair", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(2, 42, "/start@MyBot"), undefined), { kind: "pair", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(3, 42, "hi"), undefined), { kind: "notAuthorized", chatId: 7, fromId: 42 });
  assert.deepEqual(route(msgUpdate(4, 42, "/new"), undefined), { kind: "notAuthorized", chatId: 7, fromId: 42 });
});

test("paired: non-owner rejected; owner commands map", () => {
  assert.deepEqual(route(msgUpdate(1, 99, "/status"), 5), { kind: "notAuthorized", chatId: 7, fromId: 99 });
  const owner = 5;
  assert.deepEqual(route(msgUpdate(1, owner, "/start"), owner), { kind: "start", chatId: 7 });
  assert.deepEqual(route(msgUpdate(2, owner, "/help"), owner), { kind: "help", chatId: 7 });
  assert.deepEqual(route(msgUpdate(3, owner, "/new"), owner), { kind: "new", chatId: 7 });
  assert.deepEqual(route(msgUpdate(4, owner, "/sessions"), owner), { kind: "sessions", chatId: 7 });
  assert.deepEqual(route(msgUpdate(5, owner, "/models"), owner), { kind: "modelList", chatId: 7 });
  assert.deepEqual(route(msgUpdate(6, owner, "/thinking"), owner), { kind: "thinkingList", chatId: 7 });
  assert.deepEqual(route(msgUpdate(7, owner, "/status"), owner), { kind: "status", chatId: 7 });
  assert.deepEqual(route(msgUpdate(8, owner, "/stop"), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(msgUpdate(9, owner, "/stop@MyBot"), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(msgUpdate(10, owner, "/compact"), owner), { kind: "compact", chatId: 7 });
  assert.deepEqual(route(msgUpdate(11, owner, "/name My Project"), owner), { kind: "nameSet", chatId: 7, name: "My Project" });
  assert.deepEqual(route(msgUpdate(12, owner, "/kill"), owner), { kind: "killAsk", chatId: 7 });
  assert.deepEqual(route(msgUpdate(13, owner, "/bogus"), owner), { kind: "unknown", chatId: 7, text: "/bogus" });
  assert.deepEqual(route(msgUpdate(14, owner, "just some prompt text"), owner), { kind: "prompt", chatId: 7, text: "just some prompt text" });
});

test("callbacks: owner only, vocabulary maps, stale → ignore", () => {
  const owner = 5;
  assert.deepEqual(route(cbUpdate(1, 99, "stop"), owner), { kind: "notAuthorized", chatId: 7, fromId: 99 });
  assert.deepEqual(route(cbUpdate(1, owner, CB.STOP), owner), { kind: "stop", chatId: 7 });
  assert.deepEqual(route(cbUpdate(2, owner, CB.session(3)), owner), { kind: "sessionActivate", chatId: 7, index: 3 });
  assert.deepEqual(route(cbUpdate(3, owner, CB.sessionOk(2)), owner), { kind: "switchOk", chatId: 7, index: 2 });
  assert.deepEqual(route(cbUpdate(4, owner, CB.model(0)), owner), { kind: "modelSet", chatId: 7, index: 0 });
  assert.deepEqual(route(cbUpdate(5, owner, CB.thinking(1)), owner), { kind: "thinkingSet", chatId: 7, index: 1 });
  assert.deepEqual(route(cbUpdate(6, owner, CB.kill(true)), owner), { kind: "kill", chatId: 7, yes: true });
  assert.deepEqual(route(cbUpdate(7, owner, CB.kill(false)), owner), { kind: "kill", chatId: 7, yes: false });
  assert.deepEqual(route(cbUpdate(8, owner, CB.clear(true)), owner), { kind: "clear", chatId: 7, doIt: true });
  assert.deepEqual(route(cbUpdate(9, owner, CB.clear(false)), owner), { kind: "clear", chatId: 7, doIt: false });
  assert.deepEqual(route(cbUpdate(10, owner, "garbage"), owner), { kind: "ignore" });
  assert.deepEqual(route(cbUpdate(11, owner, "s:999999"), owner), { kind: "sessionActivate", chatId: 7, index: 999999 });
});
```

**Step 2: Run to verify failure** — `node --test tests/router.test.ts` → FAIL (module not found).

**Step 3: Write `src/router.ts`**

```ts
import type { TgUpdate } from "./telegram-client.ts";

/** Compact callback_data builders — every value ≤ 64 bytes (Telegram limit). */
export const CB = {
  STOP: "stop",
  session: (i: number) => `s:${i}`,
  sessionOk: (i: number) => `so:${i}`,
  model: (i: number) => `m:${i}`,
  thinking: (i: number) => `t:${i}`,
  kill: (yes: boolean) => (yes ? "k:1" : "k:0"),
  clear: (doIt: boolean) => (doIt ? "c:1" : "c:0"),
} as const;

export type TgAction =
  | { kind: "ignore" }
  | { kind: "notAuthorized"; chatId: number; fromId: number }
  | { kind: "pair"; chatId: number; fromId: number }
  | { kind: "start"; chatId: number }
  | { kind: "help"; chatId: number }
  | { kind: "new"; chatId: number }
  | { kind: "sessions"; chatId: number }
  | { kind: "sessionActivate"; chatId: number; index: number }
  | { kind: "switchOk"; chatId: number; index: number }
  | { kind: "modelList"; chatId: number }
  | { kind: "modelSet"; chatId: number; index: number }
  | { kind: "thinkingList"; chatId: number }
  | { kind: "thinkingSet"; chatId: number; index: number }
  | { kind: "status"; chatId: number }
  | { kind: "stop"; chatId: number }
  | { kind: "compact"; chatId: number }
  | { kind: "nameSet"; chatId: number; name: string }
  | { kind: "killAsk"; chatId: number }
  | { kind: "kill"; chatId: number; yes: boolean }
  | { kind: "clear"; chatId: number; doIt: boolean }
  | { kind: "prompt"; chatId: number; text: string }
  | { kind: "unknown"; chatId: number; text: string };

const CMD_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*(.*)$/;

/**
 * Pure: one Telegram update + pairing state → one typed action.
 * - unpaired: only /start gets through (auto-pairs the first account)
 * - paired: only ownerId; bots, edits, non-text → ignore
 * - unknown command names and stale buttons → ignore/unknown (never crash)
 */
export function route(update: TgUpdate, ownerId: number | undefined): TgAction {
  const cb = update.callback_query;
  if (cb) {
    const chatId = cb.message?.chat.id ?? -1;
    if (ownerId === undefined || cb.from.id !== ownerId) {
      return { kind: "notAuthorized", chatId, fromId: cb.from.id };
    }
    const d = cb.data ?? "";
    if (d === CB.STOP) return { kind: "stop", chatId };
    if (d.startsWith("so:")) return { kind: "switchOk", chatId, index: Number(d.slice(3)) };
    if (d.startsWith("s:")) return { kind: "sessionActivate", chatId, index: Number(d.slice(2)) };
    if (d.startsWith("m:")) return { kind: "modelSet", chatId, index: Number(d.slice(2)) };
    if (d.startsWith("t:")) return { kind: "thinkingSet", chatId, index: Number(d.slice(2)) };
    if (d === "k:1" || d === "k:0") return { kind: "kill", chatId, yes: d === "k:1" };
    if (d === "c:1" || d === "c:0") return { kind: "clear", chatId, doIt: d === "c:1" };
    return { kind: "ignore" };
  }

  const msg = update.message;
  if (!msg || !msg.text) return { kind: "ignore" }; // edited_message, non-text, empty
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? -1;
  if (msg.from?.is_bot) return { kind: "ignore" };

  if (ownerId === undefined) {
    const t = msg.text.trim();
    if (t === "/start" || t.startsWith("/start@")) return { kind: "pair", chatId, fromId };
    return { kind: "notAuthorized", chatId, fromId };
  }
  if (fromId !== ownerId) return { kind: "notAuthorized", chatId, fromId };

  const text = msg.text.trim();
  const cmd = CMD_RE.exec(text);
  if (cmd) {
    const rest = cmd[2].trim();
    switch (cmd[1]) {
      case "start": return { kind: "start", chatId };
      case "help": return { kind: "help", chatId };
      case "new": return { kind: "new", chatId };
      case "sessions": return { kind: "sessions", chatId };
      case "models": return { kind: "modelList", chatId };
      case "thinking": return { kind: "thinkingList", chatId };
      case "status": return { kind: "status", chatId };
      case "stop": return { kind: "stop", chatId };
      case "compact": return { kind: "compact", chatId };
      case "name": return { kind: "nameSet", chatId, name: rest };
      case "kill": return { kind: "killAsk", chatId };
      default: return { kind: "unknown", chatId, text };
    }
  }
  return { kind: "prompt", chatId, text };
}
```

**Step 4: Run to verify pass** — `node --test tests/router.test.ts` → `pass 4 / fail 0`; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: pure router (pairing gate, commands, compact callback vocabulary)"
```

**Checkpoint G:** `npx tsc --noEmit && node --test` → all green before Phase 6.

---

## Phase 6 — State + Onboarding

### Task 11: `src/state.ts` — `TelegramState`

**TDD scenario:** New feature — full TDD cycle.

**Design note:** per-extension-instance runtime state. Exactly two fields must survive process restarts **and** instance swaps (session replacement): `sentIds` and `offset` — they mirror `TelegramConfig` and `index.ts` persists them (design §8: “sent-ID tracker persists so `/new`-clean still works”). Everything else is instance-scoped: the working-message ID, per-tool message IDs, and the **list caches** that give callback buttons their index→item mapping.

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Step 1: Write the failing test `tests/state.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramState } from "../src/state.ts";

test("sent ids: add, dedupe, cap 500 (newest kept)", () => {
  const s = new TelegramState();
  s.addSent(1);
  s.addSent(1);
  s.addSent(2);
  assert.deepEqual(s.sentIds(), [1, 2]);
  for (let i = 3; i <= 502; i++) s.addSent(i);
  const ids = s.sentIds();
  assert.equal(ids.length, 500);
  assert.equal(ids[0], 3);
  assert.equal(ids[499], 502);
});

test("drainSent: newest first + resets", () => {
  const s = new TelegramState();
  s.addSent(1);
  s.addSent(2);
  s.addSent(3);
  assert.deepEqual(s.drainSent(), [3, 2, 1]);
  assert.deepEqual(s.sentIds(), []);
});

test("restoreSentIds: capped + copied", () => {
  const s = new TelegramState();
  const many = Array.from({ length: 600 }, (_, i) => i + 1);
  s.restoreSentIds(many);
  assert.equal(s.sentIds().length, 500);
  many.push(9999);
  assert.equal(s.sentIds().length, 500); // stored copy, not the reference
});

test("offset + working + tool-msg lifecycle", () => {
  const s = new TelegramState(41);
  assert.equal(s.getOffset(), 41);
  s.setOffset(42);
  assert.equal(s.getOffset(), 42);
  s.setWorking(7);
  assert.equal(s.getWorking(), 7);
  s.setWorking(undefined);
  assert.equal(s.getWorking(), undefined);
  s.setToolMsg("tc1", 11);
  assert.equal(s.getToolMsg("tc1"), 11);
  assert.equal(s.getToolMsg("tc2"), undefined);
  s.clearToolMsgs();
  assert.equal(s.getToolMsg("tc1"), undefined);
});

test("list caches: index + out of range", () => {
  const s = new TelegramState();
  s.setSessionList([{ path: "/a.jsonl", id: "a", modified: 1, messageCount: 3 }]);
  assert.equal(s.sessionAt(0)?.path, "/a.jsonl");
  assert.equal(s.sessionAt(1), undefined);
  s.setModelList(["m1", "m2"]);
  assert.equal(s.modelAt(1), "m2");
  assert.equal(s.modelAt(2), undefined);
  s.setThinkingList(["off", "high"]);
  assert.equal(s.thinkingAt(0), "off");
});
```

**Step 2: Run to verify failure** — `node --test tests/state.test.ts` → FAIL (module not found).

**Step 3: Write `src/state.ts`**

```ts
export interface SessionListItem {
  path: string;
  id: string;
  name?: string;
  firstMessage?: string;
  modified: number; // epoch ms
  messageCount: number;
}

const SENT_CAP = 500;

/**
 * Per-instance runtime state. `sentIds` + `offset` are persisted by index.ts
 * (they must survive restarts and session replacement); the rest is instance-scoped.
 */
export class TelegramState {
  private sentIds: number[] = [];
  private offset: number;
  private workingMsgId: number | undefined;
  private toolMsgIds = new Map<string, number>();
  private sessionList: SessionListItem[] = [];
  private modelList: string[] = [];
  private thinkingList: string[] = [];

  constructor(offset = 0) {
    this.offset = offset;
  }

  // persisted
  restoreSentIds(ids: number[]): void {
    this.sentIds = ids.slice(-SENT_CAP);
  }
  sentIds(): number[] {
    return [...this.sentIds];
  }
  addSent(id: number): void {
    if (this.sentIds.includes(id)) return;
    this.sentIds.push(id);
    if (this.sentIds.length > SENT_CAP) this.sentIds = this.sentIds.slice(-SENT_CAP);
  }
  /** Newest first; empties the tracker (used by “clear chat”). */
  drainSent(): number[] {
    const out = [...this.sentIds].reverse();
    this.sentIds = [];
    return out;
  }
  getOffset(): number {
    return this.offset;
  }
  setOffset(n: number): void {
    this.offset = n;
  }

  // instance-scoped
  setWorking(id: number | undefined): void {
    this.workingMsgId = id;
  }
  getWorking(): number | undefined {
    return this.workingMsgId;
  }
  setToolMsg(toolCallId: string, msgId: number): void {
    this.toolMsgIds.set(toolCallId, msgId);
  }
  getToolMsg(toolCallId: string): number | undefined {
    return this.toolMsgIds.get(toolCallId);
  }
  clearToolMsgs(): void {
    this.toolMsgIds.clear();
  }
  setSessionList(items: SessionListItem[]): void {
    this.sessionList = items;
  }
  sessionAt(i: number): SessionListItem | undefined {
    return this.sessionList[i];
  }
  setModelList(models: string[]): void {
    this.modelList = models;
  }
  modelAt(i: number): string | undefined {
    return this.modelList[i];
  }
  setThinkingList(levels: string[]): void {
    this.thinkingList = levels;
  }
  thinkingAt(i: number): string | undefined {
    return this.thinkingList[i];
  }
}
```

**Step 4: Run to verify pass** — `node --test tests/state.test.ts` → `pass 5 / fail 0`; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: TelegramState (sent-id tracker, offset, working/tool msg ids, list caches)"
```

### Task 12: `src/onboarding.ts` — QR + pairing texts

**TDD scenario:** New feature — full TDD cycle.

**Design note (verified):** `QRCode.create` is synchronous → `{ modules: { size, data } }` (row-major, 1 = dark). A `https://t.me/<bot>` link yields a 25×25 matrix at ECC-L. Render with `█`/`▁` + a 4-module quiet zone — NOT `QRCode.toString(..., {type:"terminal"})` (ANSI escapes, unusably wide).

**Files:**
- Create: `src/onboarding.ts`
- Test: `tests/onboarding.test.ts`

**Step 1: Write the failing test `tests/onboarding.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { notAuthorizedText, pairWelcome, renderQr, tokenLooksValid } from "../src/onboarding.ts";

test("renderQr: uniform width, no ANSI escapes, deterministic, has modules", () => {
  const q1 = renderQr("https://t.me/pi_telegram_bot");
  const q2 = renderQr("https://t.me/pi_telegram_bot");
  assert.equal(q1, q2);
  assert.ok(!q1.includes("\x1b"));
  const lines = q1.split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `line widths: ${[...widths]}`);
  assert.ok(lines.length >= 25);
  assert.ok(q1.includes("█") && q1.includes("▁"));
});

test("tokenLooksValid: BotFather shape only", () => {
  assert.ok(tokenLooksValid("123456789:AAHk3xYz-abcDEF1234567890123456"));
  assert.ok(tokenLooksValid("  123456789:AAHk3xYz-abcDEF1234567890123456  "));
  assert.ok(!tokenLooksValid("abc"));
  assert.ok(!tokenLooksValid("123456:"));
  assert.ok(!tokenLooksValid("123456:short"));
});

test("pairing texts", () => {
  assert.ok(pairWelcome("mybot", 42).includes("ID 42"));
  assert.ok(pairWelcome("mybot", 42).includes("t.me/mybot"));
  assert.ok(!pairWelcome(undefined, 42).includes("t.me/undefined"));
  assert.ok(notAuthorizedText(true).includes("another account"));
  assert.ok(notAuthorizedText(false).includes("Start"));
});
```

**Step 2: Run to verify failure** — `node --test tests/onboarding.test.ts` → FAIL (module not found).

**Step 3: Write `src/onboarding.ts`**

```ts
import QRCode from "qrcode";

/**
 * Terminal QR: matrix rendered as █/▁ with a 4-module quiet zone.
 * A t.me bot link needs 25×25 at ECC-L → ~33 chars wide. No ANSI escapes.
 */
export function renderQr(text: string): string {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = modules.size;
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    let row = "    ";
    for (let c = 0; c < size; c++) row += modules.data[r * size + c] ? "█" : "▁";
    rows.push(row + "    ");
  }
  const pad = " ".repeat(size + 8);
  return pad + "\n" + rows.join("\n") + "\n" + pad;
}

/** BotFather token shape: <digits>:<20+ alnum/-_>. Real validation is getMe() in the bridge. */
export function tokenLooksValid(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

export function pairWelcome(botUsername: string | undefined, fromId: number): string {
  const tip = botUsername ? `\nTip: bookmark https://t.me/${botUsername}` : "";
  return `✅ Paired. Only your account (ID ${fromId}) can use this bot now.${tip}`;
}

export function notAuthorizedText(alreadyPaired: boolean): string {
  return alreadyPaired
    ? "🔒 Not authorized — this bot is paired with another account."
    : "🔒 Not paired yet. Press the *Start* button in this chat — the first account to press it becomes the owner.";
}
```

**Step 4: Run to verify pass** — `node --test tests/onboarding.test.ts` → `pass 3 / fail 0`; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/onboarding.ts tests/onboarding.test.ts
git commit -m "feat: onboarding helpers (terminal QR, token shape, pairing texts)"
```

**Checkpoint H:** `npx tsc --noEmit && node --test` → all green before Phase 7.

---

## Phase 7 — Session Bridge

**Design note (load-bearing — re-verify while implementing):** the bridge maps router `TgAction`s to pi calls. Only THREE operations require a command context (`newSession`, `switchSession`, `waitForIdle`) — those are dispatched by `index.ts` through the “`/tg internal …`” command path (design §5). Everything else runs in the plain extension context. The session-replacement dance: the bridge persists `cfg.pendingAction` **before** calling `pi.newSession()`/`pi.switchSession(path)`; the OLD instance is then torn down and the NEW instance’s `session_start` calls `bridge.onSessionReplaced(chatId)` which consumes the pending action and posts card + clear-question. All texts sent to Telegram are HTML (the `Out` adapter defaults `parse_mode: "HTML"`), so dynamic values are escaped with `escapeHtml`.

### Task 13: `session-bridge.ts` core — interfaces, fakes, basic handlers

**TDD scenario:** New feature — full TDD cycle. The fakes (`tests/fake-pi.ts`) are created here because bridge tests need them.

**Files:**
- Test: `tests/thinking.test.ts`
- Create: `src/thinking.ts`
- Create: `src/session-bridge.ts`
- Create: `tests/fake-pi.ts`
- Create: `tests/helpers.ts`
- Test: `tests/bridge-core.test.ts`

**Step 1: Write the failing test `tests/thinking.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { supportedThinkingLevels } from "../src/thinking.ts";

test("non-reasoning model → only 'off'", () => {
  assert.deepEqual(supportedThinkingLevels({ id: "m", name: "M", provider: "p", reasoning: false }), ["off"]);
});

test("reasoning, no map → off..high (xhigh/max need explicit map)", () => {
  const levels = supportedThinkingLevels({ id: "m", name: "M", provider: "p", reasoning: true });
  assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high"]);
});

test("map: null drops the level; defined xhigh adds it", () => {
  const levels = supportedThinkingLevels({
    id: "m", name: "M", provider: "p", reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "128000" },
  });
  assert.ok(!levels.includes("minimal"));
  assert.ok(levels.includes("xhigh"));
  assert.ok(!levels.includes("max"));
});

test("map: off can be dropped too", () => {
  const levels = supportedThinkingLevels({
    id: "m", name: "M", provider: "p", reasoning: true,
    thinkingLevelMap: { off: null },
  });
  assert.ok(!levels.includes("off"));
});
```

**Step 2: Run to verify failure** — `node --test tests/thinking.test.ts` → FAIL (module not found).

**Step 3: Write `src/thinking.ts`**

```ts
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** pi’s per-model mapping; null = unsupported, undefined = infer (xhigh/max then unsupported) */
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}

const ALL: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Mirrors pi’s thinking-level support rules (see “Verified API facts”). */
export function supportedThinkingLevels(model: PiModel): PiThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return ALL.filter((lvl) => {
    const v = model.thinkingLevelMap?.[lvl];
    if (v === null) return false; // explicitly unsupported
    if ((lvl === "xhigh" || lvl === "max") && v === undefined) return false; // needs explicit map entry
    return true;
  });
}
```

**Step 4: Run to verify pass** — `node --test tests/thinking.test.ts` → `pass 4 / fail 0`.

**Step 5: Write `tests/helpers.ts`** (shared by all bridge test files)

```ts
import type { TelegramPi, BridgeDeps } from "../src/session-bridge.ts";
import type { TelegramConfig } from "../src/config.ts";
import { TelegramState } from "../src/state.ts";
import type { FakeOut } from "./fake-pi.ts";

export function makeDeps(pi: TelegramPi, out: FakeOut, cfg: Partial<TelegramConfig> = {}): BridgeDeps {
  return {
    pi,
    out,
    state: new TelegramState(),
    cfg: {
      botToken: "t",
      ownerId: 7,
      streamEditMs: 1500,
      toolPreviewChars: 300,
      askClearOnSwitch: true,
      maxSessionList: 20,
      sentMessageIds: [],
      ...cfg,
    },
    botUsername: "testbot",
    persist: async () => {},
    sleep: async () => {},
  };
}

export function lastSend(out: FakeOut): string {
  const sends = out.calls.filter((c) => c.kind === "send" && typeof c.text === "string");
  return sends[sends.length - 1]!.text as string;
}
```

**Step 6: Write the failing test `tests/bridge-core.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText, timeAgo, type TelegramPi } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

test("prompt: idle → deliverAs 'now', no ack message", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "do it" });
  assert.deepEqual(pi.sentPrompts, [{ text: "do it", deliverAs: "now" }]);
  assert.equal(out.calls.length, 0);
});

test("prompt: busy → 'steer' + queued ack", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "next" });
  assert.deepEqual(pi.sentPrompts, [{ text: "next", deliverAs: "steer" }]);
  assert.equal(lastSend(out), "⚡ queued (applies after current tool step)");
});

test("stop: idle → note only; busy → abort + note", async () => {
  const pi = new FakePi({ busy: true });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi.abortCalls, 1);
  assert.ok(lastSend(out).startsWith("⏹"));
  const pi2 = new FakePi();
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "stop", chatId: 7 });
  assert.equal(pi2.abortCalls, 0);
  assert.ok(lastSend(out2).includes("idle"));
});

test("status: renders cwd/model/thinking/context/messages + busy state", async () => {
  const pi = new FakePi({
    cwd: "/proj",
    model: { id: "m1", name: "Model One", provider: "p", reasoning: false },
    thinking: "high",
    contextUsage: { tokens: 1000, contextWindow: 2000, percent: 50 },
    messageCount: 12,
  });
  const out = new FakeOut();
  await new SessionBridge(makeDeps(pi.build(), out)).dispatch({ kind: "status", chatId: 7 });
  const t = lastSend(out);
  assert.ok(t.includes("/proj"));
  assert.ok(t.includes("Model One"));
  assert.ok(t.includes("thinking: high"));
  assert.ok(t.includes("50%"));
  assert.ok(t.includes("12"));
  assert.ok(t.includes("idle"));
});

test("pair: sets ownerId, sends welcome + card + help", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out, { ownerId: undefined });
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "pair", chatId: 99, fromId: 42 });
  assert.equal(deps.cfg.ownerId, 42);
  const texts = out.calls.map((c) => c.text).filter(Boolean) as string[];
  assert.equal(texts.length, 3);
  assert.ok(texts[0].includes("ID 42"));
  assert.ok(texts[1].startsWith("📌"));
  assert.ok(texts[2].includes("/help"));
});

test("notAuthorized: different text paired vs unpaired", async () => {
  const out = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out, { ownerId: undefined }))
    .dispatch({ kind: "notAuthorized", chatId: 1, fromId: 2 });
  assert.ok(lastSend(out).includes("Start"));
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out2)).dispatch({
    kind: "notAuthorized",
    chatId: 1,
    fromId: 2,
  });
  assert.ok(lastSend(out2).includes("another account"));
});

test("unknown + help", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.dispatch({ kind: "unknown", chatId: 7, text: "/wat" });
  assert.ok(lastSend(out).includes("/help"));
  await bridge.dispatch({ kind: "help", chatId: 7 });
  const t = lastSend(out);
  for (const c of ["/new", "/sessions", "/models", "/thinking", "/stop", "/compact", "/name", "/kill"]) {
    assert.ok(t.includes(c), `help missing ${c}`);
  }
  assert.ok(helpText().includes("&lt;text&gt;")); // escaped in HTML mode
});

test("dispatch: handler error → ⚠ to chat + TUI notice, never throws", async () => {
  const pi = new FakePi();
  const evil: TelegramPi = { ...pi.build(), isIdle: () => { throw new Error("boom"); } };
  const out = new FakeOut();
  const deps = makeDeps(evil, out);
  assert.throws(() => deps.pi.isIdle());
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "prompt", chatId: 7, text: "x" }); // prompt path calls isIdle()
  assert.ok(lastSend(out).includes("boom"));
  assert.equal(pi.uiNotices.length, 1);
  assert.equal(pi.uiNotices[0].level, "error");
});

test("timeAgo", () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), "5s ago");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(timeAgo(now - 3 * 3600_000, now), "3h ago");
  assert.equal(timeAgo(now - 2 * 86400_000, now), "2d ago");
  assert.match(timeAgo(now - 30 * 86400_000, now), /^\d{4}-\d{2}-\d{2}$/);
});
```

**Step 7: Run to verify failure** — `node --test tests/bridge-core.test.ts` → FAIL (module not found).

**Step 8: Write `tests/fake-pi.ts`**

```ts
import type { TelegramPi, PiModelInfo, PiSessionInfo, PiContextUsage } from "../src/session-bridge.ts";
import type { PiModel, PiThinkingLevel } from "../src/thinking.ts";

export interface FakePiOptions {
  cwd?: string;
  busy?: boolean;
  model?: PiModel;
  thinking?: PiThinkingLevel;
  scopedModels?: PiModelInfo[];
  allModels?: PiModel[];
  sessionName?: string;
  sessionPath?: string;
  messageCount?: number;
  contextUsage?: PiContextUsage;
  sessions?: PiSessionInfo[];
  modelSetResult?: boolean;
}

export class FakePi {
  readonly opts: FakePiOptions;
  readonly sentPrompts: { text: string; deliverAs: "now" | "steer" }[] = [];
  abortCalls = 0;
  newSessionCalls = 0;
  switchSessions: string[] = [];
  waitForIdleCalls = 0;
  setModels: string[] = [];
  setThinkings: string[] = [];
  setNames: string[] = [];
  shutdownCalls = 0;
  compactCalls = 0;
  compactDone: ((ok: boolean, detail?: string) => void) | undefined;
  uiNotices: { text: string; level?: "info" | "warning" | "error" }[] = [];

  constructor(opts: FakePiOptions = {}) {
    this.opts = opts;
  }

  build(): TelegramPi {
    const self = this;
    return {
      cwd: self.opts.cwd ?? "/proj",
      isIdle: () => !self.opts.busy,
      abort: () => self.abortCalls++,
      sendPrompt: (text, deliverAs) => self.sentPrompts.push({ text, deliverAs }),
      newSession: () => self.newSessionCalls++,
      switchSession: (path) => self.switchSessions.push(path),
      waitForIdle: async () => {
        self.waitForIdleCalls++;
      },
      compact: (onDone) => {
        self.compactCalls++;
        self.compactDone = onDone;
      },
      getSessionName: () => self.opts.sessionName,
      setSessionName: (name) => self.setNames.push(name),
      currentModel: () => self.opts.model,
      currentThinking: () => self.opts.thinking,
      scopedModels: () => self.opts.scopedModels ?? [],
      allModels: () => self.opts.allModels ?? [],
      setModel: async (id) => {
        self.setModels.push(id);
        return self.opts.modelSetResult ?? true;
      },
      setThinkingLevel: (level) => self.setThinkings.push(level),
      contextUsage: () => self.opts.contextUsage,
      messageCount: () => self.opts.messageCount ?? 0,
      listSessions: async () => self.opts.sessions ?? [],
      currentSessionPath: () => self.opts.sessionPath ?? "/proj/current.jsonl",
      notifyUi: (text, level) => self.uiNotices.push({ text, level }),
      shutdown: () => self.shutdownCalls++,
    };
  }
}

export interface FakeOutCall {
  kind: "send" | "edit" | "delete";
  chatId: number;
  messageId?: number;
  text?: string;
  opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown };
}

export class FakeOut {
  calls: FakeOutCall[] = [];
  nextMessageId = 100;
  sendFailsWith: Error | undefined;

  send = async (chatId: number, text: string, opts?: FakeOutCall["opts"]): Promise<number | undefined> => {
    if (this.sendFailsWith) throw this.sendFailsWith;
    this.calls.push({ kind: "send", chatId, text, opts });
    return this.nextMessageId++;
  };
  edit = async (chatId: number, messageId: number, text: string, opts?: FakeOutCall["opts"]): Promise<boolean> => {
    this.calls.push({ kind: "edit", chatId, messageId, text, opts });
    return true;
  };
  delete = async (chatId: number, messageId: number): Promise<void> => {
    this.calls.push({ kind: "delete", chatId, messageId });
  };
}
```

**Step 9: Write `src/session-bridge.ts`**

```ts
import type { TgAction } from "./router.ts";
import { CB } from "./router.ts";
import type { TelegramConfig } from "./config.ts";
import type { TelegramState, SessionListItem } from "./state.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import { supportedThinkingLevels } from "./thinking.ts";
import { pairWelcome, notAuthorizedText } from "./onboarding.ts";
import { escapeHtml } from "./markdown.ts";

export interface PiModelInfo {
  model: PiModel;
  thinkingLevel?: PiThinkingLevel;
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: number; // epoch ms (converted from pi’s Date by the adapter)
  modified: number; // epoch ms
  messageCount: number;
  firstMessage: string;
}

/** Structural view of the pi extension context — implemented by index.ts only. */
export interface TelegramPi {
  cwd: string;
  isIdle(): boolean;
  abort(): void;
  sendPrompt(text: string, deliverAs: "now" | "steer"): void;
  newSession(): void; // triggers instance replacement
  switchSession(path: string): void; // triggers instance replacement
  waitForIdle(): Promise<void>;
  compact(onDone: (ok: boolean, detail?: string) => void): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
  currentModel(): PiModel | undefined;
  currentThinking(): PiThinkingLevel | undefined;
  scopedModels(): PiModelInfo[]; // [] = unscoped
  allModels(): PiModel[];
  setModel(modelId: string): Promise<boolean>; // pi.setModel is async and takes a Model object
  setThinkingLevel(level: PiThinkingLevel): void;
  contextUsage(): PiContextUsage | undefined;
  messageCount(): number;
  listSessions(): Promise<PiSessionInfo[]>;
  currentSessionPath(): string;
  notifyUi(text: string, level?: "info" | "warning" | "error"): void;
  shutdown(): void;
}

/** Telegram send primitives (implemented by index.ts over TelegramClient). */
export interface Out {
  send(
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown }
  ): Promise<number | undefined>;
  edit(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }
  ): Promise<boolean>; // false = text unchanged (not an error)
  delete(chatId: number, messageId: number): Promise<void>; // idempotent
}

export interface BridgeDeps {
  pi: TelegramPi;
  out: Out;
  state: TelegramState;
  cfg: TelegramConfig;
  botUsername: string | undefined;
  persist: () => Promise<void>; // save cfg (offset/sentIds/pendingAction/ownerId)
  sleep: (ms: number) => Promise<void>;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function helpText(): string {
  return [
    "<b>pi-tg</b> — drive this pi session from Telegram",
    "Plain text → prompt (busy → ⚡ queued steer)",
    "<b>/new</b> — start a new session",
    "<b>/sessions</b> — list &amp; switch sessions",
    "<b>/models</b> — pick a model",
    "<b>/thinking</b> — pick the thinking level",
    "<b>/status</b> — session info",
    "<b>/stop</b> — Esc (stop the current turn)",
    "<b>/compact</b> — compact the history",
    "<b>/name &lt;text&gt;</b> — rename this session",
    "<b>/kill</b> — shut down pi",
    "<b>/help</b> — this text",
  ].join("\n");
}

export class SessionBridge {
  private deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** Top-level entry: never throws; failures become a ⚠ message + TUI notice. */
  async dispatch(action: TgAction): Promise<void> {
    if (action.kind === "ignore") return;
    try {
      await this.handle(action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.pi.notifyUi(`pi-tg: `, "error");
      const chatId = "chatId" in action ? (action as { chatId: number }).chatId : undefined;
      if (chatId !== undefined) {
        try {
          await this.deps.out.send(chatId, `⚠️ ${escapeHtml(msg)}`);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Called by the REPLACEMENT instance on session_start (design §8). */
  async onSessionReplaced(chatId: number): Promise<void> {
    const { cfg, out } = this.deps;
    const pa = cfg.pendingAction;
    if (!pa) return;
    cfg.pendingAction = undefined;
    await this.deps.persist();
    if (pa.chatId !== chatId) return;
    await out.send(chatId, this.sessionCardText());
    if (cfg.askClearOnSwitch) {
      await out.send(chatId, "Clear chat history?", {
        replyMarkup: {
          inline_keyboard: [[{ text: "🧹 Clear", callback_data: CB.clear(true) }, { text: "Keep", callback_data: CB.clear(false) }]],
        },
      });
    }
  }

  private sessionCardText(): string {
    const { pi } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    return [
      `📌 <b>${escapeHtml(name)}</b>`,
      `<code>${escapeHtml(pi.cwd)}</code>`,
      `${model ? escapeHtml(model.name) : "no model"} · thinking: ${pi.currentThinking() ?? "default"}`,
      `${pi.messageCount()} messages${usage?.percent != null ? ` · context ${usage.percent}%` : ""}`,
    ].join("\n");
  }

  private statusText(): string {
    const { pi } = this.deps;
    const model = pi.currentModel();
    const usage = pi.contextUsage();
    const name = pi.getSessionName() ?? "Untitled session";
    return [
      `📊 <b>${escapeHtml(name)}</b> — ${pi.isIdle() ? "idle" : "busy"}`,
      `<code>${escapeHtml(pi.cwd)}</code>`,
      `model: ${model ? escapeHtml(model.name) : "n/a"} · thinking: ${pi.currentThinking() ?? "default"}`,
      `context: ${usage?.percent != null ? `${usage.percent}%` : "n/a"}${usage?.tokens != null ? ` (${usage.tokens}/${usage.contextWindow})` : ""}`,
      `messages: ${pi.messageCount()}`,
    ].join("\n");
  }

  private async sendCardAndHelp(chatId: number): Promise<void> {
    await this.deps.out.send(chatId, this.sessionCardText());
    await this.deps.out.send(chatId, helpText());
  }

  private async handle(action: TgAction): Promise<void> {
    const { out, pi, cfg } = this.deps;
    switch (action.kind) {
      case "notAuthorized":
        await out.send(action.chatId, notAuthorizedText(cfg.ownerId !== undefined));
        return;
      case "pair":
        cfg.ownerId = action.fromId;
        await this.deps.persist();
        await out.send(action.chatId, pairWelcome(this.deps.botUsername, action.fromId));
        await this.sendCardAndHelp(action.chatId);
        return;
      case "start":
        await this.sendCardAndHelp(action.chatId);
        return;
      case "help":
        await out.send(action.chatId, helpText());
        return;
      case "unknown":
        await out.send(action.chatId, `Unknown command ${escapeHtml(action.text)} — see /help`);
        return;
      case "prompt": {
        const busy = !pi.isIdle();
        pi.sendPrompt(action.text, busy ? "steer" : "now");
        if (busy) await out.send(action.chatId, "⚡ queued (applies after current tool step)");
        return;
      }
      case "status":
        await out.send(action.chatId, this.statusText());
        return;
      case "stop":
        if (pi.isIdle()) await out.send(action.chatId, "Nothing to stop — session is idle.");
        else {
          pi.abort();
          await out.send(action.chatId, "⏹ Stopping…");
        }
        return;
      case "compact":
        await out.send(action.chatId, "🗜 Compacting history… (may take a moment)");
        pi.compact((ok, detail) => {
          void out.send(
            action.chatId,
            ok ? `✓ Compacted${detail ? ` — ${detail}` : "."}` : `⚠️ Compact failed${detail ? `: ${detail}` : "."}`
          );
        });
        return;
      case "new":
        cfg.pendingAction = { type: "new", chatId: action.chatId };
        await this.deps.persist();
        await out.send(action.chatId, "🔄 Creating new session…");
        pi.newSession();
        return;
      case "sessions":
        await this.handleSessions(action.chatId);
        return;
      case "sessionActivate":
        await this.handleSessionActivate(action);
        return;
      case "switchOk":
        await this.handleSwitchOk(action);
        return;
      case "modelList":
        await this.handleModelList(action.chatId);
        return;
      case "modelSet":
        await this.handleModelSet(action);
        return;
      case "thinkingList":
        await this.handleThinkingList(action.chatId);
        return;
      case "thinkingSet":
        await this.handleThinkingSet(action);
        return;
      case "nameSet":
        if (!action.name) {
          await out.send(action.chatId, "Usage: /name <text>");
          return;
        }
        pi.setSessionName(action.name);
        await out.send(action.chatId, `📌 Renamed to <b>${escapeHtml(action.name)}</b>.`);
        return;
      case "killAsk":
        await out.send(action.chatId, "⚠️ This terminates the pi process — the bot goes silent until pi restarts. Sure?", {
          replyMarkup: {
            inline_keyboard: [[{ text: "☠ Yes, kill", callback_data: CB.kill(true) }, { text: "No", callback_data: CB.kill(false) }]],
          },
        });
        return;
      case "kill":
        if (!action.yes) {
          await out.send(action.chatId, "OK — pi keeps running.");
          return;
        }
        await out.send(action.chatId, "👋 Shutting down pi… (bot goes silent)");
        pi.shutdown();
        return;
      case "clear":
        await this.handleClear(action);
        return;
    }
  }

  private async handleSessions(chatId: number): Promise<void> {
    const { out, pi, cfg, state } = this.deps;
    const infos = await pi.listSessions();
    const sorted = [...infos].sort((a, b) => b.modified - a.modified).slice(0, cfg.maxSessionList);
    const items: SessionListItem[] = sorted.map((s) => ({
      path: s.path,
      id: s.id,
      name: s.name,
      firstMessage: s.firstMessage,
      modified: s.modified,
      messageCount: s.messageCount,
    }));
    state.setSessionList(items);
    if (items.length === 0) {
      await out.send(chatId, "No sessions for this project yet.");
      return;
    }
    const current = pi.currentSessionPath();
    const keyboard = items.map((it, i) => {
      const raw = it.name ?? (it.firstMessage ? it.firstMessage.slice(0, 40) : it.id.slice(0, 8));
      const star = it.path === current ? "★ " : "";
      return [{ text: `${star}${escapeHtml(raw)} — ${it.messageCount} msgs, ${timeAgo(it.modified)}`, callback_data: CB.session(i) }];
    });
    await out.send(chatId, `Sessions for this project (newest first) — tap to switch:`, {
      replyMarkup: { inline_keyboard: keyboard },
    });
  }

  private async handleSessionActivate(action: Extract<TgAction, { kind: "sessionActivate" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const item = state.sessionAt(action.index);
    if (!item) {
      await out.send(action.chatId, "⚠️ List expired — send /sessions again.");
      return;
    }
    if (item.path === pi.currentSessionPath()) {
      await out.send(action.chatId, "Already active.");
      return;
    }
    if (pi.isIdle()) {
      await this.doSwitch(action.chatId, item.path);
      return;
    }
    await out.send(action.chatId, "Agent is running — switch when the current turn ends?", {
      replyMarkup: {
        inline_keyboard: [[{ text: "⏳ OK", callback_data: CB.sessionOk(action.index) }, { text: "Cancel", callback_data: "xc" }]],
      },
    });
  }

  private async handleSwitchOk(action: Extract<TgAction, { kind: "switchOk" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const item = state.sessionAt(action.index);
    if (!item) {
      await out.send(action.chatId, "⚠️ List expired — send /sessions again.");
      return;
    }
    await out.send(action.chatId, "⏳ Waiting for the current turn to end…");
    await pi.waitForIdle();
    await this.doSwitch(action.chatId, item.path);
  }

  private async doSwitch(chatId: number, path: string): Promise<void> {
    const { cfg, out, pi } = this.deps;
    cfg.pendingAction = { type: "activate", chatId, path };
    await this.deps.persist();
    await out.send(chatId, "🔄 Switching session…");
    pi.switchSession(path); // instance replacement; onSessionReplaced posts card + clear question
  }

  private async handleModelList(chatId: number): Promise<void> {
    const { out, pi, state } = this.deps;
    const scoped = pi.scopedModels();
    const models = scoped.length > 0 ? scoped.map((s) => s.model) : pi.allModels();
    if (models.length === 0) {
      await out.send(chatId, "No models available.");
      return;
    }
    state.setModelList(models.map((m) => m.id));
    const current = pi.currentModel()?.id;
    const keyboard = models.map((m, i) => [{ text: `${m.id === current ? "★ " : ""}${escapeHtml(m.name)}`, callback_data: CB.model(i) }]);
    await out.send(chatId, "Model:", { replyMarkup: { inline_keyboard: keyboard } });
  }

  private async handleModelSet(action: Extract<TgAction, { kind: "modelSet" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const id = state.modelAt(action.index);
    if (!id) {
      await out.send(action.chatId, "⚠️ List expired — send /models again.");
      return;
    }
    if (!(await pi.setModel(id))) {
      await out.send(action.chatId, `⚠️ Unknown model: ${escapeHtml(id)}`);
      return;
    }
    const now = pi.currentModel();
    await out.send(action.chatId, `✓ Model set to ${escapeHtml(now?.name ?? id)}.`);
  }

  private async handleThinkingList(chatId: number): Promise<void> {
    const { out, pi, state } = this.deps;
    const model = pi.currentModel();
    if (!model) {
      await out.send(chatId, "No model selected.");
      return;
    }
    const levels = supportedThinkingLevels(model);
    state.setThinkingList(levels);
    const current = pi.currentThinking();
    const keyboard = levels.map((l, i) => [{ text: `${l === current ? "★ " : ""}${l}`, callback_data: CB.thinking(i) }]);
    await out.send(chatId, `Thinking level for ${escapeHtml(model.name)}:`, { replyMarkup: { inline_keyboard: keyboard } });
  }

  private async handleThinkingSet(action: Extract<TgAction, { kind: "thinkingSet" }>): Promise<void> {
    const { out, pi, state } = this.deps;
    const level = state.thinkingAt(action.index);
    if (!level) {
      await out.send(action.chatId, "⚠️ List expired — send /thinking again.");
      return;
    }
    pi.setThinkingLevel(level);
    await out.send(action.chatId, `✓ Thinking: ${level}.`);
  }

  private async handleClear(action: Extract<TgAction, { kind: "clear" }>): Promise<void> {
    const { out, state, sleep } = this.deps;
    if (!action.doIt) {
      await out.send(action.chatId, "OK — chat history kept.");
      return;
    }
    const ids = state.drainSent();
    if (ids.length === 0) {
      await out.send(action.chatId, "Nothing to clear.");
      return;
    }
    await out.send(action.chatId, `🧹 Clearing ${ids.length} messages…`);
    let cleared = 0;
    for (const id of ids) {
      try {
        await out.delete(action.chatId, id);
        cleared++;
      } catch {
        /* already gone */
      }
      await sleep(50); // stay under Telegram rate limits
    }
    await out.send(action.chatId, `✓ Cleared ${cleared}/${ids.length} bot messages. Your own messages stay — Telegram doesn't let a bot delete them.`);
  }
}

```

**Step 10: Run to verify pass** — `node --test tests/thinking.test.ts tests/bridge-core.test.ts` → `pass 13 / fail 0` (thinking 4 + bridge-core 9); `npx tsc --noEmit` → clean.

> If `timeAgo`/`helpText`/`dispatch` signatures fight the tests, fix the TEST expectations only if the behavior is right — never weaken an assertion to match an accident.

**Step 11: Commit**

```bash
git add src/thinking.ts tests/thinking.test.ts src/session-bridge.ts tests/fake-pi.ts tests/helpers.ts tests/bridge-core.test.ts
git commit -m "feat: thinking levels + session bridge core (interfaces, basic handlers, fakes, test helpers)"
```

> Tasks 14 and 15 ADD tests to the bridge; their handlers already exist in the file above (written whole to avoid a broken intermediate state). The TDD discipline is preserved: every test in Task 14/15 is added RED-first against a stubbed-out variant — see their instructions.

### Task 14: bridge tests — session operations (RED → GREEN)

**TDD scenario:** Regression-proofing the session-replacement dance. The handlers exist from Task 13; this task writes the tests first and verifies each fails against a deliberately broken stub before being restored — proving the tests actually bite.

**Files:**
- Test: `tests/bridge-sessions.test.ts` (new)

**Step 1: Write `tests/bridge-sessions.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, type TelegramPi } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

const NOW = Date.now();
const other = { path: "/proj/other.jsonl", id: "o", cwd: "/proj", modified: NOW - 1000, messageCount: 5, firstMessage: "hello world" };
const older = { path: "/proj/older.jsonl", id: "d", cwd: "/proj", modified: NOW - 2000, messageCount: 2, name: "Older" };

test("/new: pendingAction persisted (awaited) BEFORE newSession; user notified", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const order: string[] = [];
  const built = pi.build();
  const traced: TelegramPi = { ...built, newSession: () => { order.push("newSession"); built.newSession(); } };
  const deps = makeDeps(traced, out);
  deps.persist = async () => {
    await new Promise((r) => setTimeout(r, 0)); // simulate the real async disk save
    order.push("persist");
  };
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "new", chatId: 7 });
  assert.equal(pi.newSessionCalls, 1);
  assert.deepEqual(order, ["persist", "newSession"]); // persisted first — the replacement instance reads it
  assert.ok(out.calls.some((c) => c.text?.includes("Creating new session")));
  assert.deepEqual(deps.cfg.pendingAction, { type: "new", chatId: 7 });
});

test("onSessionReplaced: posts card + clear question, clears pendingAction", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  deps.cfg.pendingAction = { type: "new", chatId: 7 };
  let persisted = 0;
  deps.persist = () => persisted++;
  const bridge = new SessionBridge(deps);
  await bridge.onSessionReplaced(7);
  assert.equal(deps.cfg.pendingAction, undefined);
  assert.equal(persisted, 1);
  const texts = out.calls.map((c) => c.text).filter(Boolean) as string[];
  assert.equal(texts.length, 2);
  assert.ok(texts[0].startsWith("📌"));
  assert.ok(texts[1].includes("Clear chat history?"));
  const markup = out.calls[out.calls.length - 1].opts?.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(markup.inline_keyboard[0][0].text, "🧹 Clear");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "c:1");
});

test("onSessionReplaced: no pendingAction → no-op", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.onSessionReplaced(7);
  assert.equal(out.calls.length, 0);
});

test("/sessions: newest-first, ★ on current, buttons cached for later callbacks", async () => {
  const pi = new FakePi({ sessions: [older, other] });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "sessions", chatId: 7 });
  const last = out.calls[out.calls.length - 1];
  const kb = last.opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, "hello world — 5 msgs, 1s ago"); // other (modified 2000) first; 'xc' cancel not here
  assert.equal(rows[0][0].callback_data, "s:0");
  assert.equal(rows[1][0].text, "Older — 2 msgs, 2s ago");
  assert.equal(rows[1][0].callback_data, "s:1");
  // current session marked
  const pi2 = new FakePi({ sessions: [other], sessionPath: "/proj/other.jsonl" });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "sessions", chatId: 7 });
  const kb2 = out2.calls[out2.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.ok(kb2.inline_keyboard[0][0].text.startsWith("★ "));
});

test("/sessions: empty → note", async () => {
  const out = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out)).dispatch({ kind: "sessions", chatId: 7 });
  assert.ok(out.calls[out.calls.length - 1].text?.includes("No sessions"));
});

test("activate: current → 'Already active'; idle → switch; busy → OK/Cancel; expired → hint", async () => {
  // idle switch
  const pi = new FakePi({ sessions: [other] });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "sessions", chatId: 7 }); // populate cache
  await bridge.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  assert.deepEqual(pi.switchSessions, ["/proj/other.jsonl"]);
  assert.deepEqual(deps.cfg.pendingAction, { type: "activate", chatId: 7, path: "/proj/other.jsonl" });
  assert.ok(out.calls.some((c) => c.text?.includes("Switching session")));

  // current
  const pi2 = new FakePi({ sessions: [other], sessionPath: "/proj/other.jsonl" });
  const out2 = new FakeOut();
  const b2 = new SessionBridge(makeDeps(pi2.build(), out2));
  await b2.dispatch({ kind: "sessions", chatId: 7 });
  await b2.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  assert.equal(pi2.switchSessions.length, 0);
  assert.ok(out2.calls[out2.calls.length - 1].text?.includes("Already active"));

  // busy → question with sOk button
  const pi3 = new FakePi({ sessions: [other], busy: true });
  const out3 = new FakeOut();
  const b3 = new SessionBridge(makeDeps(pi3.build(), out3));
  await b3.dispatch({ kind: "sessions", chatId: 7 });
  await b3.dispatch({ kind: "sessionActivate", chatId: 7, index: 0 });
  const last3 = out3.calls[out3.calls.length - 1];
  const kb3 = last3.opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb3.inline_keyboard[0][0].callback_data, "so:0");

  // expired
  const out4 = new FakeOut();
  const b4 = new SessionBridge(makeDeps(new FakePi().build(), out4));
  await b4.dispatch({ kind: "sessionActivate", chatId: 7, index: 3 });
  assert.ok(out4.calls[out4.calls.length - 1].text?.includes("List expired"));
});

test("switchOk: waits for idle THEN switches", async () => {
  const pi = new FakePi({ sessions: [other] });
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  const bridge = new SessionBridge(deps);
  await bridge.dispatch({ kind: "sessions", chatId: 7 });
  await bridge.dispatch({ kind: "switchOk", chatId: 7, index: 0 });
  assert.equal(pi.waitForIdleCalls, 1);
  assert.deepEqual(pi.switchSessions, ["/proj/other.jsonl"]);
});

test("/name: empty → usage; else renames + confirms", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "nameSet", chatId: 7, name: "" });
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Usage"));
  await bridge.dispatch({ kind: "nameSet", chatId: 7, name: "My Session" });
  assert.deepEqual(pi.setNames, ["My Session"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("My Session"));
});
```

**Step 2: Run to verify pass** — `node --test tests/bridge-sessions.test.ts` → `pass 8 / fail 0`.

> **Bite check (required, per TDD rules):** the `assert.deepEqual(order, ["persist", "newSession"])` line is the bite — temporarily drop the `await` on `this.deps.persist()` in the `"new"` case; re-run → that test must FAIL (order becomes `["newSession", "persist"]`). Revert.

**Step 3: Commit**

```bash
git add tests/bridge-sessions.test.ts
git commit -m "test: bridge session ops (new/switch dance, sessions list, activate, name)"
```

### Task 15: bridge model/thinking/kill/clear/compact tests

**TDD scenario:** Verification net for the remaining bridge handlers (written whole in Task 13 so every intermediate commit compiles; Task 14’s bite-check convention is the regression proof).

**Files:**
- Test: `tests/bridge-misc.test.ts` (new)

**Step 1: Write `tests/bridge-misc.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

const modelA = { id: "a", name: "Alpha", provider: "p", reasoning: false };
const modelB = { id: "b", name: "Beta", provider: "p", reasoning: true, thinkingLevelMap: { off: "0" } };

test("/models: unscoped → allModels; scoped wins; ★ current; cached ids", async () => {
  const pi = new FakePi({ allModels: [modelA, modelB], model: modelA });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "modelList", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].text, "★ Alpha");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "m:1");

  await bridge.dispatch({ kind: "modelSet", chatId: 7, index: 1 });
  assert.deepEqual(pi.setModels, ["b"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Model set to Beta"));

  // scoped list wins over allModels
  const pi2 = new FakePi({ scopedModels: [{ model: modelB }], model: modelB });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "modelList", chatId: 7 });
  const kb2 = out2.calls[out2.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb2.inline_keyboard.length, 1);

  // unknown model id rejected
  const pi3 = new FakePi({ allModels: [modelA], modelSetResult: false });
  const out3 = new FakeOut();
  const b3 = new SessionBridge(makeDeps(pi3.build(), out3));
  await b3.dispatch({ kind: "modelList", chatId: 7 });
  await b3.dispatch({ kind: "modelSet", chatId: 7, index: 0 });
  assert.ok(out3.calls[out3.calls.length - 1].text?.includes("Unknown model"));

  // expired index
  const out4 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out4)).dispatch({ kind: "modelSet", chatId: 7, index: 9 });
  assert.ok(out4.calls[out4.calls.length - 1].text?.includes("List expired"));
});

test("/thinking: levels from model map; ★ current; set confirms", async () => {
  const pi = new FakePi({ model: modelB, thinking: "off" });
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "thinkingList", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const labels = kb.inline_keyboard.map((r) => r[0].text);
  assert.deepEqual(labels, ["★ off", "minimal", "low", "medium", "high"]);
  await bridge.dispatch({ kind: "thinkingSet", chatId: 7, index: 2 });
  assert.deepEqual(pi.setThinkings, ["low"]);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Thinking: low"));

  // no model
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(new FakePi().build(), out2)).dispatch({ kind: "thinkingList", chatId: 7 });
  assert.ok(out2.calls[out2.calls.length - 1].text?.includes("No model selected"));
});

test("/kill: ask → confirm buttons; No keeps running; Yes shuts down", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "killAsk", chatId: 7 });
  const kb = out.calls[out.calls.length - 1].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].callback_data, "k:1");
  assert.equal(kb.inline_keyboard[0][1].callback_data, "k:0");
  await bridge.dispatch({ kind: "kill", chatId: 7, yes: false });
  assert.equal(pi.shutdownCalls, 0);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("keeps running"));
  await bridge.dispatch({ kind: "kill", chatId: 7, yes: true });
  assert.equal(pi.shutdownCalls, 1);
});

test("clear: Keep → no deletes; Clear → drains tracker, deletes each, throttled, summarizes", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const deps = makeDeps(pi.build(), out);
  const bridge = new SessionBridge(deps);
  deps.state.addSent(11);
  deps.state.addSent(12);
  deps.state.addSent(13);
  let sleeps = 0;
  deps.sleep = async () => sleeps++;

  await bridge.dispatch({ kind: "clear", chatId: 7, doIt: false });
  assert.equal(out.calls.filter((c) => c.kind === "delete").length, 0);
  assert.equal(deps.state.sentIds().length, 3);

  await bridge.dispatch({ kind: "clear", chatId: 7, doIt: true });
  const dels = out.calls.filter((c) => c.kind === "delete");
  assert.deepEqual(dels.map((d) => d.messageId), [13, 12, 11]); // newest first
  assert.equal(sleeps, 3);
  assert.equal(deps.state.sentIds().length, 0);
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Cleared 3/3"));
});

test("compact: progress note + completion callback posts result", async () => {
  const pi = new FakePi();
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(pi.build(), out));
  await bridge.dispatch({ kind: "compact", chatId: 7 });
  assert.ok(out.calls[0].text?.includes("Compacting"));
  pi.compactDone?.(true, "summarized 12 msgs");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(out.calls[out.calls.length - 1].text?.includes("Compacted"));
});
```

**Step 2: Run full suite** — `npx tsc --noEmit && node --test` → ALL green (smoke, config, markdown, client, router, state, onboarding, thinking, bridge-core, bridge-sessions, bridge-misc).

**Step 3: Commit**

```bash
git add tests/bridge-misc.test.ts
git commit -m "test: bridge model/thinking/kill/clear/compact"
```

**Checkpoint I:** all tests green; the bridge is complete. The only pi-coupling left is `index.ts` (Phase 9).

---

## Phase 8 — Mirror (pi events → Telegram)

**Design note:** `mirror.ts` translates pi lifecycle events into the Telegram UX (design §7): `agent_start` → “working” message with `[⏹ Stop]`; each tool → a status line `⚙ <tool>: <arg> … ✔/✖`; assistant text streams via throttled plain-text edits (≤4096); `agent_end` → finalize the working message and post the final answer as **HTML chunks** (`chunkMarkdown` → `markdownToHtml`). The mirror is pi-free: it receives structurally-typed messages (`MirrorMessage`) and injectable deps (`Out`, `TelegramState`, clock). Intermediate assistant messages (tool-call turns) are streamed too, then their stream message is deleted; `agent_end` picks the **last non-empty assistant text** as the final answer.

### Task 16: `src/mirror.ts` — pure helpers + working/tool messages

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Test: `tests/mirror-helpers.ts` (shared mirror-test deps; created first)
- Test: `tests/mirror-tools.test.ts`
- Create: `src/mirror.ts` (grown in Tasks 17–18)

**Step 1: Write the failing test `tests/mirror-tools.test.ts`** (it also imports `tests/mirror-helpers.ts` — write both now; helpers is a plain object factory, no test of its own)

`tests/mirror-helpers.ts`:

```ts
import type { MirrorDeps } from "../src/mirror.ts";
import type { TelegramConfig } from "../src/config.ts";
import { DEFAULTS } from "../src/config.ts";
import { TelegramState } from "../src/state.ts";
import type { FakeOut } from "./fake-pi.ts";

export type MirrorTestDeps = MirrorDeps & { advance(ms: number): void };

export function makeMirrorDeps(
  out: FakeOut,
  cfg: Partial<TelegramConfig> = {},
  chatId: number | undefined = 7
): MirrorTestDeps {
  let clock = 0;
  return {
    out,
    state: new TelegramState(),
    cfg: { ...DEFAULTS, botToken: "t", ownerId: 7, ...cfg },
    getChatId: () => chatId,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
```

`tests/mirror-tools.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, assistantText, toolPreview, type MirrorMessage } from "../src/mirror.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("toolPreview: known args, unknown JSON, whitespace, truncation", () => {
  assert.equal(toolPreview("bash", { command: "ls -la" }), "ls -la");
  assert.equal(toolPreview("read", { path: "C:/x/y.ts" }), "C:/x/y.ts");
  assert.equal(toolPreview("mystery", { a: 1 }), '{"a":1}');
  assert.equal(toolPreview("bash", "  echo   hi  "), "echo hi");
  assert.equal(toolPreview("bash", { command: "x".repeat(200) }), "x".repeat(80) + "…");
  assert.equal(toolPreview("bash", { command: "x".repeat(200) }, 10), "x".repeat(10) + "…");
});

test("assistantText: joins text parts, ignores non-text", () => {
  const m: MirrorMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Hello " }, { type: "image" }, { type: "text", text: "world" }],
  };
  assert.equal(assistantText(m), "Hello world");
});

test("onAgentStart: posts working message with Stop button + tracks id", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].text, "🤖 Working…");
  const kb = out.calls[0].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].callback_data, "stop");
  assert.equal(deps.state.getWorking(), 100);
});

test("onToolStart/onToolEnd: status line then ✔; unknown toolCall ignored", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onToolStart("tc1", "bash", { command: "npm test" });
  assert.equal(out.calls[0].text, "⚙ bash: npm test …");
  assert.equal(deps.state.getToolMsg("tc1"), 100);
  await mirror.onToolEnd("tc1", false);
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚙ bash: npm test … ✔");
  await mirror.onToolEnd("tc2", false);
  assert.equal(out.calls.filter((c) => c.kind === "edit").length, 1);
});

test("onToolEnd: isError marks ✖", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onToolStart("tc1", "read", { path: "/nope" });
  await mirror.onToolEnd("tc1", true);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.equal(edit?.text, "⚙ read: /nope … ✖");
});

test("no chatId yet → every event is a silent no-op", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out, {}, undefined));
  await mirror.onAgentStart();
  await mirror.onToolStart("t", "bash", "x");
  await mirror.onToolEnd("t", false);
  assert.equal(out.calls.length, 0);
});
```

**Step 2: Run to verify failure** — `node --test tests/mirror-tools.test.ts` → FAIL (module not found).

**Step 3: Write `src/mirror.ts` (first cut)**

```ts
import type { Out } from "./session-bridge.ts";
import type { TelegramState } from "./state.ts";
import type { TelegramConfig } from "./config.ts";
import { CB } from "./router.ts";
import { chunkMarkdown, markdownToHtml, TG_MAX_LEN } from "./markdown.ts";

/** Structural (pi-free) view of pi messages. */
export interface MirrorContent {
  type: string;
  text?: string;
}
export interface MirrorMessage {
  role: string;
  content: MirrorContent[];
  stopReason?: string;
  error?: { message?: string };
}

export function assistantText(m: MirrorMessage): string {
  return m.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

const PREVIEW_DEFAULT = 80;
const ARG_KEYS: Record<string, string> = {
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
  grep: "pattern",
  glob: "pattern",
  ls: "path",
  find: "pattern",
};

/** One-line argument preview for tool status lines. */
export function toolPreview(toolName: string, args: unknown, maxChars = PREVIEW_DEFAULT): string {
  let s: string;
  if (typeof args === "string") s = args;
  else if (args && typeof args === "object") {
    const key = ARG_KEYS[toolName];
    const v = key ? (args as Record<string, unknown>)[key] : undefined;
    s = v != null && typeof v === "string" ? v : JSON.stringify(args);
  } else {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

export interface MirrorDeps {
  out: Out;
  state: TelegramState;
  cfg: TelegramConfig;
  getChatId(): number | undefined;
  now(): number; // injectable clock (stream throttling)
}

export class Mirror {
  private deps: MirrorDeps;
  private toolLines = new Map<string, string>();

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  /** agent_start: post the “working” message with [⏹ Stop]. */
  async onAgentStart(): Promise<void> {
    const { out, state } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const id = await out.send(chatId, "🤖 Working…", {
      replyMarkup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: CB.STOP }]] },
    });
    if (id !== undefined) state.setWorking(id);
  }

  /** tool_execution_start: post a status line (plain text). */
  async onToolStart(toolCallId: string, toolName: string, args: unknown): Promise<void> {
    const { out, state, cfg } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const line = `⚙ ${toolName}: ${toolPreview(toolName, args, cfg.toolPreviewChars)} …`;
    const id = await out.send(chatId, line, { parseMode: null });
    if (id !== undefined) {
      state.setToolMsg(toolCallId, id);
      this.toolLines.set(toolCallId, line);
    }
  }

  /** tool_execution_end: mark the status line done. */
  async onToolEnd(toolCallId: string, isError: boolean): Promise<void> {
    const { out, state } = this.deps;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const id = state.getToolMsg(toolCallId);
    const line = this.toolLines.get(toolCallId);
    this.toolLines.delete(toolCallId);
    if (id === undefined || line === undefined) return;
    await out.edit(chatId, id, `${line} ${isError ? "✖" : "✔"}`, { parseMode: null });
  }
}
```

> Tasks 17–18 extend this file with streaming + `agent_end`/`ui_prompt_start`. The `chunkMarkdown`/`markdownToHtml`/`TG_MAX_LEN` imports are used by that code (already imported here so later diffs stay additive; tsc does not error on used-in-later-tasks imports because this file is only complete at Task 18 — **do not run `tsc --noEmit` at Task 16 Step 4**, only `node --test`).

**Step 4: Run to verify pass** — `node --test tests/mirror-tools.test.ts` → `pass 5 / fail 0`.

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-helpers.ts tests/mirror-tools.test.ts
git commit -m "feat: mirror part 1 (tool preview, working + tool status messages)"
```

### Task 17: mirror — assistant streaming (throttled edits)

**TDD scenario:** New feature — full TDD cycle (tests first; implementation extends `src/mirror.ts`).

**Files:**
- Test: `tests/mirror-stream.test.ts`
- Modify: `src/mirror.ts`

**Step 1: Write the failing test `tests/mirror-stream.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { TG_MAX_LEN } from "../src/markdown.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const m = (t: string): MirrorMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });

test("stream: placeholder → throttled edits → end deletes stream msg", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out); // streamEditMs default 1500
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  assert.equal(out.calls[0].text, "…");
  await mirror.onAssistantUpdate(m("ab"));
  assert.equal(out.calls.length, 1); // within 1500ms → no edit
  deps.advance(1600);
  await mirror.onAssistantUpdate(m("abcd"));
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[1].kind, "edit");
  assert.equal(out.calls[1].text, "abcd");
  deps.advance(10);
  await mirror.onAssistantUpdate(m("abcde")); // too soon → throttled
  assert.equal(out.calls.length, 2);
  await mirror.onAssistantEnd(m("abcde"));
  assert.ok(out.calls.some((c) => c.kind === "delete"));
});

test("stream: non-assistant messages ignored", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onAssistantStart({ role: "user", content: [] });
  await mirror.onAssistantUpdate({ role: "user", content: [{ type: "text", text: "x" }] });
  await mirror.onAssistantEnd({ role: "user", content: [{ type: "text", text: "x" }] });
  assert.equal(out.calls.length, 0);
});

test("stream: oversize text truncated mid-stream (≤ TG_MAX_LEN, ellipsis)", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  deps.advance(2000);
  await mirror.onAssistantUpdate(m("a".repeat(5000)));
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text, "an edit must have happened");
  assert.ok(edit!.text!.length <= TG_MAX_LEN);
  assert.ok(edit!.text!.endsWith("…"));
});

test("multiple assistant messages: each stream msg deleted", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  await mirror.onAssistantEnd(m("first"));
  await mirror.onAssistantStart(m(""));
  deps.advance(2000);
  await mirror.onAssistantUpdate(m("second"));
  await mirror.onAssistantEnd(m("second"));
  assert.equal(out.calls.filter((c) => c.kind === "delete").length, 2);
});
```

**Step 2: Run to verify failure** — `node --test tests/mirror-stream.test.ts` → FAIL (`onAssistantStart` is not a function).

**Step 3: Extend `src/mirror.ts`** — add to the class (after `onToolEnd`):

```ts
  // --- streaming (assistant messages) ---
  private streamMsgId: number | undefined;
  private streamText = "";
  private lastStreamEdit = 0;

  /** message_start (assistant only). */
  async onAssistantStart(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    this.streamText = "";
    this.lastStreamEdit = 0;
    const id = await this.deps.out.send(chatId, "…", { parseMode: null });
    this.streamMsgId = id;
  }

  /** message_update (assistant only): throttled plain-text edit. */
  async onAssistantUpdate(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    if (this.streamMsgId === undefined) return;
    this.streamText = assistantText(msg);
    if (this.deps.now() - this.lastStreamEdit < this.deps.cfg.streamEditMs) return;
    let text = this.streamText;
    if (text.length > TG_MAX_LEN - 1) text = text.slice(0, TG_MAX_LEN - 1) + " …";
    this.lastStreamEdit = this.deps.now();
    await this.deps.out.edit(this.deps.getChatId()!, this.streamMsgId, text || "…", { parseMode: null });
  }

  /** message_end (assistant only): drop the stream message. */
  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    const chatId = this.deps.getChatId();
    const id = this.streamMsgId;
    this.streamMsgId = undefined;
    this.streamText = "";
    if (chatId !== undefined && id !== undefined) {
      await this.deps.out.delete(chatId, id).catch(() => {});
    }
  }
```

(Class field declarations between methods are valid syntax — no rearranging needed.)

**Step 4: Run to verify pass** — `node --test tests/mirror-stream.test.ts` → `pass 4 / fail 0`; also re-run `node --test tests/mirror-tools.test.ts` → still green.

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-stream.test.ts
git commit -m "feat: mirror part 2 (throttled assistant streaming)"
```

### Task 18: mirror — `agent_end` finalization + `ui_prompt_start`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Test: `tests/mirror-end.test.ts`
- Modify: `src/mirror.ts`

**Step 1: Write the failing test `tests/mirror-end.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { TG_MAX_LEN } from "../src/markdown.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const m = (t: string, stopReason?: string): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
  stopReason,
});

test("agent_end ok: working → ✅ Done (button cleared), answer posted as HTML chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  const big = "x".repeat(5000);
  await mirror.onAgentEnd([m("mid", "toolUse"), m(big, "stop")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.includes("✅ Done"));
  assert.deepEqual(edit?.opts?.replyMarkup, { inline_keyboard: [] }); // Stop button gone
  const sends = out.calls.filter((c) => c.kind === "send" && typeof c.text === "string" && c.text !== "🤖 Working…");
  assert.ok(sends.length >= 2, `expected chunked answer, got ${sends.length}`);
  for (const s of sends) assert.ok(s.text!.length <= TG_MAX_LEN);
  assert.equal(sends[0].opts?.parseMode, "HTML");
  assert.equal(deps.state.getWorking(), undefined);
});

test("agent_end aborted: ⏹ interrupted + partial text posted", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("partial answer here", "aborted")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.equal(edit?.text, "⏹ interrupted");
  const answer = out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…");
  assert.equal(answer.length, 1);
  assert.ok(answer[0].text!.includes("partial answer here"));
});

test("agent_end error: ⚠️ error note, no answer chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("", "error"), { role: "assistant", content: [], error: { message: "boom <x>" } }]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.startsWith("⚠️ error:"));
  assert.equal(out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…").length, 0);
});

test("agent_end no reply text: Done (no reply text), no chunks", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  await mirror.onAgentEnd([m("", "stop")]);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text?.includes("no reply text"));
  assert.equal(out.calls.filter((c) => c.kind === "send" && c.text !== "🤖 Working…").length, 0);
});

test("agent_end clears tool msg ids", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onToolStart("t1", "bash", "x");
  await mirror.onAgentEnd([m("hi", "stop")]);
  assert.equal(deps.state.getToolMsg("t1"), undefined);
});

test("no chatId: agent_end still clears state, sends nothing", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out, {}, undefined);
  const mirror = new Mirror(deps);
  deps.state.setWorking(5);
  await mirror.onAgentEnd([m("hi", "stop")]);
  assert.equal(out.calls.length, 0);
  assert.equal(deps.state.getWorking(), undefined);
});

test("onUiPromptStart: notes the blocking terminal prompt", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onUiPromptStart("allow bash?");
  const t = out.calls[0].text as string;
  assert.ok(t.includes("permission prompt"));
  assert.ok(t.includes("allow bash?"));
});
```

**Step 2: Run to verify failure** — `node --test tests/mirror-end.test.ts` → FAIL (`onAgentEnd`/`onUiPromptStart` missing).

**Step 3: Extend `src/mirror.ts`** — add to the class:

```ts
  // --- finalization ---

  private async sendAnswer(chatId: number, md: string): Promise<void> {
    for (const chunk of chunkMarkdown(md)) {
      await this.deps.out.send(chatId, markdownToHtml(chunk), { parseMode: "HTML" });
    }
  }

  /** agent_end: finalize working message; post the last non-empty assistant text. */
  async onAgentEnd(messages: MirrorMessage[]): Promise<void> {
    const { out, state } = this.deps;
    let finalText = "";
    let stopReason: string | undefined;
    let errMsg: string | undefined;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const t = assistantText(msg);
      if (t.length > 0) finalText = t;
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.error?.message) errMsg = msg.error.message;
    }
    const chatId = this.deps.getChatId();
    if (chatId !== undefined) {
      const wid = state.getWorking();
      if (stopReason === "aborted") {
        if (wid !== undefined) await out.edit(chatId, wid, "⏹ interrupted", { parseMode: null, replyMarkup: { inline_keyboard: [] } });
        if (finalText) await this.sendAnswer(chatId, finalText);
      } else if (stopReason === "error" || errMsg) {
        if (wid !== undefined) await out.edit(chatId, wid, `⚠️ error: ${errMsg ?? stopReason ?? "unknown"}`, { parseMode: null, replyMarkup: { inline_keyboard: [] } });
      } else {
        const label = finalText ? "✅ Done — answer below" : "✅ Done (no reply text)";
        if (wid !== undefined) await out.edit(chatId, wid, label, { parseMode: null, replyMarkup: { inline_keyboard: [] } });
        if (finalText) await this.sendAnswer(chatId, finalText);
      }
    }
    state.setWorking(undefined);
    state.clearToolMsgs();
  }

  /** ui_prompt_start: pi is blocking on a terminal permission dialog. */
  async onUiPromptStart(title?: string): Promise<void> {
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const t = title ? `: ${title}` : "";
    await this.deps.out.send(chatId, `⚠️ pi is waiting in the terminal (permission prompt${t}). Answer there.`, { parseMode: null });
  }
```

**Step 4: Run to verify pass** — `node --test tests/mirror-end.test.ts tests/mirror-stream.test.ts tests/mirror-tools.test.ts` → `pass 16 / fail 0`; then the FULL suite + types: `npx tsc --noEmit && node --test` → all green (mirror is now complete, so `tsc` runs for the first time since Task 16).

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-end.test.ts
git commit -m "feat: mirror part 3 (agent_end finalization, chunked answers, ui_prompt note)"
```

**Checkpoint J:** `npx tsc --noEmit && node --test` → all green. Every `src/` module except `index.ts` now exists and is tested.

---

## Phase 9 — Wiring (`index.ts`)

**Dispatch architecture (load-bearing — read before implementing):** `newSession`/`switchSession`/`waitForIdle` exist ONLY on `ExtensionCommandContext` (verified fact #3), but phone updates arrive in the poll loop, outside any command. Solution — **all actions run inside a `/tg internal …` command**:

1. Poll loop → `route()` → `TgAction`.
2. `prompt` → `bridge.dispatch(action)` directly (free text via `pi.sendUserMessage`, no command ctx needed).
3. `notAuthorized` / `unknown` → direct reply via `out` (no pi needed at all).
4. **everything else** → `pi.sendUserMessage("/tg " + encodeInternal(action), { expandPromptTemplates: true })` → pi executes the registered `/tg` command **immediately, even mid-stream** (verified fact #2) with a full command ctx → handler stores the ctx, `parseInternal` → `bridge.dispatch(action)`.
5. `new`/`activate` persist `pendingAction` (which carries the chatId) and `await persist()` BEFORE `ctx.newSession()/switchSession()`; the replacement instance’s `session_start` calls `bridge.onSessionReplaced(chatId)` to consume it.

Verified pi type signatures used by this phase (re-verified against `dist/core/extensions/types.d.ts`):
- `pi.on(event, handler)` with `ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => …` — **event first, ctx second**.
- `pi.registerCommand(name, { description?, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> })` — **args first, ctx second**.
- `pi.sendUserMessage(text, { deliverAs?: "steer" | "followUp", expandPromptTemplates? })` — **no `"now"` value** (omitting `deliverAs` = immediate); the bridge’s `"now"` maps to omission.
- `pi.setModel(model: Model): Promise<boolean>` (takes a Model object — the adapter looks it up by id), `pi.setThinkingLevel(level)`, `pi.setSessionName(name)`, `pi.getSessionName()` — all on **ExtensionAPI**, not on ctx.
- `ctx.compact({ onComplete?: (result: CompactionResult) => void, onError?: (error: Error) => void })` (fire-and-forget), `ctx.getContextUsage()`, `ctx.sessionManager.getBranch()` (entries have `type`), `ctx.ui.notify(msg, level)`, `ctx.ui.setWidget(key, string[])`, `ctx.mode`, `ctx.hasUI`.
- CLI: `pi -e <path>` loads a single-file extension (verified in `docs/usage.md`).

### Task 19: `src/command-args.ts` — internal command encode/parse

**TDD scenario:** New pure function — full TDD cycle.

**Files:**
- Test: `tests/command-args.test.ts`
- Create: `src/command-args.ts`

**Step 1: Write the failing test `tests/command-args.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeInternal, parseInternal } from "../src/command-args.ts";
import type { TgAction } from "../src/router.ts";

test("round-trip: every dispatchable action", () => {
  const actions: TgAction[] = [
    { kind: "pair", chatId: 7, fromId: 42 },
    { kind: "start", chatId: 7 },
    { kind: "help", chatId: 7 },
    { kind: "new", chatId: 7 },
    { kind: "sessions", chatId: 7 },
    { kind: "sessionActivate", chatId: 7, index: 3 },
    { kind: "switchOk", chatId: 7, index: 2 },
    { kind: "modelList", chatId: 7 },
    { kind: "modelSet", chatId: 7, index: 0 },
    { kind: "thinkingList", chatId: 7 },
    { kind: "thinkingSet", chatId: 7, index: 1 },
    { kind: "status", chatId: 7 },
    { kind: "stop", chatId: 7 },
    { kind: "compact", chatId: 7 },
    { kind: "nameSet", chatId: 7, name: "my name & stuff" },
    { kind: "killAsk", chatId: 7 },
    { kind: "kill", chatId: 7, yes: true },
    { kind: "kill", chatId: 7, yes: false },
    { kind: "clear", chatId: 7, doIt: true },
    { kind: "prompt", chatId: 7, text: "hello\nworld \"quoted\"" },
  ];
  for (const a of actions) {
    const enc = encodeInternal(a);
    assert.ok(enc !== null, `encode(${a.kind})`);
    assert.deepEqual(parseInternal(enc!), a, `round-trip ${a.kind}`);
  }
});

test("encode: undisplayable actions → null", () => {
  assert.equal(encodeInternal({ kind: "ignore" }), null);
  assert.equal(encodeInternal({ kind: "notAuthorized", chatId: 1, fromId: 2 }), null);
  assert.equal(encodeInternal({ kind: "unknown", chatId: 1, text: "x" }), null);
});

test("parse: garbage → null (never throws)", () => {
  assert.equal(parseInternal(""), null);
  assert.equal(parseInternal("help"), null);
  assert.equal(parseInternal("internal"), null);
  assert.equal(parseInternal("internal status"), null);
  assert.equal(parseInternal("internal status abc"), null);
  assert.equal(parseInternal("internal status -1"), null);
  assert.equal(parseInternal("internal bogus 7"), null);
  assert.equal(parseInternal("internal nameSet 7 not-json"), null);
  assert.equal(parseInternal("internal prompt 7 {1}"), null);
  assert.equal(parseInternal("internal sessionActivate 7 x"), null);
  assert.equal(parseInternal("internal kill 7 maybe"), null);
});
```

**Step 2: Run to verify failure** — `node --test tests/command-args.test.ts` → FAIL (module not found).

**Step 3: Write `src/command-args.ts`**

```ts
import type { TgAction } from "./router.ts";

const PLAIN = new Set(["start", "help", "new", "sessions", "modelList", "thinkingList", "status", "stop", "compact", "killAsk"]);
const INDEX = new Set(["sessionActivate", "switchOk", "modelSet", "thinkingSet"]);

/**
 * Encode a TgAction as the argument string for a `/tg internal …` command.
 * Format: `internal <kind> <chatId> [arg]` where arg is a raw int (pair: fromId,
 * index kinds), 0/1 (kill/clear), or a JSON string (nameSet/prompt).
 * Returns null for actions that must not be dispatched as commands.
 */
export function encodeInternal(action: TgAction): string | null {
  switch (action.kind) {
    case "ignore":
    case "notAuthorized":
    case "unknown":
      return null;
    case "pair":
      return `internal pair ${action.chatId} ${action.fromId}`;
    case "nameSet":
      return `internal nameSet ${action.chatId} ${JSON.stringify(action.name)}`;
    case "prompt":
      return `internal prompt ${action.chatId} ${JSON.stringify(action.text)}`;
    case "kill":
      return `internal kill ${action.chatId} ${action.yes ? 1 : 0}`;
    case "clear":
      return `internal clear ${action.chatId} ${action.doIt ? 1 : 0}`;
    default: {
      const a = action as { kind: string; chatId: number; index?: number };
      return `internal ${a.kind} ${a.chatId}${INDEX.has(a.kind) ? ` ${a.index}` : ""}`;
    }
  }
}

/** Parse a `/tg` command handler arg string → TgAction. null if not a valid internal command. */
export function parseInternal(args: string): TgAction | null {
  const parts = args.trim().split(/\s+/);
  if (parts[0] !== "internal" || parts.length < 3) return null;
  const kind = parts[1];
  const chatId = Number(parts[2]);
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const rest = parts.slice(3).join(" ");
  if (PLAIN.has(kind)) return { kind: kind as TgAction["kind"], chatId } as TgAction;
  if (INDEX.has(kind)) {
    const i = Number(rest);
    if (!Number.isInteger(i) || i < 0) return null;
    return { kind: kind as TgAction["kind"], chatId, index: i } as TgAction;
  }
  switch (kind) {
    case "pair": {
      const fromId = Number(rest);
      if (!Number.isInteger(fromId) || fromId <= 0) return null;
      return { kind: "pair", chatId, fromId };
    }
    case "kill":
      if (rest !== "0" && rest !== "1") return null;
      return { kind: "kill", chatId, yes: rest === "1" };
    case "clear":
      if (rest !== "0" && rest !== "1") return null;
      return { kind: "clear", chatId, doIt: rest === "1" };
    case "nameSet":
    case "prompt": {
      try {
        const v: unknown = JSON.parse(rest);
        if (typeof v !== "string") return null;
        return kind === "nameSet" ? { kind, chatId, name: v } : { kind, chatId, text: v };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
```

**Step 4: Run to verify pass** — `node --test tests/command-args.test.ts` → `pass 3 / fail 0`; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/command-args.ts tests/command-args.test.ts
git commit -m "feat: internal command encode/parse for phone→terminal dispatch"
```

### Task 20: `src/wiring.ts` — `makeOut` + `makeTelegramPi` adapters

**TDD scenario:** New feature — full TDD cycle. The adapters live in `wiring.ts` (NOT `index.ts`) so they are pi-free and unit-testable; `wiring.ts` declares **local structural interfaces** (`PiLike`/`CtxLike`/`ClientLike`) that mirror pi 0.84.4’s surface — `index.ts` passes the real objects, which satisfy them structurally (method-syntax declarations keep assignability bivariant).

**Files:**
- Test: `tests/wiring.test.ts`
- Create: `src/wiring.ts`

**Step 1: Write the failing test `tests/wiring.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOut, makeTelegramPi, type CtxLike, type ClientLike, type PiLike } from "../src/wiring.ts";
import { TelegramState } from "../src/state.ts";

test("makeOut: send → addSent + persist, default parseMode HTML", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 777 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return true; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
  };
  const state = new TelegramState();
  let persists = 0;
  const out = makeOut(client, state, async () => { persists++; });
  const id = await out.send(7, "hello");
  assert.equal(id, 777);
  assert.deepEqual(state.sentIds(), [777]);
  assert.equal(persists, 1);
  assert.equal(calls[0][3], { parseMode: "HTML", replyToId: undefined, replyMarkup: undefined });
});

test("makeOut: explicit parseMode null survives; edit/delete passthrough", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async (chatId, text, opts) => { calls.push(["send", chatId, text, opts]); return { message_id: 1 }; },
    editMessageText: async (a, b, c, d) => { calls.push(["edit", a, b, c, d]); return false; },
    deleteMessage: async (a, b) => { calls.push(["del", a, b]); },
  };
  const out = makeOut(client, new TelegramState(), async () => {});
  await out.send(7, "plain", { parseMode: null });
  assert.equal(calls[0][3].parseMode, null);
  const edited = await out.edit(7, 8, "x", { parseMode: null });
  assert.equal(edited, false);
  assert.equal(calls[1][3].parseMode, null);
  await out.delete(7, 9);
  assert.deepEqual(calls[2], ["del", 7, 9]);
});

function makeFakeCtx(over: Partial<CtxLike> = {}): CtxLike {
  return {
    cwd: "/proj",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    abort: () => {},
    shutdown: () => {},
    compact: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    model: { id: "a", name: "A", provider: "p", reasoning: false },
    thinkingLevel: undefined,
    scopedModels: [{ model: { id: "a", name: "A", provider: "p", reasoning: false } }],
    modelRegistry: { getAvailable: () => [{ id: "a", name: "A", provider: "p", reasoning: false }, { id: "b", name: "B", provider: "p", reasoning: true }] },
    sessionManager: { getSessionFile: () => "/proj/s.jsonl", getSessionName: () => undefined, getBranch: () => [{ type: "message" }, { type: "custom" }, { type: "message" }] },
    ui: { notify: () => {} },
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    ...over,
  };
}

test("makeTelegramPi: sendPrompt now/steer mapping", () => {
  const sent: { text: string; opts?: unknown }[] = [];
  const pi: PiLike = {
    sendUserMessage: (text, opts) => { sent.push({ text, opts }); },
    setSessionName: () => {},
    getSessionName: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => {},
  };
  const t = makeTelegramPi({ pi, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  t.sendPrompt("hi", "now");
  assert.deepEqual(sent[0].opts, { expandPromptTemplates: true });
  t.sendPrompt("hi", "steer");
  assert.deepEqual(sent[1].opts, { deliverAs: "steer", expandPromptTemplates: true });
});

test("makeTelegramPi: session control goes to cmdCtx (preferred over sessionCtx)", async () => {
  let newCalls = 0;
  let switchCalls: string[] = [];
  const cmd = makeFakeCtx({ newSession: async () => { newCalls++; return { cancelled: false }; }, switchSession: async (p) => { switchCalls.push(p); return { cancelled: false }; } });
  const sess = makeFakeCtx({ newSession: async () => { newCalls += 100; return { cancelled: false }; } });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => cmd, getSessionCtx: () => sess, listSessions: async () => [] });
  t.newSession();
  t.switchSession("/x.jsonl");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newCalls, 1);
  assert.deepEqual(switchCalls, ["/x.jsonl"]);
});

test("makeTelegramPi: setModel scoped-first, registry fallback, unknown → false", async () => {
  let calledWith: string[] = [];
  const pi: PiLike = {
    sendUserMessage: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setModel: async (m) => { calledWith.push(m.id); return true; },
    setThinkingLevel: () => {},
  };
  const scopedB = { id: "b", name: "B", provider: "p", reasoning: true, thinkingLevelMap: { xhigh: "9000" } };
  const ctx = makeFakeCtx({ scopedModels: [scopedB], modelRegistry: { getAvailable: () => [{ id: "c", name: "C", provider: "p", reasoning: false }, scopedB] } });
  const t = makeTelegramPi({ pi, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(await t.setModel("b"), true);
  assert.equal(await t.setModel("c"), true);
  assert.equal(await t.setModel("zz"), false);
  assert.deepEqual(calledWith, ["b", "c"]);
});

test("makeTelegramPi: messageCount, contextUsage, cwd getter", () => {
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => makeFakeCtx(), getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(t.cwd, "/proj");
  assert.equal(t.messageCount(), 2);
  assert.deepEqual(t.contextUsage(), { tokens: 100, contextWindow: 1000, percent: 10 });
  assert.equal(t.currentSessionPath(), "/proj/s.jsonl");
  assert.equal(t.currentModel()?.id, "a");
});

test("makeTelegramPi: compact callbacks map to onDone(ok, detail)", () => {
  let onComplete: ((r: unknown) => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  const ctx = makeFakeCtx({ compact: (o) => { onComplete = o?.onComplete; onError = o?.onError; } });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  const results: [boolean, string?][] = [];
  t.compact((ok, detail) => results.push([ok, detail]));
  onComplete!({ summary: "summarized 12 msgs" });
  assert.deepEqual(results, [[true, "summarized 12 msgs"]]);
  t.compact((ok, detail) => results.push([ok, detail]));
  onError!(new Error("boom"));
  assert.deepEqual(results[1], [false, "boom"]);
});

test("makeTelegramPi: no ctx at all → safe defaults, no throw", () => {
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => undefined, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.equal(t.cwd, "");
  assert.equal(t.isIdle(), true);
  assert.throws(() => t.abort()); // no ctx → loud failure (bridge’s dispatch wrapper contains it)
  assert.equal(t.contextUsage(), undefined);
  assert.equal(t.messageCount(), 0);
  assert.equal(t.currentModel(), undefined);
  assert.deepEqual(t.allModels(), []);
});
```

> The last test intentionally asserts the **documented behavior**: with no context `abort()` throws `Error("no active pi context")` (fail loud rather than silently do nothing) — but `dispatch` in the bridge wraps every handler in try/catch, so a Telegram user can never crash the poll loop. Adjust the two `abort` lines if you choose a silent no-op instead — the bridge test in Task 13 (`dispatch: handler error`) already proves the wrapper.

**Step 2: Run to verify failure** — `node --test tests/wiring.test.ts` → FAIL (module not found).

**Step 3: Write `src/wiring.ts`**

```ts
import type { Out, TelegramPi, PiContextUsage, PiSessionInfo } from "./session-bridge.ts";
import type { PiModel, PiThinkingLevel } from "./thinking.ts";
import type { TelegramState } from "./state.ts";

// ── Local structural mirrors of pi 0.84.4 (keeps wiring.ts pi-free & testable) ──

export interface PiLike {
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setModel(model: PiModel): Promise<boolean>;
  setThinkingLevel(level: PiThinkingLevel): void;
}

export interface CtxLike {
  cwd: string;
  mode: string;
  hasUI: boolean;
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
  compact(options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model: PiModel | undefined;
  thinkingLevel?: string;
  scopedModels: readonly { model: PiModel; thinkingLevel?: string }[];
  modelRegistry: { getAvailable(): PiModel[] };
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    getBranch(): { type: string }[];
  };
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
}

export interface ClientLike {
  sendMessage(chatId: number, text: string, opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: { parseMode?: "HTML" | null; replyMarkup?: unknown }): Promise<boolean>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

// ── Out adapter: client + state tracking + persist ──

export function makeOut(client: ClientLike, state: TelegramState, persist: () => Promise<void>): Out {
  return {
    async send(chatId, text, opts) {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      const sent = await client.sendMessage(chatId, text, { parseMode, replyToId: opts?.replyToId, replyMarkup: opts?.replyMarkup });
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    edit: (chatId, messageId, text, opts) => {
      const parseMode: "HTML" | null = opts && opts.parseMode !== undefined ? opts.parseMode : "HTML";
      return client.editMessageText(chatId, messageId, text, { parseMode, replyMarkup: opts?.replyMarkup });
    },
    delete: (chatId, messageId) => client.deleteMessage(chatId, messageId),
  };
}

// ── TelegramPi adapter: pi + latest contexts → the bridge’s structural interface ──

export interface TelegramPiDeps {
  pi: PiLike;
  getCmdCtx(): CtxLike | undefined;
  getSessionCtx(): CtxLike | undefined;
  listSessions(cwd: string): Promise<PiSessionInfo[]>;
}

export function makeTelegramPi(deps: TelegramPiDeps): TelegramPi {
  const ctx = (): CtxLike | undefined => deps.getCmdCtx() ?? deps.getSessionCtx();
  const requireCtx = (): CtxLike => ctx() ?? (() => { throw new Error("no active pi context"); })();
  return {
    get cwd() {
      return ctx()?.cwd ?? "";
    },
    isIdle: () => ctx()?.isIdle() ?? true,
    abort: () => requireCtx().abort(),
    sendPrompt(text, deliverAs) {
      deps.pi.sendUserMessage(
        text,
        deliverAs === "steer"
          ? { deliverAs: "steer", expandPromptTemplates: true }
          : { expandPromptTemplates: true }
      );
    },
    newSession() {
      void requireCtx().newSession().catch(() => {});
    },
    switchSession(path) {
      void requireCtx().switchSession(path).catch(() => {});
    },
    waitForIdle: async () => {
      await requireCtx().waitForIdle();
    },
    compact(onDone) {
      requireCtx().compact({
        onComplete: (r) => {
          const s = (r as { summary?: string } | undefined)?.summary;
          onDone(true, s ?? "compacted");
        },
        onError: (e) => onDone(false, e.message),
      });
    },
    getSessionName: () => deps.pi.getSessionName(),
    setSessionName: (name) => deps.pi.setSessionName(name),
    currentModel: () => ctx()?.model,
    currentThinking: () => ctx()?.thinkingLevel as PiThinkingLevel | undefined,
    scopedModels: () => (ctx()?.scopedModels ?? []).map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel as PiThinkingLevel | undefined })),
    allModels: () => ctx()?.modelRegistry.getAvailable() ?? [],
    async setModel(id) {
      const scoped = (ctx()?.scopedModels ?? []).map((s) => s.model);
      const model = scoped.find((m) => m.id === id) ?? (ctx()?.modelRegistry.getAvailable() ?? []).find((m) => m.id === id);
      if (!model) return false;
      return deps.pi.setModel(model);
    },
    setThinkingLevel(level) {
      deps.pi.setThinkingLevel(level);
    },
    contextUsage: (): PiContextUsage | undefined => {
      const u = ctx()?.getContextUsage();
      if (!u) return undefined;
      return { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent };
    },
    messageCount: () => (ctx()?.sessionManager.getBranch() ?? []).filter((e) => e.type === "message").length,
    listSessions: () => deps.listSessions(ctx()?.cwd ?? ""),
    currentSessionPath: () => ctx()?.sessionManager.getSessionFile() ?? "",
    notifyUi(text, level) {
      ctx()?.ui.notify(text, level ?? "info");
    },
    shutdown: () => requireCtx().shutdown(),
  };
}
```

> `hasUI` appears in `CtxLike` because `index.ts` needs it for the TUI widget guard; the bridge never reads it.

**Step 4: Run to verify pass** — `node --test tests/wiring.test.ts` → `pass 7 / fail 0`; `npx tsc --noEmit` → clean.

**Step 5: Commit**

```bash
git add src/wiring.ts tests/wiring.test.ts
git commit -m "feat: pi adapters (Out over client, TelegramPi over pi + contexts)"
```

### Task 21: `index.ts` — the extension entry (wiring glue) + boundary test + smoke

**TDD scenario:** Thin glue over verified APIs — no behavior of its own. Verified by (a) a **boundary test** that mechanically enforces the module rule (only `index.ts` may reference the pi package), (b) `tsc --noEmit` (structural conformance to the real pi types), (c) a documented 5-minute manual smoke.

**Files:**
- Test: `tests/boundary.test.ts`
- Create: `index.ts`

**Step 1: Write the failing test `tests/boundary.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// built indirectly so this file itself doesn’t trip the scan
const PI_PKG = "@earendil-works/" + "pi-coding-agent";
const ROOT = join(import.meta.dirname, "..");

function scan(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts"));
}

for (const dir of ["src", "tests"]) {
  test(`module boundary: ${dir}/**/*.ts never reference the pi package`, () => {
    for (const f of scan(dir)) {
      const src = readFileSync(join(ROOT, dir, f), "utf8");
      assert.ok(!src.includes(PI_PKG), `${dir}/${f} must not import ${PI_PKG}`);
    }
  });
}

test("module boundary: index.ts IS the pi importer", () => {
  const src = readFileSync(join(ROOT, "index.ts"), "utf8");
  assert.ok(src.includes(PI_PKG));
  assert.match(src, /export default function/);
});
```

**Step 2: Run to verify failure** — `node --test tests/boundary.test.ts` → FAIL (`index.ts` missing).

**Step 3: Write `index.ts`**

```ts
import { join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, getBotToken } from "./src/config.ts";
import { TelegramClient, pollLoop } from "./src/telegram-client.ts";
import type { TgUpdate } from "./src/telegram-client.ts";
import { route } from "./src/router.ts";
import { encodeInternal, parseInternal } from "./src/command-args.ts";
import { TelegramState } from "./src/state.ts";
import { SessionBridge } from "./src/session-bridge.ts";
import type { Out, TelegramPi } from "./src/session-bridge.ts";
import { Mirror } from "./src/mirror.ts";
import type { MirrorMessage } from "./src/mirror.ts";
import { renderQr, tokenLooksValid, notAuthorizedText } from "./src/onboarding.ts";
import { makeOut, makeTelegramPi } from "./src/wiring.ts";

const CFG = { path: join(getAgentDir(), "pi-telegram.json") };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const listSessionsImpl = async (cwd: string) => {
  const infos = await SessionManager.list(cwd);
  return infos.map((i) => ({
    path: i.path,
    id: i.id,
    cwd: i.cwd,
    name: i.name,
    created: i.created.getTime(),
    modified: i.modified.getTime(),
    messageCount: i.messageCount,
    firstMessage: i.firstMessage,
  }));
};

export default function piTelegram(pi: ExtensionAPI): void {
  let cfg = loadConfig(CFG);
  let state: TelegramState | undefined;
  let bridge: SessionBridge | undefined;
  let client: TelegramClient | undefined;
  let out: Out | undefined;
  let piAdapter: TelegramPi | undefined;
  let ownerChatId: number | undefined;
  let cmdCtx: ExtensionCommandContext | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let stopping = false;
  let pollGen = 0;
  let pollPromise: Promise<void> | undefined;

  const persist = async (): Promise<void> => {
    await saveConfig(cfg, CFG);
  };

  const ui = (text: string, level: "info" | "warning" | "error" = "info"): void => {
    (sessionCtx ?? cmdCtx)?.ui.notify(text, level);
  };

  async function startPolling(): Promise<void> {
    const gen = ++pollGen;
    stopping = false;
    if (!state) return;
    const token = getBotToken(cfg, CFG);
    client = new TelegramClient(token ?? "", {});
    const outAdapter = makeOut(client, state, persist);
    out = outAdapter;
    piAdapter = makeTelegramPi({
      pi,
      getCmdCtx: () => cmdCtx,
      getSessionCtx: () => sessionCtx,
      listSessions: listSessionsImpl,
    });
    const deps = {
      pi: piAdapter,
      out: outAdapter,
      state,
      cfg,
      botUsername: undefined as string | undefined,
      persist,
      sleep,
    };
    bridge = new SessionBridge(deps);
    if (!token) {
      ui("pi-tg: no bot token — run /tg config <token>", "warning");
      return;
    }
    let username: string | undefined;
    try {
      username = (await client.getMe()).username;
    } catch (err) {
      ui(`pi-tg: getMe failed: ${String(err)}`, "error");
      return;
    }
    deps.botUsername = username;
    const mirror = new Mirror({ out: outAdapter, state, cfg, getChatId: () => ownerChatId, now: () => Date.now() });
    currentMirror = mirror;
    await pollLoop({
      client,
      getOffset: () => state!.getOffset(),
      setOffset: (n) => {
        state!.setOffset(n);
        cfg.lastOffset = n;
        void persist();
      },
      onUpdates: async (updates: TgUpdate[]) => {
        for (const u of updates) await handleUpdate(u);
      },
      onError: (err) => ui(`pi-tg poll error: ${String(err)}`, "error"),
      shouldStop: () => stopping || gen !== pollGen,
      sleep,
    });
  }

  let currentMirror: Mirror | undefined;

  async function handleUpdate(update: TgUpdate): Promise<void> {
    if (!bridge || !out || !state) return;
    const action = route(update, cfg.ownerId);
    if (action.kind === "ignore") return;
    const msg = update.message;
    if (msg && msg.from && cfg.ownerId !== undefined && msg.from.id === cfg.ownerId) {
      ownerChatId = msg.chat.id;
    }
    if (action.kind === "notAuthorized") {
      await out.send(action.chatId, notAuthorizedText(), { parseMode: null });
      return;
    }
    if (action.kind === "unknown") {
      await out.send(action.chatId, `I didn’t understand that — send /help for the command list.`, { parseMode: null });
      return;
    }
    if (action.kind === "prompt") {
      await bridge.dispatch(action);
      return;
    }
    const encoded = encodeInternal(action);
    if (encoded === null) return;
    pi.sendUserMessage(`/tg ${encoded}`, { expandPromptTemplates: true });
  }

  function cardLines(): string[] {
    const p = piAdapter;
    if (!p) return ["pi-tg: not ready yet"];
    const model = p.currentModel();
    const usage = p.contextUsage();
    const thinking = p.currentThinking();
    return [
      `📌 ${p.getSessionName() ?? "(unnamed session)"}`,
      `📁 ${p.cwd}`,
      `🤖 ${model?.name ?? "no model"}${thinking ? ` · thinking: ${thinking}` : ""}`,
      `💬 ${p.messageCount()} messages`,
      usage?.percent != null ? `🧠 ${usage.percent}% context` : "🧠 context: n/a",
      `📄 ${p.currentSessionPath()}`,
    ];
  }

  function showCard(ctx: ExtensionCommandContext): void {
    const lines = cardLines();
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-tg", lines);
    else ctx.ui.notify(lines.join("\n"), "info");
  }

  async function showQr(ctx: ExtensionCommandContext): Promise<void> {
    const token = getBotToken(cfg, CFG);
    if (!token) {
      ctx.ui.notify("pi-tg: no token yet — run /tg config <token>", "warning");
      return;
    }
    const c = client ?? new TelegramClient(token, {});
    try {
      const me = await c.getMe();
      const lines = renderQr(`https://t.me/${me.username}`);
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-tg-qr", lines);
      else ctx.ui.notify(`open https://t.me/${me.username} in Telegram`, "info");
    } catch (err) {
      ctx.ui.notify(`pi-tg: getMe failed: ${String(err)}`, "error");
    }
  }

  // ── terminal command ──

  pi.registerCommand("tg", {
    description: "Drive pi from Telegram — /tg (card) | /tg config <token> | /tg pair | /tg internal …",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      cmdCtx = ctx;
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "";
      if (sub === "internal") {
        const action = parseInternal(args.trim());
        if (action && bridge) await bridge.dispatch(action);
        else ctx.ui.notify("pi-tg: bad /tg internal payload", "error");
        return;
      }
      if (sub === "") {
        showCard(ctx);
        return;
      }
      if (sub === "config") {
        const token = parts.slice(1).join(" ").trim();
        if (!tokenLooksValid(token)) {
          ctx.ui.notify("pi-tg: invalid token (expected <digits>:<alnum/ -_>, e.g. 123456:AAH…)", "error");
          return;
        }
        cfg.botToken = token;
        await persist();
        const old = pollPromise;
        stopping = true;
        if (old) await old.catch(() => {});
        pollPromise = startPolling();
        void pollPromise;
        ctx.ui.notify("pi-tg: token saved, poller restarted. Run /tg pair to show the QR.", "info");
        return;
      }
      if (sub === "pair") {
        if (cfg.ownerId) {
          ctx.ui.notify(`pi-tg: already paired with owner ${cfg.ownerId}. Delete ${CFG.path} to re-pair.`, "info");
          return;
        }
        await showQr(ctx);
        return;
      }
      ctx.ui.notify("Usage: /tg | /tg config <token> | /tg pair", "info");
    },
  });

  // ── lifecycle ──

  pi.on("session_start", (event, ctx) => {
    sessionCtx = ctx;
    cfg = loadConfig(CFG);
    state = new TelegramState(cfg.lastOffset ?? 0);
    state.restoreSentIds(cfg.sentMessageIds ?? []);
    pollPromise = (async () => {
      await startPolling();
      const pa = cfg.pendingAction;
      if (pa && bridge) await bridge.onSessionReplaced(pa.chatId);
    })();
    void pollPromise;
  });

  pi.on("session_shutdown", () => {
    stopping = true;
  });

  // ── mirror events ──

  pi.on("agent_start", () => {
    void currentMirror?.onAgentStart();
  });
  pi.on("agent_end", (event) => {
    void currentMirror?.onAgentEnd(event.messages as unknown as MirrorMessage[]);
  });
  pi.on("message_start", (event) => {
    void currentMirror?.onAssistantStart(event.message as unknown as MirrorMessage);
  });
  pi.on("message_update", (event) => {
    void currentMirror?.onAssistantUpdate(event.message as unknown as MirrorMessage);
  });
  pi.on("message_end", (event) => {
    void currentMirror?.onAssistantEnd(event.message as unknown as MirrorMessage);
  });
  pi.on("tool_execution_start", (event) => {
    void currentMirror?.onToolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", (event) => {
    void currentMirror?.onToolEnd(event.toolCallId, event.isError);
  });
  pi.on("ui_prompt_start", (event) => {
    void currentMirror?.onUiPromptStart(event.title);
  });
}
```

**Step 4: Run to verify pass** — `npx tsc --noEmit` (proves structural conformance to the real pi types) → clean; `node --test` → ALL green (boundary + everything).

**Step 5: Manual smoke (5 min — do this before declaring the extension done)**

```bash
# 1. create a bot in Telegram (@BotFather → /newbot), copy the token
# 2. from this repo, in a project directory:
pi -e <abs-path-to>/pi-tg/index.ts
# 3. in pi’s TUI: /tg config <token>   → expect “token saved, poller restarted”
# 4. /tg pair                            → QR widget appears
# 5. on phone: scan QR → open t.me/<bot> → /start   → “✅ paired”
# 6. phone: “what is 2+2?”              → working msg → tool/status lines → ✅ Done + answer
# 7. phone: /status, /models, /thinking, /new, /sessions, /stop (mid-turn), /help
# 8. terminal: /tg                       → session card widget
```

Anything that fails → file it, debug with the systematic-debugging skill, fix in a new task.

**Step 6: Commit**

```bash
git add index.ts tests/boundary.test.ts
git commit -m "feat: extension entry (poller lifecycle, /tg command, event wiring, session replacement)"
```

**Checkpoint K:** `npx tsc --noEmit && node --test` → all green; boundary test enforces the pi-import rule; manual smoke passed (or failures filed).

---

## Phase 10 — README, CI, Final Verification

### Task 22: `README.md`

**TDD scenario:** Documentation task — no test; verified by re-reading against design §4 (command list) and `src/config.ts` (defaults).

**Files:** Create: `README.md`

**Step 1: Write `README.md`**

````markdown
# pi-tg

Drive your local **Pi Coding Agent** from your phone. pi-tg is a pi extension
that bridges a live TUI session to Telegram via Bot API long polling — phone and
terminal become co-clients of the same live session. No cloud relay; your code
never leaves your machine.

```
phone (Telegram) ⇄ Bot API long polling ⇄ pi-tg (in-process) ⇄ pi TUI session
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
2. Start pi with the extension: `pi -e /abs/path/to/pi-tg/index.ts`
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
| `/stop` | stop the current turn |
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

File: `~/.pi/agent/pi-telegram.json` (atomic writes; created on first `/tg config`).
Env `PI_TELEGRAM_BOT_TOKEN` overrides the stored token.

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
injected interfaces (`TelegramPi`, `Out`, `FetchLike`); `tests/boundary.test.ts`
enforces the rule mechanically.

| Module | Responsibility |
|---|---|
| `src/config.ts` | config load/save, env token override, sanitize (id cap, sent-ids cap) |
| `src/telegram-client.ts` | Bot API calls, 429 retry, poller loop + offset management |
| `src/markdown.ts` | markdown → Telegram HTML, chunking ≤ 4096, plain-text fallback |
| `src/thinking.ts` | `supportedThinkingLevels(model)` — mirror of pi’s selection logic (pure) |
| `src/router.ts` | update → typed action (pure) |
| `src/command-args.ts` | `/tg internal …` encode/parse (pure) |
| `src/session-bridge.ts` | all phone-command logic behind the `TelegramPi` interface |
| `src/mirror.ts` | pi events → Telegram (working msg, tool lines, finalize, cards) |
| `src/onboarding.ts` | QR rendering, token validation, pairing texts (pure) |
| `src/state.ts` | per-instance state: offset, sent ids, working/tool message ids |
| `src/wiring.ts` | `makeOut` / `makeTelegramPi` adapters (structural pi mirrors) |

## Known limitations (v1)

- One owner; private chats only (no groups).
- Text in, text out (no image/file input).
- No answer-callbacks — Telegram’s spinner dismisses itself.
- Session card omits the first-prompt snippet (it appears in `/sessions` lists).
- Polling stops when the TUI closes (by design).
````

**Step 2: Re-read check** — command tables must match design §4 exactly (no `/model`/`/quit`/`/abort`/`/history`/`/clear`); defaults must match `DEFAULTS` in `src/config.ts`.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README (setup, commands, config, security, dev guide)"
```

### Task 23: CI workflow + final verification

**TDD scenario:** CI gate + whole-repo verification pass.

**Files:** Create: `.github/workflows/ci.yml`

**Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: node --test
```

**Step 2: Full verification (run all, paste results in the PR/commit notes)**

```bash
npx tsc --noEmit     # → clean
node --test          # → every suite green (smoke, config, markdown, telegram-client,
                     #    router, state, onboarding, thinking, bridge-*, mirror-*,
                     #    command-args, wiring, boundary)
git log --oneline    # → ~25 small type-classified commits on feat/pi-tg-v1
```

**Step 3: Design coverage checklist** (design doc § → where it lives):

| Design section | Implementation |
|---|---|
| §1 goal / co-client architecture | `index.ts` (poller in-process, owner-only) |
| §2 module layout / boundary rule | file layout + `tests/boundary.test.ts` |
| §3 config / env / atomic writes / caps | `src/config.ts` + Task 3 tests |
| §3 polling / offset / 429 / 409 | `src/telegram-client.ts` + Tasks 7–9 tests |
| §4 phone commands | `src/router.ts` + `src/session-bridge.ts` (Tasks 10, 13–15) |
| §4 working msg / tools / streaming / chunked final | `src/mirror.ts` (Tasks 16–18) |
| §4 markdown → HTML, 4096 chunking, plain fallback | `src/markdown.ts` (Tasks 4–6) |
| §4 pairing / QR / allowlist | `src/onboarding.ts` + Task 12 tests |
| §5 session replace / pendingAction / offset persistence | `index.ts` session_start/shutdown + bridge `onSessionReplaced` |
| §5 session cards / `/sessions` list | bridge handlers (Task 14) + `/tg` card in `index.ts` |
| §6 security (owner-only, local-only, kill confirm) | router allowlist + `/tg` command + README §Security |
| §7 non-goals (no groups/images/server) | README §Known limitations |

If any row has no implementation → file a follow-up issue before merging.

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: type gate + full test suite on Node 26"
```

---

## Done

All 23 tasks complete. The branch `feat/pi-tg-v1` should now contain the full
extension: 11 source modules + entry point, 17 test files, README, and CI —
with `npx tsc --noEmit && node --test` green at every checkpoint.
