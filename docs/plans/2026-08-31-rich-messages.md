# Rich Messages Switch — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Send LLM answers as native Bot API Rich Messages: one rich draft per turn
(streaming + tool status + native Stop button), finalized via `sendRichMessage`,
with automatic fallback to the legacy HTML path.

**Architecture:** The Mirror keeps a single ephemeral rich draft per agent turn
(same `draft_id`, heartbeat every `draftHeartbeatMs`); draft content = latest
assistant text (long fences folded into `<details>`, tail-viewed at `RICH_CAP`)
plus a tool-status footer. Finalization tries `sendRichMessage(markdown)` →
legacy `chunkMarkdown`+HTML (4096) → `toPlainText`. All new content code is
additive in `src/markdown.ts`; the legacy converter is untouched (it is the
fallback).

**Tech Stack:** Node ≥ 22.18 native TS type-stripping, `node --test` (node:test),
zero runtime deps, Bot API 10.2/10.3.

**Design doc (validated):** `docs/plans/2026-08-31-rich-messages-design.md` —
read it first; this plan implements it without deviation.

## Context

- Repo: `c:/tmp/pi-telega`, branch `feat/pi-telega-v1`.
- Run all tests: `node --test` (from repo root). Single file:
  `node --test tests/markdown.test.ts`.
- **Type gate:** `npx tsc --noEmit` (strict, erasable-TS) — run it before every
  commit; it catches interface drift that runtime type-stripping ignores.
- Key files:
  - `src/telegram-client.ts` — Bot API wrapper; `call()` handles 429 retry and
    `TgError(method, code, description)`.
  - `src/router.ts` — pure `route(update, ownerId) → TgAction`; `CB` callback
    vocabulary.
  - `src/session-bridge.ts` — `Out` interface (send/edit/delete primitives) and
    command handling.
  - `src/wiring.ts` — `makeOut(ClientLike, state, persist) → Out`; `ClientLike`
    is a structural mirror of the client.
  - `src/mirror.ts` — per-turn agent-event mirroring (the file being rewritten).
  - `src/markdown.ts` — legacy converter (untouched) + new rich functions.
  - `src/config.ts` — `DEFAULTS` + `sanitize()` pattern.
  - `src/state.ts` — `TelegaState` (working/tool-msg fields being deleted).
  - `index.ts` — extension entry; constructs `Mirror` with deps.
  - Test fakes: `tests/fake-pi.ts` (`FakeOut`, `FakePi`),
    `tests/fake-fetch.ts` (`makeFakeFetch`), `tests/mirror-helpers.ts`
    (`makeMirrorDeps` with injectable clock), `tests/helpers.ts` (bridge deps).
- Bot API facts used by this plan (verified against the live reference):
  - `sendRichMessage(chat_id, rich_message, reply_to_message?)` → `Message`.
  - `sendRichMessageDraft(chat_id, draft_id, rich_message, can_stop?)` → `True`;
    draft is ephemeral ~30 s; re-send with **same `draft_id`** resets the window;
    any other bot message kills the draft; `can_stop: true` → user Stop →
    `stopped_message_generation` update:
    `{ chat: Chat, message_thread_id?: Integer, draft_id: Integer }`.
  - `InputRichMessage` = exactly one of `markdown` | `html` | `blocks` (+
    `is_rtl?`, `skip_entity_detection?`). We use `markdown` only.
  - Rich limit: 32768 UTF-8 characters (semantics pinned by Task 0 spike).
- Conventions: commit after every task (`git add <files> && git commit -m …`);
  one task = one commit (Task 0 is manual, no commit unless it changes code).

## Phases

- **Phase A — foundation:** Tasks 0–4 (spike, config, client, router, Out).
  Checkpoint: `node --test` green + `npx tsc --noEmit` clean.
- **Phase B — content pipeline:** Tasks 5–8 (richUnits, fold, chunk, tail view).
  Checkpoint: `node --test` green + `npx tsc --noEmit` clean.
- **Phase C — mirror & wiring:** Tasks 9–11 (mirror rewrite, state trim,
  README/verification). Checkpoint: full suite + type gate + manual smoke list.

---

## Phase A — foundation

### Task 0: Manual spike — pin RICH_CAP semantics, tg-thinking text, entity detection

**TDD scenario:** Trivial change — manual verification, no TDD. No commit unless a
constant changes (then amend Task 5's value).

**Files:**
- Create (throwaway, delete after): `scratch/spike-rich.mjs`
- Modify (only if results differ): `src/markdown.ts` `RICH_CAP` (Task 5),
  `src/mirror.ts` thinking label (Task 9)

**Step 1: Create a throwaway bot** (or reuse a spare token) via @BotFather; get
`<TOKEN>` and your own numeric chat id (e.g. via getUpdates after sending the bot
a message).

**Step 2: Write `scratch/spike-rich.mjs`**

```js
const TOKEN = process.env.SPIKE_TOKEN;
const CHAT = Number(process.env.SPIKE_CHAT);
const api = (m, p) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

const n = Number(process.env.N ?? 32768);
const ch = process.env.CH ?? "a"; // "a" | "🎉"
const rich = { markdown: ch.repeat(n) };

const s = ch.repeat(n);
const t1 = await api("sendRichMessage", { chat_id: CHAT, rich_message: rich });
console.log(
  `T1 n=${n} ch="${ch}" jsUnits=${s.length} codePoints=[...s].length bytes=${Buffer.byteLength(s)}`,
  `→ HTTP ${t1.status}`, t1.json.ok ? "OK" : `FAIL: ${t1.json.description}`,
);

const d1 = await api("sendRichMessageDraft", { chat_id: CHAT, draft_id: 1, rich_message: { markdown: `<tg-thinking>working…</tg-thinking>` }, can_stop: true });
console.log("T6 draft+tg-thinking →", d1.status, d1.json.ok ? "OK (look at the phone, screenshot the label)" : `FAIL: ${d1.json.description}`);
```

**Step 3: Run the matrix** (replace token/chat) and record results:

```bash
N=32768 CH=a    node scratch/spike-rich.mjs   # expect OK  (documented limit, ASCII: all three units coincide)
N=32769 CH=a    node scratch/spike-rich.mjs   # expect FAIL 400 (boundary)
N=32768 CH=🎉   node scratch/spike-rich.mjs   # OK  → limit is NOT bytes (131 072 bytes)
                                     # FAIL → limit is bytes; real cap ≈ 8192 emoji
```

**Step 4: Decide `RICH_CAP`** = measured ceiling − margin, and note it here:
`RICH_CAP = ______` (default assumption: 32 000 code points).

**Step 5: Draft behavior** — with the T6 draft visible, (a) press its Stop
button and confirm a `stopped_message_generation` update arrives (check the bot's
`getUpdates` once, or just trust the design doc — owner already verified the
timer-reset), (b) screenshot the `<tg-thinking>` label and record the label text
used in Task 10 (default: `working…`).

**Step 6: Entity detection** — send via the script (extend T1 with
`markdown: "phone +1 (555) 000-1234 and http://example.com"`): do the number/URL
get linked? Then send one more with the same values *inside a ``` fence*: do they
get linkified inside code? If yes and it looks bad, add
`skip_entity_detection: true` to `sendRich`/`sendDraft` (Task 4) — record choice.

**Step 7: Clean up** — `rm scratch/spike-rich.mjs`; delete the spike messages
from the chat. Update `RICH_CAP` below if the spike contradicts 32 000.

---

### Task 1: Config fields `draftHeartbeatMs` + `codeFoldLines`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/config.ts` (interface, `DEFAULTS`, `sanitize`)
- Modify: `tests/helpers.ts` (bridge-deps cfg literal — type gate will flag it)
- Test: `tests/config.test.ts` (append two tests)

**Step 1: Write the failing tests** — append to `tests/config.test.ts`:

```ts
test("sanitize: draftHeartbeatMs default 17000, valid 5000..25000 kept, out-of-range → default", () => {
  assert.equal(sanitize({}).draftHeartbeatMs, 17000);
  assert.equal(sanitize({ draftHeartbeatMs: 6000 }).draftHeartbeatMs, 6000);
  assert.equal(sanitize({ draftHeartbeatMs: 1000 }).draftHeartbeatMs, 17000); // below min → default
  assert.equal(sanitize({ draftHeartbeatMs: 99_999 }).draftHeartbeatMs, 17000); // above max → default
});

test("sanitize: codeFoldLines default 25, valid 5..500 kept, out-of-range → default", () => {
  assert.equal(sanitize({}).codeFoldLines, 25);
  assert.equal(sanitize({ codeFoldLines: 40 }).codeFoldLines, 40);
  assert.equal(sanitize({ codeFoldLines: 2 }).codeFoldLines, 25); // below min → default
  assert.equal(sanitize({ codeFoldLines: "x" }).codeFoldLines, 25); // not a number → default
});
```

(`clampInt` semantics: a number outside `[min, max]` is dropped to the
default, not clamped to the edge — same as the existing `streamEditMs`
handling.)

**Step 2: Run to verify failure**

Run: `node --test tests/config.test.ts`
Expected: the two new tests FAIL (`draftHeartbeatMs`/`codeFoldLines` undefined);
old tests pass.

**Step 3: Implement** — `src/config.ts`:

(a) In `TelegaConfig`, after `maxSessionList: number;` add:

```ts
  /** Re-send cadence of the rich draft (keeps the ~30 s ephemeral window alive). */
  draftHeartbeatMs: number;
  /** Code fences with a body of more than this many lines are wrapped in a closed <details>. */
  codeFoldLines: number;
```

(b) In `DEFAULTS`, extend the `Pick<...>` key list with
`"draftHeartbeatMs" | "codeFoldLines"` and add the values:

```ts
  draftHeartbeatMs: 17_000,
  codeFoldLines: 25,
```

(c) In `sanitize()`, after the `maxSessionList` line add:

```ts
    draftHeartbeatMs: clampInt(obj.draftHeartbeatMs, DEFAULTS.draftHeartbeatMs, 5_000, 25_000),
    codeFoldLines: clampInt(obj.codeFoldLines, DEFAULTS.codeFoldLines, 5, 500),
```

(d) `tests/helpers.ts`: in `makeDeps`' cfg literal (the one starting
`botToken: "t"`), add the two fields so the type gate stays clean:

```ts
      draftHeartbeatMs: 17_000,
      codeFoldLines: 25,
```

**Step 4: Run tests + type gate**

Run: `node --test tests/config.test.ts && npx tsc --noEmit`
Expected: all config tests PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/helpers.ts
git commit -m "feat(config): draftHeartbeatMs (17s) + codeFoldLines (25) fields"
```

---

### Task 2: `telegram-client.ts` — rich methods + types

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/telegram-client.ts`
- Test: `tests/telegram-client.test.ts` (append tests)

**Step 1: Write the failing tests** — append to `tests/telegram-client.test.ts`:

Also UPDATE the existing test `"getUpdates: offset, timeout, allowed_updates"`
— its expected body becomes:

```ts
  assert.deepEqual(body, { offset: 42, timeout: 30, allowed_updates: ["message", "callback_query", "edited_message", "stopped_message_generation"] });
```

(without `stopped_message_generation` in `allowed_updates` the bot NEVER
receives that update type — long polling filters by the list we send).

```ts
test("sendRichMessage: rich_message param, optional reply_to_message", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 9, chat: { id: 7, type: "private" }, date: 1 } } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  const msg = await c.sendRichMessage(7, { markdown: "| a | b |" }, { replyToId: 4 });
  assert.equal(msg.message_id, 9);
  assert.equal(ff.calls[0].url, "https://api.telegram.org/botT/sendRichMessage");
  const body = JSON.parse(String(ff.calls[0].init?.body ?? "{}"));
  assert.deepEqual(body, { chat_id: 7, rich_message: { markdown: "| a | b |" }, reply_to_message: { message_id: 4 } });
});

test("sendRichMessageDraft: draft_id + can_stop only when true; omitted when falsy", async () => {
  const ff = makeFakeFetch(() => ({ status: 200, body: { ok: true, result: true } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  assert.equal(await c.sendRichMessageDraft(7, 3, { markdown: "x" }, true), true);
  assert.deepEqual(JSON.parse(String(ff.calls[0].init?.body)), { chat_id: 7, draft_id: 3, rich_message: { markdown: "x" }, can_stop: true });
  assert.equal(await c.sendRichMessageDraft(7, 4, { markdown: "y" }), true);
  const body2 = JSON.parse(String(ff.calls[1].init?.body));
  assert.equal("can_stop" in body2, false);
  assert.equal(body2.draft_id, 4);
});

test("sendRichMessage: 400 surfaces as TgError (fallback trigger)", async () => {
  const ff = makeFakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: rich message parse error" } }));
  const c = new TelegramClient("T", { fetchImpl: ff.fetchImpl });
  await assert.rejects(c.sendRichMessage(7, { markdown: "<broken" }), (e: unknown) => e instanceof TgError && e.code === 400);
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/telegram-client.test.ts`
Expected: the 3 new tests FAIL (`sendRichMessage is not a function`); old tests pass.

**Step 3: Implement** — `src/telegram-client.ts`:

(a) Types — after `TgSentMessage` add:

```ts
/** One of markdown | html | blocks (exactly one); we use markdown only. */
export interface InputRichMessage {
  markdown?: string;
  html?: string;
  blocks?: unknown[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

export interface MessageGenerationStopped {
  chat: TgChat;
  message_thread_id?: number;
  draft_id: number;
}
```

and extend `TgUpdate`:

```ts
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  stopped_message_generation?: MessageGenerationStopped;
}
```

(b) Methods — after `answerCallbackQuery` in `TelegramClient` add:

```ts
  sendRichMessage(
    chatId: number,
    richMessage: InputRichMessage,
    opts?: { replyToId?: number },
  ): Promise<TgSentMessage> {
    const p: Record<string, unknown> = { chat_id: chatId, rich_message: richMessage };
    if (opts?.replyToId) p.reply_to_message = { message_id: opts.replyToId };
    return this.call("sendRichMessage", p) as Promise<TgSentMessage>;
  }

  sendRichMessageDraft(
    chatId: number,
    draftId: number,
    richMessage: InputRichMessage,
    canStop?: boolean,
  ): Promise<boolean> {
    const p: Record<string, unknown> = { chat_id: chatId, draft_id: draftId, rich_message: richMessage };
    if (canStop) p.can_stop = true;
    return this.call("sendRichMessageDraft", p) as Promise<boolean>;
  }
```

(c) `getUpdates` — subscribe to the new update type:

```ts
  getUpdates(offset: number, timeoutSec = 50): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query", "edited_message", "stopped_message_generation"] }) as Promise<TgUpdate[]>;
  }
```

**Step 4: Run tests + type gate**

Run: `node --test tests/telegram-client.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat(client): sendRichMessage + sendRichMessageDraft + stopped_message_generation type"
```

---

### Task 3: `router.ts` — `stopped_message_generation` → stop action

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/router.ts`
- Test: `tests/router.test.ts` (append a test)

**Step 1: Write the failing test** — append to `tests/router.test.ts`:

```ts
test("stopped_message_generation → stop (the draft's native Stop button)", () => {
  const a = route(
    { update_id: 9, stopped_message_generation: { chat: { id: 55, type: "private" }, draft_id: 3 } },
    42,
  );
  assert.deepEqual(a, { kind: "stop", chatId: 55 });
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/router.test.ts`
Expected: the new test FAILS (action is `{ kind: "ignore" }` — no message/cb field).

**Step 3: Implement** — `src/router.ts`, at the very top of `route()`
(before `const cb = update.callback_query;`):

```ts
  const stopped = update.stopped_message_generation;
  if (stopped) return { kind: "stop", chatId: stopped.chat.id };
```

No new action kind: the bridge's existing `stop` case (idle check → `pi.abort()`
+ "⏹ Stopping…") is exactly the desired behavior.

**Step 4: Run tests + type gate**

Run: `node --test tests/router.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat(router): stopped_message_generation → stop action"
```

---

### Task 4: `Out` surface — `sendRich` + `sendDraft` (wiring, FakeOut)

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/session-bridge.ts` (`Out` interface)
- Modify: `src/wiring.ts` (`ClientLike` + `makeOut`)
- Modify: `tests/fake-pi.ts` (`FakeOutCall` + `FakeOut`)
- Test: `tests/wiring.test.ts` (append two tests)

**Step 1: Write the failing tests** — append to `tests/wiring.test.ts`:

```ts
test("makeOut: sendRich → client.sendRichMessage + addSent + persist", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async (chatId, rich) => { calls.push(["rich", chatId, rich]); return { message_id: 888 }; },
    sendRichMessageDraft: async () => true,
  };
  const state = new TelegaState();
  const out = makeOut(client, state, async () => {});
  const id = await out.sendRich(7, "a table");
  assert.equal(id, 888);
  assert.deepEqual(state.sentIds(), [888]);
  assert.deepEqual(calls[0], ["rich", 7, { markdown: "a table" }]);
});

test("makeOut: sendDraft → passthrough (draftId + canStop), no addSent", async () => {
  const calls: unknown[][] = [];
  const client: ClientLike = {
    sendMessage: async () => { throw new Error("unexpected"); },
    editMessageText: async () => true,
    deleteMessage: async () => {},
    sendRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async (chatId, draftId, rich, canStop) => { calls.push(["draft", chatId, draftId, rich, canStop]); return true; },
  };
  const state = new TelegaState();
  const out = makeOut(client, state, async () => {});
  assert.equal(await out.sendDraft(7, 3, "working", true), true);
  assert.deepEqual(calls[0], ["draft", 7, 3, { markdown: "working" }, true]);
  assert.deepEqual(state.sentIds(), []);
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/wiring.test.ts`
Expected: the 2 new tests FAIL (`out.sendRich is not a function`); old tests pass.

**Step 3: Implement**

(a) `src/session-bridge.ts` — in `Out`, after the `delete` line add:

```ts
  /** Rich message (markdown pass-through); records the sent id; returns it. */
  sendRich(chatId: number, md: string): Promise<number | undefined>;
  /** Ephemeral draft; same draftId refreshes in place. */
  sendDraft(chatId: number, draftId: number, md: string, canStop?: boolean): Promise<boolean>;
```

(b) `src/wiring.ts` — extend `ClientLike`:

```ts
  sendRichMessage(chatId: number, rich: { markdown?: string }): Promise<{ message_id: number }>;
  sendRichMessageDraft(chatId: number, draftId: number, rich: { markdown?: string }, canStop?: boolean): Promise<boolean>;
```

and in `makeOut`, after `delete: …` add:

```ts
    sendRich: async (chatId, md) => {
      const sent = await client.sendRichMessage(chatId, { markdown: md });
      state.addSent(sent.message_id);
      await persist();
      return sent.message_id;
    },
    sendDraft: (chatId, draftId, md, canStop) =>
      client.sendRichMessageDraft(chatId, draftId, { markdown: md }, canStop),
```

Note: the real `TelegramClient` already satisfies the extended `ClientLike`
(Task 2) — `index.ts` needs no change in this task.

(b2) `tests/wiring.test.ts` — the two EXISTING tests build `ClientLike`
literals without the new methods; the type gate will flag both. Add these two
stub lines to each existing literal (after the `deleteMessage` line):

```ts
    sendRichMessage: async () => { throw new Error("unexpected"); },
    sendRichMessageDraft: async () => true,
```

(c) `tests/fake-pi.ts` — extend `FakeOutCall`:

```ts
export interface FakeOutCall {
  kind: "send" | "edit" | "delete" | "sendRich" | "sendDraft";
  chatId: number;
  messageId?: number;
  text?: string;
  opts?: { parseMode?: "HTML" | null; replyToId?: number; replyMarkup?: unknown };
  draftId?: number;
  canStop?: boolean;
}
```

and in `FakeOut` add:

```ts
  sendRichFailsWith: Error | undefined;
  sendRich = async (chatId: number, md: string): Promise<number | undefined> => {
    if (this.sendRichFailsWith) throw this.sendRichFailsWith;
    this.calls.push({ kind: "sendRich", chatId, text: md });
    return this.nextMessageId++;
  };
  sendDraft = async (chatId: number, draftId: number, md: string, canStop?: boolean): Promise<boolean> => {
    this.calls.push({ kind: "sendDraft", chatId, text: md, draftId, canStop });
    return true;
  };
```

**Step 4: Run tests + type gate**

Run: `node --test && npx tsc --noEmit`   (full suite: FakeOut is shared by bridge/mirror tests)
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/session-bridge.ts src/wiring.ts tests/fake-pi.ts tests/wiring.test.ts
git commit -m "feat(out): sendRich/sendDraft on the Out surface + fakes"
```

**Phase A checkpoint:** `node --test` green, `npx tsc --noEmit` clean.

---

## Phase B — content pipeline (all in `src/markdown.ts`, additive; legacy code untouched)

### Task 5: `RICH_CAP` + `richUnits(md)` — top-level block parse

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/markdown.ts` (append at the end — do NOT touch the legacy section)
- Test: `tests/markdown.test.ts` (append tests)

**Step 1: Write the failing tests** — append to `tests/markdown.test.ts`:

```ts
// ── rich pipeline (Bot API 10.2) ──

test("RICH_CAP: exported number with margin under the documented 32768", () => {
  assert.ok(RICH_CAP >= 16_000 && RICH_CAP < 32_768, `RICH_CAP=${RICH_CAP}`);
});

test("richUnits: paragraph / heading / fence / list / table / blank handling", () => {
  const md = [
    "# Title", "", "Para one", "", "- a", "- b", "",
    "| h1 | h2 |", "| --- | --- |", "| v1 | v2 |", "",
    "```js", "const x = 1;", "```", "", "tail para",
  ].join("\n");
  const u = richUnits(md);
  assert.deepEqual(u.map((x) => x.type), ["heading", "paragraph", "list", "table", "fence", "paragraph"]);
  assert.equal(u[0].text, "# Title");
  assert.equal(u[1].text, "Para one");
  assert.equal(u[2].text, "- a\n- b");
  assert.equal(u[3].text, "| h1 | h2 |\n| --- | --- |\n| v1 | v2 |");
  assert.equal(u[4].text, "```js\nconst x = 1;\n```");
  assert.equal(u[5].text, "tail para");
});

test("richUnits: adjacent paragraph lines merge; blank lines separate", () => {
  const u = richUnits("l1\nl2\n\nl3");
  assert.deepEqual(u.map((x) => x.text), ["l1\nl2", "l3"]);
});

test("richUnits: unclosed fence (streaming) → single fence unit to EOF", () => {
  const u = richUnits("before\n\n```py\nprint(1)\nprint(2)");
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "fence"]);
  assert.equal(u[1].text, "```py\nprint(1)\nprint(2)");
});

test("richUnits: table needs a separator row after the header", () => {
  const u = richUnits("| a | b |\n\ntext"); // no separator → not a table (two plain paragraphs)
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "paragraph"]);
  assert.equal(u[0].text, "| a | b |");
});

test("richUnits: <details> region → one details unit", () => {
  const md = "a\n\n<details><summary>more</summary>\n\ninner text\n\n</details>\n\nb";
  const u = richUnits(md);
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "details", "paragraph"]);
  assert.ok(u[1].text.startsWith("<details>"));
  assert.ok(u[1].text.endsWith("</details>"));
  assert.ok(u[1].text.includes("inner text"));
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/markdown.test.ts`
Expected: the new tests FAIL (import errors for `RICH_CAP`/`richUnits`); old tests pass.

**Step 3: Implement** — append to `src/markdown.ts`:

```ts
// ─────────────────────────── Rich pipeline (Bot API 10.2+) ───────────────────────────

/** Internal rich-message cap (documented: 32768 UTF-8 chars; margin pending Task 0 spike). */
export const RICH_CAP = 32_000;

export type RichUnitType = "fence" | "table" | "heading" | "list" | "blockquote" | "hr" | "details" | "paragraph";

export interface RichUnit {
  type: RichUnitType;
  text: string; // verbatim markdown of the block
}

const isTableRow = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
};
const isTableSep = (line: string): boolean => line.includes("-") && /^[\s|:-]+$/.test(line.trim());
const DETAILS_OPEN_RE = /^\s*<details>/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>/i;

/**
 * Top-level block parse (verbatim — no rendering). Powers folding, chunking and
 * the tail view. One implementation; the legacy converter is untouched.
 */
export function richUnits(md: string): RichUnit[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const units: RichUnit[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) { units.push({ type: "paragraph", text: para.join("\n") }); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushPara();
      const buf: string[] = [line];
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; } // consume close (EOF = still streaming)
      units.push({ type: "fence", text: buf.join("\n") });
      continue;
    }
    if (DETAILS_OPEN_RE.test(line)) {
      flushPara();
      const buf: string[] = [line];
      i++;
      while (i < lines.length && !DETAILS_CLOSE_RE.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      units.push({ type: "details", text: buf.join("\n") });
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    if (HEADING_RE.test(line) || HR_RE.test(line)) {
      flushPara();
      units.push({ type: HR_RE.test(line) ? "hr" : "heading", text: line });
      i++;
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && (UL_RE.test(lines[i]) || OL_RE.test(lines[i]))) { buf.push(lines[i]); i++; }
      units.push({ type: "list", text: buf.join("\n") });
      continue;
    }
    if (BQ_RE.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && BQ_RE.test(lines[i])) { buf.push(lines[i]); i++; }
      units.push({ type: "blockquote", text: buf.join("\n") });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const buf: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { buf.push(lines[i]); i++; }
      units.push({ type: "table", text: buf.join("\n") });
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return units;
}
```

**Step 4: Run tests + type gate**

Run: `node --test tests/markdown.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat(markdown): RICH_CAP + richUnits top-level block parse"
```

---

### Task 6: `foldLongFences(md, foldLines)` — auto-`<details>` for long code

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/markdown.ts` (append)
- Test: `tests/markdown.test.ts` (append tests)

**Step 1: Write the failing tests** — append to `tests/markdown.test.ts`:

```ts
const fenceOf = (n: number, lang = "") =>
  [lang ? "```" + lang : "```", ...Array.from({ length: n }, (_, i) => `line${i}`), "```"].join("\n");

test("foldLongFences: short fence (≤ N lines) untouched", () => {
  const md = `intro\n\n${fenceOf(5)}\n\noutro`;
  assert.equal(foldLongFences(md, 25), md);
});

test("foldLongFences: exactly N lines → untouched; N+1 → wrapped", () => {
  assert.equal(foldLongFences(fenceOf(25), 25), fenceOf(25));
  assert.ok(foldLongFences(fenceOf(26), 25).startsWith("<details>"));
});

test("foldLongFences: wraps with summary (line count + language), fence intact inside", () => {
  const out = foldLongFences(fenceOf(30, "python"), 25);
  assert.ok(out.startsWith("<details><summary>code, python (30 lines)</summary>"), out.slice(0, 80));
  assert.ok(out.includes("```python"));
  assert.ok(out.trimEnd().endsWith("</details>"));
  assert.ok(out.includes("line0") && out.includes("line29"));
});

test("foldLongFences: no language → plain summary", () => {
  const out = foldLongFences(fenceOf(30), 25);
  assert.ok(out.startsWith("<details><summary>code (30 lines)</summary>"));
});

test("foldLongFences: multiple fences, only the long one wrapped", () => {
  const md = `${fenceOf(3)}\n\ntext\n\n${fenceOf(40, "ts")}`;
  const out = foldLongFences(md, 25);
  assert.equal((out.match(/<details>/g) ?? []).length, 1);
  assert.ok(out.includes("code, ts (40 lines)"));
});

test("foldLongFences: unclosed long fence (streaming) also wrapped", () => {
  const md = ["```js", ...Array.from({ length: 30 }, (_, i) => `x${i}`)].join("\n");
  const out = foldLongFences(md, 25);
  assert.ok(out.startsWith("<details><summary>code, js (30 lines)</summary>"));
  assert.ok(out.includes("</details>"));
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/markdown.test.ts`
Expected: the new tests FAIL (`foldLongFences is not a function`); old tests pass.

**Step 3: Implement** — append to `src/markdown.ts`:

```ts
/**
 * Wrap fenced blocks whose body has more than `foldLines` lines in a closed
 * <details> (the markdown tier parses markdown inside details bodies, so the
 * fence still renders as a preformatted block). Short fences pass verbatim.
 */
export function foldLongFences(md: string, foldLines = 25): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (!fence) { out.push(line); i++; continue; }
    const buf: string[] = [line];
    const closeRe = fenceCloseRe(fence[1]);
    i++;
    let closed = false;
    while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
    if (i < lines.length) { buf.push(lines[i]); i++; closed = true; }
    const body = buf.slice(1, closed ? buf.length - 1 : buf.length);
    if (body.length > foldLines) {
      const lang = fence[2] ?? "";
      const summary = `code${lang ? `, ${lang}` : ""} (${body.length} lines)`;
      out.push(`<details><summary>${summary}</summary>`, "", ...buf, "", "</details>");
    } else {
      out.push(...buf);
    }
  }
  return out.join("\n");
}
```

**Step 4: Run tests + type gate**

Run: `node --test tests/markdown.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat(markdown): foldLongFences — long code into closed <details>"
```

---

### Task 7: `chunkRich(md, cap)` — block-boundary packing + per-type inner splits

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/markdown.ts` (append)
- Test: `tests/markdown.test.ts` (append tests)

**Step 1: Write the failing tests** — append to `tests/markdown.test.ts`:

```ts
const CAP = 200; // small cap so the tests stay readable; packing logic is cap-agnostic

test("chunkRich: small doc → one chunk, no marker", () => {
  assert.deepEqual(chunkRich("hello\n\nworld"), ["hello\n\nworld"]);
});

test("chunkRich: marker from chunk 2; all chunks ≤ cap; no unit split across chunks", () => {
  const md = ["# Head", "p1", "p2", "p3"].join("\n\n").replace(/p(\d)/g, (_m, d) => "x".repeat(70) + d);
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= CAP, `chunk ${c.length} > ${CAP}`);
  assert.ok(!chunks[0].startsWith("(continued)"));
  for (const c of chunks.slice(1)) assert.ok(c.startsWith("(continued)\n"));
  // reassembled content (minus markers, newlines normalized) equals the source
  const norm = (s: string) => s.replace(/\n+/g, "\n");
  const joined = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  assert.equal(norm(joined), norm(md));
});

test("chunkRich: oversized fence re-emitted per chunk WITH language; all lines preserved", () => {
  const body = Array.from({ length: 30 }, (_, i) => `l${i} ` + "x".repeat(10)).join("\n");
  const md = "```python\n" + body + "\n```";
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.startsWith("```python\n"), JSON.stringify(c.slice(0, 40)));
    assert.ok(c.trimEnd().endsWith("```"));
    assert.ok(c.length <= CAP);
  }
  const all = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  for (let i = 0; i < 30; i++) assert.ok(all.includes(`l${i} `), `line ${i} lost`);
});

test("chunkRich: oversized table keeps header+separator in every piece; rows preserved", () => {
  const header = "| col-a | col-b |";
  const sep = "| --- | --- |";
  const rows = Array.from({ length: 20 }, (_, i) => `| row-${i} | ${"y".repeat(15)} |`);
  const md = [header, sep, ...rows].join("\n");
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.startsWith(header + "\n" + sep), JSON.stringify(c.slice(0, 60)));
    assert.ok(c.length <= CAP);
  }
  const all = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  for (const r of rows) assert.ok(all.includes(r), r);
});

test("chunkRich: oversized <details> unit unwrapped (summary kept as plain line, content split)", () => {
  const inner = Array.from({ length: 30 }, (_, i) => `i${i} ` + "z".repeat(8)).join("\n");
  const md = `<details><summary>code (30 lines)</summary>\n\n${inner}\n\n</details>`;
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= CAP);
  // hard-cut may break a line mid-character-run, so compare newline-stripped content
  const flatAll = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n").replace(/\n/g, "");
  assert.ok(!flatAll.includes("<details>"), "wrapper must be gone");
  assert.equal(flatAll, "code (30 lines)" + inner.replace(/\n/g, ""));
});

test("chunkRich: single giant paragraph → hard-cut pieces ≤ cap", () => {
  const md = "a".repeat(500);
  const chunks = chunkRich(md, CAP);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= CAP);
  assert.equal(chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join(""), md);
});

test("chunkRich: length is counted in JS units, not bytes", () => {
  const md = "é".repeat(31_900); // 31 900 JS units but 63 800 UTF-8 bytes
  assert.ok(Buffer.byteLength(md) > 32_768, "precondition: bytes exceed the documented limit");
  assert.equal(chunkRich(md, RICH_CAP).length, 1, "31 900 units must fit under RICH_CAP=32 000 in one chunk");
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/markdown.test.ts`
Expected: the new tests FAIL (`chunkRich is not a function`); old tests pass.

**Step 3: Implement** — append to `src/markdown.ts`:

```ts
/**
 * Pack rich units into chunks ≤ cap (chunks ≥ 2 prefixed with the marker).
 * A unit bigger than the whole cap is split inside, by type:
 * fence → code lines (fence+language re-emitted per piece);
 * table → rows (header + separator repeated per piece);
 * details → unwrap, then re-pack the content;
 * anything else → hard character cut (last resort, as in the legacy path).
 */
const MARKER = "(continued)\n";

export function chunkRich(md: string, cap = RICH_CAP): string[] {
  return packRichUnits(richUnits(md), cap).map((r, i) => (i === 0 ? r : MARKER + r));
}

function packRichUnits(units: RichUnit[], cap: number): string[] {
  const raw: string[] = [];
  let cur = "";
  const push = () => {
    if (cur !== "") { raw.push(cur); cur = ""; }
  };
  for (const u of units) {
    if (u.text.length > cap - MARKER.length) {
      push();
      raw.push(...splitRichUnit(u, cap));
      continue;
    }
    // Full cap only for the very first piece of the very first chunk (the only
    // chunk that never carries the marker) — same rule as the legacy packer.
    const capNow = raw.length === 0 && cur === "" ? cap : cap - MARKER.length;
    const sep = cur === "" ? 0 : 1;
    if (cur.length + sep + u.text.length <= capNow) {
      cur = cur === "" ? u.text : cur + "\n" + u.text;
    } else {
      push();
      cur = u.text;
    }
  }
  push();
  return raw;
}

function splitRichUnit(u: RichUnit, cap: number): string[] {
  if (u.type === "fence") return splitFence(u.text, cap - MARKER.length);
  if (u.type === "table") return splitTable(u.text, cap - MARKER.length);
  // reserve the marker budget too: any piece may become a non-first chunk
  if (u.type === "details") return packRichUnits(richUnits(unfoldDetails(u.text)), cap - MARKER.length);
  return hardCut(u.text, cap - MARKER.length);
}

function splitFence(text: string, cap: number): string[] {
  const lines = text.split("\n");
  const open = lines[0];
  let body = lines.slice(1);
  const closeRe = fenceCloseRe((FENCE_OPEN_RE.exec(open)?.[1]) ?? "```");
  let close: string | undefined;
  if (body.length > 0 && closeRe.test(body[body.length - 1])) {
    close = body[body.length - 1];
    body = body.slice(0, -1);
  }
  const overhead = open.length + 1 + (close ? close.length + 1 : 0);
  const bodyCap = Math.max(1, cap - overhead);
  const pieces: string[] = [];
  const emit = (chunk: string[]) => {
    pieces.push([open, ...chunk, ...(close ? [close] : [])].join("\n"));
  };
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length > 0) { emit(cur); cur = []; len = 0; }
  };
  for (const bl of body) {
    if (bl.length > bodyCap) {
      flush(); // one over-long code line: hard cut (last resort)
      for (const piece of hardCut(bl, bodyCap)) emit([piece]);
      continue;
    }
    const add = (cur.length > 0 ? 1 : 0) + bl.length;
    if (len + add <= bodyCap) { cur.push(bl); len += add; }
    else { flush(); cur = [bl]; len = bl.length; }
  }
  flush();
  return pieces.length > 0 ? pieces : [open + (close ? "\n" + close : "")];
}

function splitTable(text: string, cap: number): string[] {
  const lines = text.split("\n");
  const header = lines.slice(0, 2); // header + separator
  const rows = lines.slice(2);
  const overhead = header.reduce((a, l) => a + l.length + 1, 0);
  const rowsCap = Math.max(1, cap - overhead);
  const pieces: string[] = [];
  const emit = (chunk: string[]) => {
    pieces.push([...header, ...chunk].join("\n"));
  };
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length > 0) { emit(cur); cur = []; len = 0; }
  };
  for (const row of rows) {
    if (row.length > rowsCap) {
      flush(); // one over-long row: hard cut (last resort)
      for (const piece of hardCut(row, rowsCap)) emit([piece]);
      continue;
    }
    const add = (cur.length > 0 ? 1 : 0) + row.length;
    if (len + add <= rowsCap) { cur.push(row); len += add; }
    else { flush(); cur = [row]; len = row.length; }
  }
  flush();
  return pieces.length > 0 ? pieces : [text];
}

/** Drop the details wrapper, keep the summary text as a plain leading line. */
function unfoldDetails(text: string): string {
  let s = text.replace(/<details[^>]*>/i, "").replace(/<\/details>/i, "");
  s = s.replace(/<summary>([\s\S]*?)<\/summary>/i, (_m, t: string) => t.trim());
  return s.replace(/^\n+/, "");
}
```

**Step 4: Run tests + type gate**

Run: `node --test tests/markdown.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean. (If the emoji test's chunk count or the
details-unwrap assertion misfires, adjust the *tests* only after re-reading the
output — the packing rules above are the spec.)

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat(markdown): chunkRich — 32k block-boundary packing with per-type inner splits"
```

---

### Task 8: `tailView(md, cap)` — draft overflow view

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/markdown.ts` (append)
- Test: `tests/markdown.test.ts` (append tests)

**Step 1: Write the failing tests** — append to `tests/markdown.test.ts`:

```ts
test("tailView: under cap → unchanged", () => {
  assert.equal(tailView("small\n\ndoc", 200), "small\n\ndoc");
});

test("tailView: over cap → '⋯' prefix, ≤ cap, keeps the TAIL as whole blocks", () => {
  const blocks = Array.from({ length: 30 }, (_, i) => `p${i} ` + "x".repeat(30));
  const md = blocks.join("\n\n");
  const out = tailView(md, 200);
  assert.ok(out.startsWith("⋯\n"));
  assert.ok(out.length <= 200, `got ${out.length}`);
  const kept = out.slice("⋯\n".length);
  // kept text is a contiguous tail of the source (newline-normalized)
  const norm = (s: string) => s.replace(/\n+/g, "\n");
  assert.ok(norm(md).endsWith(norm(kept)), "kept must be the tail");
  // no half-block at the top: the first kept block is a complete source block
  const first = kept.split("\n")[0];
  assert.ok(blocks.some((b) => b.startsWith(first.slice(0, 5))), "first kept block is a whole block");
});

test("tailView: a table is never cut in half — it's kept whole or dropped entirely", () => {
  const header = "| a | b |";
  const sep = "| --- | --- |";
  const table = [header, sep, ...Array.from({ length: 10 }, (_, i) => `| r${i} | v |`)].join("\n");
  const md = `${"lead ".repeat(20)}\n\n${table}`;
  const out = tailView(md, 200);
  const kept = out.slice(out.startsWith("⋯\n") ? "⋯\n".length : 0);
  if (kept.includes(header)) {
    // table kept whole: header and last row together, in order
    assert.ok(kept.startsWith(header + "\n" + sep) || kept.includes(header + "\n" + sep + "\n| r0"));
    assert.ok(kept.includes("| r9 | v |"));
  }
  assert.ok(kept.length <= 200);
});

test("tailView: single giant unit → hard tail (last resort), still ≤ cap", () => {
  const md = "g".repeat(500);
  const out = tailView(md, 200);
  assert.ok(out.startsWith("⋯\n"));
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith("g".repeat(198)), "keeps the final characters");
});

test("tailView: default cap is RICH_CAP", () => {
  const md = Array.from({ length: 4000 }, () => "x".repeat(10)).join("\n"); // 39 999 chars
  const out = tailView(md);
  assert.ok(out.length <= RICH_CAP);
  assert.ok(out.startsWith("⋯\n"));
});
```

**Step 2: Run to verify failure**

Run: `node --test tests/markdown.test.ts`
Expected: the new tests FAIL (`tailView is not a function`); old tests pass.

**Step 3: Implement** — append to `src/markdown.ts`:

```ts
/**
 * Draft overflow view: if the text is over cap, keep the TAIL (what the user
 * cares about most), back the cut off to the nearest block boundary, and
 * prefix a single "⋯" line. Whole blocks only; a single oversized unit falls
 * back to a hard character tail (the draft is a live preview, not the answer).
 */
export function tailView(md: string, cap = RICH_CAP): string {
  if (md.length <= cap) return md;
  const units = richUnits(md);
  const budget = cap - "⋯\n".length;
  const keep: string[] = [];
  let len = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const add = units[i].text.length + (keep.length > 0 ? 1 : 0);
    if (len + add <= budget) { keep.unshift(units[i].text); len += add; }
    else break;
  }
  if (keep.length === 0) {
    const last = units[units.length - 1].text;
    return "⋯\n" + last.slice(last.length - budget);
  }
  return "⋯\n" + keep.join("\n");
}
```

**Step 4: Run tests + type gate**

Run: `node --test tests/markdown.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc clean.

**Step 5: Commit**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat(markdown): tailView — block-aligned tail with '⋯' for draft overflow"
```

**Phase B checkpoint:** `node --test` green, `npx tsc --noEmit` clean.

---

## Phase C — mirror & wiring

### Task 9: Mirror rewrite — one rich draft per turn + finalization fallback chain

**TDD scenario:** Behavior change — rewrite the four mirror test files first
(they are the spec for the new behavior), then replace `src/mirror.ts`.
One commit at the end (suite must be green at commit time).

**Files:**
- Rewrite: `src/mirror.ts` (new content below, in full)
- Modify: `tests/mirror-helpers.ts` (injectable timer)
- Rewrite: `tests/mirror-stream.test.ts`, `tests/mirror-tools.test.ts`,
  `tests/mirror-end.test.ts`, `tests/mirror-mute.test.ts` (full contents below)
- Modify: `tests/fake-pi.ts` (FakeOut: `sendFailsWith` + `sendHtmlFailsWith` knobs)
- Modify: `index.ts` (new Mirror deps)

**Step 1: Rewrite `tests/mirror-helpers.ts`** (full file):

```ts
// Shared fake harness for mirror tests: real Mirror + TelegaState, fake Out,
// injectable clock AND timer (the heartbeat is fake — no real sleeps).
import { Mirror, type MirrorDeps } from "../src/mirror.ts";
import { TelegaState } from "../src/state.ts";
import { DEFAULTS, type TelegaConfig } from "../src/config.ts";
import { FakeOut } from "./fake-pi.ts";

export interface MirrorTestDeps {
  deps: MirrorDeps;
  out: FakeOut;
  state: TelegaState;
  cfg: TelegaConfig;
  advance(ms: number): void;
  fireTimer(): void; // fires the single pending (heartbeat) timer, if any
}

export function makeMirrorDeps(cfg: Partial<TelegaConfig> = {}, chatId = 7): MirrorTestDeps {
  const out = new FakeOut();
  const state = new TelegaState();
  let t = 0;
  let timer: { fn: () => void } | undefined;
  const fullCfg: TelegaConfig = { ...DEFAULTS, botToken: "t", ownerId: 7, ...cfg };
  const deps: MirrorDeps = {
    out,
    state,
    cfg: fullCfg,
    getChatId: () => chatId,
    now: () => t,
    setTimer: (fn) => { timer = { fn }; return timer; },
    clearTimer: () => { timer = undefined; },
  };
  return {
    deps,
    out,
    state,
    cfg: fullCfg,
    advance: (ms: number) => { t += ms; },
    fireTimer: () => { const c = timer; timer = undefined; c?.fn(); },
  };
}
```

**Step 2: Extend FakeOut** — in `tests/fake-pi.ts`, add one field next to
the existing `sendFailsWith` and change `send` (note: the opts type is
`FakeOutCall["opts"]` — there is no `FakeSendOpts` type in this file):

```ts
  sendFailsWith: Error | undefined;
  sendHtmlFailsWith: Error | undefined; // only when opts.parseMode === "HTML"
  send = async (chatId: number, text: string, opts?: FakeOutCall["opts"]): Promise<number | undefined> => {
    if (this.sendFailsWith) throw this.sendFailsWith;
    if (opts?.parseMode === "HTML" && this.sendHtmlFailsWith) throw this.sendHtmlFailsWith;
    this.calls.push({ kind: "send", chatId, text, opts });
    return this.nextMessageId++;
  };
```

**Step 3: Rewrite `tests/mirror-stream.test.ts`** (full file):

```ts
// Per-turn streaming: the rich draft lifecycle (same draft_id, throttled,
// heartbeat via the injected fake timer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("agent_start creates a draft (draft_id 1, can_stop) with the thinking label", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1);
  assert.equal(drafts[0].canStop, true);
  assert.equal(drafts[0].text, "<tg-thinking>working…</tg-thinking>");
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0, "no legacy Working… message");
});

test("assistant updates refresh the same draft, throttled by streamEditMs", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  await m.onAssistantUpdate({ role: "assistant", content: "Hello" });
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 0, "throttled at t=0 (draft just sent)");
  advance(1500);
  await m.onAssistantUpdate({ role: "assistant", content: "Hello world" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1, "same draft_id refreshed, not a new draft");
  assert.equal(drafts[0].text, "Hello world");
});

test("assistant_start of a NEW message resets the throttle window", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantStart({ role: "assistant" });
  out.calls.length = 0;
  await m.onAssistantUpdate({ role: "assistant", content: "first words" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1, "first update of a new message is not throttled");
  assert.equal(drafts[0].text, "first words");
});

test("multiple assistant messages in one turn: draft shows the LATEST text", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantStart({ role: "assistant" });
  advance(1600);
  await m.onAssistantUpdate({ role: "assistant", content: "first message" });
  await m.onAssistantEnd({ role: "assistant" });
  await m.onAssistantStart({ role: "assistant" });
  await m.onAssistantUpdate({ role: "assistant", content: "second message" });
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts[drafts.length - 1].text, "second message");
  assert.equal(drafts.every((d) => d.draftId === 1), true, "one draft for the whole turn");
});

test("heartbeat re-sends the same draft_id every draftHeartbeatMs", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  advance(17000);
  fireTimer();
  const drafts = out.calls.filter((c) => c.kind === "sendDraft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].draftId, 1);
  assert.equal(drafts[0].text, "<tg-thinking>working…</tg-thinking>");
});

test("heartbeat stops at agent_end; a new turn gets a new draft_id", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "done" }]);
  out.calls.length = 0;
  advance(17000);
  fireTimer();
  assert.equal(out.calls.filter((c) => c.kind === "sendDraft").length, 0, "no heartbeat after agent_end");
  await m.onAgentStart();
  const last = out.calls.filter((c) => c.kind === "sendDraft").at(-1);
  assert.equal(last?.draftId, 2, "fresh draft_id per turn");
});
```

**Step 4: Rewrite `tests/mirror-tools.test.ts`** (full file):

```ts
// Tool status lines live INSIDE the draft footer (sending separate bot
// messages would kill the draft).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, toolPreview } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const lastDraft = (out: { calls: { kind: string; text?: string }[] }): { text: string } => {
  const d = out.calls.filter((c) => c.kind === "sendDraft").at(-1) as { text: string } | undefined;
  assert.ok(d, "a draft update exists");
  return d;
};

test("tool start → footer line in the draft; NO separate tool message", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onToolStart("c1", "bash", { command: "ls -la" });
  assert.ok(lastDraft(out).text.includes("⚙ bash: ls -la …"));
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0);
});

test("tool end ✔ and error end ✖", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onToolStart("c1", "bash", { command: "long build" });
  assert.ok(lastDraft(out).text.includes("⚙ bash: long build …"));
  await m.onToolEnd("c1", true);
  assert.ok(lastDraft(out).text.includes("⚙ bash: long build ✖"));
  await m.onToolStart("c2", "read", { path: "src/a.ts" });
  await m.onToolEnd("c2", false);
  assert.ok(lastDraft(out).text.includes("⚙ read: src/a.ts ✔"));
});

test("footer keeps in-flight lines + only the LAST 3 completions", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const specs: [string, string, unknown][] = [
    ["c1", "read", { path: "a.ts" }],
    ["c2", "bash", { command: "b" }],
    ["c3", "write", { path: "c.ts" }],
    ["c4", "edit", { path: "d.ts" }],
    ["c5", "bash", { command: "e" }],
  ];
  for (const [id, tool, args] of specs) {
    await m.onToolStart(id, tool, args);
    await m.onToolEnd(id, false);
  }
  const t = lastDraft(out).text;
  assert.ok(t.includes("write: c.ts ✔"));
  assert.ok(t.includes("edit: d.ts ✔"));
  assert.ok(t.includes("bash: e ✔"));
  assert.ok(!t.includes("read: a.ts"), "older completion dropped");
  assert.ok(!t.includes("bash: b ✔"), "older completion dropped");
});

test("in-flight tool line survives a later completion of another tool", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onToolStart("c1", "read", { path: "a.ts" });
  await m.onToolEnd("c1", false);
  await m.onToolStart("c2", "bash", { command: "npm test" });
  const t = lastDraft(out).text;
  assert.ok(t.includes("read: a.ts ✔"), "recent completion kept");
  assert.ok(t.includes("⚙ bash: npm test …"), "in-flight line kept");
});

test("ui_prompt_start → footer line inside the draft (no separate message)", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onUiPromptStart("allow bash?");
  assert.ok(lastDraft(out).text.includes("allow bash?"));
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0);
});

test("toolPreview: bash command / file path / truncated JSON", () => {
  assert.equal(toolPreview("bash", { command: "ls -la" }, 30), "ls -la");
  assert.equal(toolPreview("read", { path: "x/y.ts" }, 30), "x/y.ts");
  assert.equal(toolPreview("weird", { a: "b" }, 30), '{"a":"b"}');
  assert.ok(toolPreview("weird", { a: "x".repeat(50) }, 30).length <= 32);
});
```

**Step 5: Rewrite `tests/mirror-end.test.ts`** (full file):

```ts
// Finalization: rich → legacy HTML → plain; error/abort/no-text paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { RICH_CAP } from "../src/markdown.ts";
import { TgError } from "../src/telegram-client.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("normal end → single rich message; no status line", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "**bold** answer" }] }]);
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1);
  assert.equal(rich[0].text, "**bold** answer");
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0, "no ✅ Done / Working… line on the normal path");
});

test("answer over RICH_CAP → chunkRich rich chunks, marker from 2nd", async () => {
  const md = "x".repeat(40_000);
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: md }]);
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 2);
  assert.ok(!rich[0].text.startsWith("(continued)"));
  assert.ok(rich[1].text.startsWith("(continued)\n"));
  for (const c of rich) assert.ok(c.text.length <= RICH_CAP);
});

test("rich 400 → legacy HTML chunks (parse_mode HTML)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "hello" }]);
  const html = out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === "HTML");
  assert.equal(html.length, 1);
  assert.equal(html[0].text, "hello");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("rich 400 → HTML 400 → plain text (full fallback chain)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich");
  out.sendHtmlFailsWith = new TgError("sendMessage", 400, "html");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "text <broken" }]);
  const plain = out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "text <broken");
});

test("non-400 error propagates (no silent fallback)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 429, "rate limited");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await assert.rejects(m.onAgentEnd([{ role: "assistant", content: "hi" }]));
});

test("error end → plain ⚠️ line, no rich answer", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "partial", stopReason: "error", errorMessage: "boom" }]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "⚠️ error: boom");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("aborted → '⏹  interrupted' (space after emoji) + rich partial answer", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" }]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "⏹  interrupted");
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1);
  assert.equal(rich[0].text, "partial");
});

test("aborted with no text → label only", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "", stopReason: "aborted" }]);
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 1);
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("normal end with no reply text → '✅ Done (no reply text)'", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "✅ Done (no reply text)");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});
```

**Step 6: Rewrite `tests/mirror-mute.test.ts`** (full file):

```ts
// Mute = fully silent: no draft, no updates, no final message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("muted at start: zero messages of any kind", async () => {
  const { deps, out } = makeMirrorDeps({ muted: true });
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantUpdate({ role: "assistant", content: "secret work" });
  await m.onToolStart("c1", "bash", { command: "secret" });
  await m.onAgentEnd([{ role: "assistant", content: "secret answer" }]);
  assert.equal(out.calls.length, 0, `calls: ${JSON.stringify(out.calls)}`);
});

test("muted mid-turn: draft updates and heartbeat stop; no final message", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  deps.cfg.muted = true; // user mutes mid-turn
  advance(17000);
  fireTimer();
  advance(1500);
  await m.onAssistantUpdate({ role: "assistant", content: "late text" });
  await m.onAgentEnd([{ role: "assistant", content: "late text" }]);
  assert.equal(out.calls.length, 0, `calls: ${JSON.stringify(out.calls)}`);
});
```

**Step 7: Run tests to verify failure**

Run: `node --test tests/mirror-stream.test.ts tests/mirror-tools.test.ts tests/mirror-end.test.ts tests/mirror-mute.test.ts`
Expected: FAIL (old mirror has no `sendDraft` behavior / `MirrorDeps` type missing).

**Step 8: Replace `src/mirror.ts`** (full file):

```ts
/**
 * Per-turn agent-event mirroring on top of the rich draft (Bot API 10.2).
 *
 * One ephemeral rich draft per agent turn: same draft_id re-sent on every
 * content update plus a heartbeat (keeps the ~30 s window alive). Content =
 * latest assistant markdown (long fences folded, tail-viewed at RICH_CAP)
 * + a tool-status footer. Finalization = sendRichMessage → legacy HTML
 * chunk → plain text. Mute = fully silent.
 */
import type { Out } from "./session-bridge.ts";
import type { TelegaState } from "./state.ts";
import type { TelegaConfig } from "./config.ts";
import { RICH_CAP, foldLongFences, tailView, chunkRich, chunkMarkdown, chunkText, toPlainText } from "./markdown.ts";
import { TgError } from "./telegram-client.ts";

export interface MirrorMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/** Preview text for a tool call (kept inside the draft footer). */
export function toolPreview(tool: string, args: unknown, maxChars: number): string {
  const a = args as Record<string, unknown> | undefined;
  if (tool === "bash" && typeof a?.command === "string") return a.command;
  if (tool === "read" && typeof a?.path === "string") return a.path;
  if (tool === "write" && typeof a?.path === "string") return a.path;
  if (tool === "edit" && typeof a?.path === "string") return a.path;
  if (typeof a?.file_path === "string") return a.file_path;
  if (typeof a?.path === "string") return a.path;
  if (typeof a?.url === "string") return a.url;
  if (typeof a?.query === "string") return a.query;
  const s = JSON.stringify(args ?? {});
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

export function assistantText(msg: MirrorMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("");
  return "";
}

const THINKING = "<tg-thinking>working…</tg-thinking>";

interface ToolLine {
  text: string;
  done: boolean;
  isError: boolean;
}

export interface MirrorDeps {
  out: Out;
  state: TelegaState;
  cfg: TelegaConfig;
  getChatId(): number | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Surfaced when a draft update fails (the next update retries; no machinery). */
  notify?: (msg: string) => void;
}

export class Mirror {
  private deps: MirrorDeps;
  private draftSeq = 0;
  private draftId = 0;
  private draftActive = false;
  private answerText = ""; // latest assistant markdown (the draft body)
  private lastDraftSend = 0;
  private hbTimer: unknown;
  private toolLines: ToolLine[] = [];
  private inflight = new Map<string, number>();
  private uiPromptLine: string | undefined;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  async onAgentStart(): Promise<void> {
    const { cfg } = this.deps;
    if (cfg.muted) return; // fully silent: no draft at all
    if (this.deps.getChatId() === undefined) return;
    this.draftSeq += 1;
    this.draftId = this.draftSeq;
    this.answerText = "";
    this.lastDraftSend = 0;
    this.toolLines = [];
    this.inflight.clear();
    this.uiPromptLine = undefined;
    this.draftActive = true;
    await this.sendDraft(true);
    this.armHeartbeat();
  }

  private armHeartbeat(): void {
    const { deps } = this;
    deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
    if (deps.cfg.muted || !this.draftActive) return;
    this.hbTimer = deps.setTimer(() => {
      this.hbTimer = undefined;
      void this.sendDraft(true);
      this.armHeartbeat();
    }, deps.cfg.draftHeartbeatMs);
  }

  private stopHeartbeat(): void {
    this.deps.clearTimer(this.hbTimer);
    this.hbTimer = undefined;
  }

  private async sendDraft(canStop: boolean): Promise<void> {
    const { cfg, out } = this.deps;
    if (cfg.muted || !this.draftActive) return;
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    try {
      await out.sendDraft(chatId, this.draftId, this.draftContent(), canStop);
      this.lastDraftSend = this.deps.now();
    } catch (err) {
      this.deps.notify?.(`draft update failed: ${String(err)}`);
    }
  }

  private draftContent(): string {
    const { cfg } = this.deps;
    const body = tailView(foldLongFences(this.answerText, cfg.codeFoldLines), RICH_CAP);
    const footer = this.footerLines();
    if (footer.length > 0) return body.length > 0 ? `${body}\n\n${footer.join("\n")}` : footer.join("\n");
    return body.length > 0 ? body : THINKING;
  }

  private footerLines(): string[] {
    const lines = this.toolLines.filter((l) => !l.done).map((l) => l.text);
    for (const l of this.toolLines.filter((l) => l.done).slice(-3)) lines.push(l.text);
    if (this.uiPromptLine !== undefined) lines.push(this.uiPromptLine);
    return lines;
  }

  async onToolStart(toolCallId: string, tool: string, args: unknown): Promise<void> {
    if (!this.draftActive) return;
    const line = `⚙ ${tool}: ${toolPreview(tool, args, this.deps.cfg.toolPreviewChars)} …`;
    this.inflight.set(toolCallId, this.toolLines.length);
    this.toolLines.push({ text: line, done: false, isError: false });
    await this.sendDraft(true);
  }

  async onToolEnd(toolCallId: string, isError: boolean): Promise<void> {
    if (!this.draftActive) return;
    const idx = this.inflight.get(toolCallId);
    this.inflight.delete(toolCallId);
    if (idx === undefined) return;
    const l = this.toolLines[idx];
    l.done = true;
    l.isError = isError;
    l.text = l.text.replace(/…$/, "").trimEnd() + (isError ? " ✖" : " ✔"); // single space before the mark
    await this.sendDraft(true);
  }

  async onAssistantStart(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = "";
    // First update of a new message is not throttled (the throttled-at-t=0
    // case only applies to the very first message right after the draft spawn).
    this.lastDraftSend = this.deps.now() - this.deps.cfg.streamEditMs;
  }

  async onAssistantUpdate(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    this.answerText = assistantText(msg);
    if (this.deps.now() - this.lastDraftSend < this.deps.cfg.streamEditMs) return;
    await this.sendDraft(true);
  }

  async onAssistantEnd(msg: MirrorMessage): Promise<void> {
    if (msg.role !== "assistant") return;
    if (!this.draftActive) return;
    await this.sendDraft(true); // unthrottled: show the complete message before the next one/turn
  }

  async onUiPromptStart(title?: string): Promise<void> {
    if (!this.draftActive) return;
    this.uiPromptLine = `⚠️ terminal prompt${title ? `: ${title}` : ""} — answer there`;
    await this.sendDraft(true);
  }

  async onAgentEnd(messages: MirrorMessage[]): Promise<void> {
    this.stopHeartbeat();
    this.draftActive = false;
    let finalText = "";
    let stopReason: string | undefined;
    let errMsg: string | undefined;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const t = assistantText(msg);
      if (t.trim()) finalText = t;
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errMsg = msg.errorMessage;
    }
    const chatId = this.deps.getChatId();
    if (chatId === undefined) return;
    const { out } = this.deps;

    if (stopReason === "error" || errMsg) {
      await out.send(chatId, `⚠️ error: ${errMsg ?? stopReason ?? "unknown"}`, { parseMode: null });
      return;
    }
    if (stopReason === "aborted") {
      await out.send(chatId, "⏹  interrupted", { parseMode: null });
      if (!this.deps.cfg.muted && finalText) await this.sendAnswer(chatId, finalText);
      return;
    }
    if (this.deps.cfg.muted) return; // fully silent
    if (finalText) await this.sendAnswer(chatId, finalText);
    else await out.send(chatId, "✅ Done (no reply text)", { parseMode: null });
  }

  /**
   * Finalize an answer: fold long fences, chunk at RICH_CAP (block boundaries),
   * send as rich messages. On a 400 (rich parse failed) the WHOLE answer is
   * re-sent through the legacy HTML path; on a 400 there, plain text. (The
   * 400-after-some-chunks-already-sent edge duplicates content — accepted,
   * same policy as the design doc: per-send fallback for the whole answer.)
   */
  private async sendAnswer(chatId: number, md: string): Promise<void> {
    const { out } = this.deps;
    const folded = foldLongFences(md, this.deps.cfg.codeFoldLines);
    const pieces = folded.length <= RICH_CAP ? [folded] : chunkRich(folded);
    try {
      for (const p of pieces) await out.sendRich(chatId, p);
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    try {
      for (const chunk of chunkMarkdown(md)) await out.send(chatId, chunk, { parseMode: "HTML" });
      return;
    } catch (err) {
      if (!(err instanceof TgError && err.code === 400)) throw err;
    }
    for (const chunk of chunkText(toPlainText(md))) await out.send(chatId, chunk, { parseMode: null });
  }
}
```

**Step 9: Update `index.ts`** — in `startPolling()`, the line
`const mirror = new Mirror({ out: outAdapter, state, cfg, getChatId: () => ownerChatId, now: () => Date.now() });`
becomes:

```ts
  const mirror = new Mirror({
    out: outAdapter,
    state,
    cfg,
    getChatId: () => ownerChatId,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.(); // don't hold the process open if pi exits mid-turn
      return t;
    },
    clearTimer: (h) => clearTimeout(h),
    notify: (msg) => ui(msg, "error"),
  });
```

**Step 10: Run tests + type gate**

Run: `node --test && npx tsc --noEmit`
Expected: all tests PASS (including bridge/config/client/router/wiring/state), tsc clean.
Note: `src/state.ts`'s now-unused `setWorking`/`getWorking`/tool-msg methods are
deleted in Task 10 — they are harmless for now.

**Step 11: Commit**

```bash
git add src/mirror.ts tests/mirror-helpers.ts tests/mirror-stream.test.ts tests/mirror-tools.test.ts tests/mirror-end.test.ts tests/mirror-mute.test.ts tests/fake-pi.ts index.ts
git commit -m "feat(mirror): one rich draft per turn (heartbeat, tool footer, rich finalization w/ fallback)"
```

---

### Task 10: `state.ts` — delete working/tool-msg APIs (mirror no longer uses them)

**TDD scenario:** Change to existing tested code — edit + test in one step, run
the suite to confirm.

**Files:**
- Modify: `src/state.ts`
- Modify: `tests/state.test.ts`

**Step 1: Edit `src/state.ts`** — delete all of the following (nothing else
uses them after Task 9; note `TelegaState` has NO `toJSON`/`loadFrom` —
persistence happens in `index.ts` via `cfg.lastOffset` / `cfg.sentMessageIds`,
so nothing to change there):

- Fields in `TelegaState`:

```ts
  private workingMsgId: number | undefined;
  private toolMsgIds = new Map<string, number>();
```

- The working/tool-msg methods (part of the `// instance-scoped` block):

```ts
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
```

(`offset` is a private field — access it only via `getOffset()`/`setOffset()`.)

`sentMessageIds` (`restoreSentIds`/`addSent`/`sentIds`/`drainSent`) STAYS —
final rich messages and the small plain status lines are still recorded for
`/clear`.

**Step 2: Edit `tests/state.test.ts`** — replace the test named
`"offset + working + tool-msg lifecycle"` with:

```ts
test("offset lifecycle", () => {
  const s = new TelegaState(41);
  assert.equal(s.getOffset(), 41);
  s.setOffset(42);
  assert.equal(s.getOffset(), 42);
});
```

**Step 3: Run tests + type gate**

Run: `node --test && npx tsc --noEmit`
Expected: all PASS; tsc clean (tsc will name any file still referencing the
deleted APIs — fix it by removing the dead call, not by keeping the API).

**Step 4: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "refactor(state): drop working/tool-msg APIs (replaced by the in-memory draft)"
```

---

### Task 11: README + full verification + smoke checklist

**TDD scenario:** Docs + verification — no new code.

**Files:**
- Modify: `README.md`

**Step 1: Update the README "How it works" bullet** — replace exactly these
three lines:

```md
- While the agent works you get: a **working message** with a ⏹ Stop button,
  live tool lines (`⚙ bash: … ✔`), throttled streaming reply edits (1.5 s), and
  the final answer chunked to ≤ 4096 chars per message (Telegram HTML).
```

with:

```md
- While the agent works you get one **live rich draft** (native Telegram
  rendering): the streaming answer with native tables / code blocks / collapsed
  `<details>` for long code, tool status lines in its footer (`⚙ bash: … ✔`),
  and a native **Stop** button. The draft is refreshed every 1.5 s and
  heartbeated every 17 s (it is ephemeral — Telegram auto-hides it ~30 s after
  the last refresh). The final answer is a rich message; answers over the rich
  limit (32 000 chars) are chunked at block boundaries with a `(continued)`
  marker. If Telegram rejects a rich message, the answer is re-sent through
  the legacy 4096-char HTML path, then plain text.
```

**Step 2: Add config rows** — in the Configuration table, after the
`maxSessionList` row add:

```md
| `draftHeartbeatMs` | `17000` | rich-draft re-send cadence in ms (keeps the ephemeral draft alive; out-of-range 5000..25000 → default) |
| `codeFoldLines` | `25` | code fences whose body has more than N lines collapse into a closed `<details>` (out-of-range 5..500 → default) |
```

**Step 3: Full verification (evidence before claiming done)**

```bash
node --test          # ALL tests pass
npx tsc --noEmit     # clean
git status --short   # only README.md staged
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rich draft streaming + new config keys"
```

**Step 5: Manual smoke checklist (real bot, owner chat)** — run against a
throwaway bot; mark each off before declaring the feature done:

- [ ] Ask for a **table** → renders as a native Telegram table (not pipes).
- [ ] Ask for a **long code block** (> 25 lines) → draft shows it collapsed in
      a closed `<details>`; final answer too.
- [ ] Draft **Stop button** → aborts; you get `⏹  interrupted` + partial answer.
- [ ] **Very long answer** (e.g. "list all 96 ASCII code points in a table plus
      a 500-line code sample") → multiple rich chunks, `(continued)` from 2nd.
- [ ] **/mute mid-turn** → draft stops updating and disappears within ~30 s;
      no final message.
- [ ] Streaming: watch the draft update as the model writes (≤ 1.5 s cadence).
- [ ] Heartbeat: start a long tool-heavy turn, idle the model > 17 s in a
      terminal prompt → draft survives (footer shows the terminal-prompt line).

If any spike/smoke item contradicts an assumption, fix the constant/behavior
here (RICH_CAP, thinking label, entity-detection flag) and re-run `node --test`.

---

## Done

All 12 tasks committed, full suite + type gate green, smoke checklist passed.
The bot now streams and finalizes every LLM answer as a native rich message;
the legacy markdown→HTML path survives only as the automatic fallback.

