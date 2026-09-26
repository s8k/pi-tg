# TUI Dialog Mirroring (Option A) Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Let the owner answer other extensions' TUI dialogs (`ctx.ui.select/confirm/input/editor`) from the Telegram chat — inline buttons or message replies — with the choice delivered to pi exactly as if it had been selected in the TUI.

**Architecture:** pi's `ctx.ui` is ONE shared, plain, mutable object (`runner.uiContext`, wrapped by pi's `wrapUIPromptContext`); every extension's ctx reads it live. pi-telega installs an **in-place proxy** on that object once per session (`installUiProxy` in `src/wiring.ts`): each dialog method is wrapped so that (1) the real TUI dialog opens as usual, (2) simultaneously a Telegram dialog message goes out (`PendingDialogs`, new pi-free module `src/ui-dialogs.ts`), (3) a race decides the winner — Telegram tap → the TUI dialog is programmatically dismissed via a combined `AbortSignal` (pi's own supported dismiss path) and the tapped value resolves the caller's promise; terminal key → the Telegram message is stamped "answered in the terminal". `custom()` and non-mirrorable cases keep today's heads-up (`ui_prompt_start` mirror line).

**Tech Stack:** TypeScript (Node ≥ 22.18 type-stripping, erasable syntax only), `node --test`, `tsc --noEmit`; zero new dependencies.

**Verified against pi 0.87.1 source** (repo devDep `^0.84.4`, installed 0.87.1; `dist/modes/interactive/interactive-mode.js` + `dist/core/extensions/types.d.ts`):

- `select(title, options, opts?) → Promise<string | undefined>`; `confirm(title, message, opts?) → Promise<boolean>` (impl: `select(title + "\n" + message, ["Yes","No"])` → `result === "Yes"` — cancel ⇒ `false`); `input(title, placeholder?, opts?) → Promise<string | undefined>`; `editor(title, prefill?) → Promise<string | undefined>` — **editor has NO opts: no signal, no timeout ⇒ cannot be dismissed programmatically** (if Telegram answers first, the TUI editor stays open until the user hits Esc there — its late resolution is discarded harmlessly).
- `opts.signal` (select/confirm/input): pi adds an abort listener → `hideExtension*()` + `resolve(undefined)`. **Programmatic dismiss is a supported path.** `opts.timeout` is handled inside the component (auto-cancel ⇒ TUI side resolves `undefined`).
- The runner's `ui_prompt_start`/`ui_prompt_end` wrappers sit INSIDE the object we patch (they are our `orig`), so they keep firing — the mirror's "⚠️ terminal prompt" work-log line stays (harmless, silent lane).
- pi's INTERNAL dialogs (e.g. the compaction "Summarize branch?" prompt) call the mode's own raw UI context, NOT the runner-wrapped object ⇒ they are never intercepted.
- `ctx.ui` getter resolves `runner.uiContext` at access time for every ctx (session and command) ⇒ one patch covers all extensions; a fresh object is created per runner (reload/swap) ⇒ re-patch on every `session_start`; a `Symbol.for` marker makes patching idempotent.

**Design decisions:**

| Topic | Decision |
|---|---|
| Answer channels | select/confirm → inline buttons (`callback_data` ≤ 64 B, index-based). input/editor → **reply to the dialog message** with text (disambiguates from "text = prompt"). select with > 20 options → numbered list + reply with the number (non-numeric reply is ignored, dialog stays open). |
| Race winner | First resolution wins. TG wins ⇒ `AbortController` aborts the combined signal (TUI dialog dismisses, resolves `undefined` — ignored). TUI wins ⇒ TG message stamped `💻 … answered in the terminal`. |
| Timeout / caller signal | No timers on our side: pi resolves the TUI promise itself (timeout ⇒ `undefined`; caller abort ⇒ `undefined`). We only combine `AbortSignal.any([callerSignal, ourSignal])` and pass it to `orig`. |
| `custom()` | NOT mirrored (arbitrary component). Existing heads-up line covers it. (Key-simulation = future Option B.) |
| `notify` forwarding | Out of scope (future). |
| Config | `mirrorDialogs: boolean`, default `true` (config file only — no new bot command; dialogs are interactive, they show at every output level). |
| Draft interplay | A dialog `sendMessage` clears the live ephemeral run draft (Bot API: persistent send dismisses drafts) — same as today's mid-run confirmations; the heartbeat re-raises the draft. Accepted. |
| Stale taps | The stamp edit removes the keyboard, so stale callbacks are impossible except a same-batch double tap ⇒ `tgAnswer` returns false ⇒ silent no-op. |
| Instance swap | Dialogs are per polling generation; `session_shutdown` / new `session_start` ⇒ `cancelAll()` (stamp `⚠️ expired`, release promises). The TUI dialog of the dying generation is abandoned (its promise dies with it). |
| Security | Callbacks already owner-gated by `route()`; replies to a dialog message are owner-only (router checks `fromId === ownerId` first). |
| Degradation | If `ctx.ui` is not patchable (future pi change) ⇒ `installUiProxy` returns false ⇒ TUI warning, heads-up-only behavior (today's UX). Never crash. |

**Files:**
- Create: `src/ui-dialogs.ts`, `tests/ui-dialogs.test.ts`, `tests/bridge-dialogs.test.ts`
- Modify: `src/config.ts`, `src/router.ts`, `src/command-args.ts`, `src/session-bridge.ts`, `src/wiring.ts`, `index.ts`, `tests/helpers.ts`, `tests/router.test.ts`, `tests/command-args.test.ts`, `tests/config.test.ts`, `tests/wiring.test.ts`, `tests/index-smoke.test.ts`, `README.md`
- Untouched: `src/mirror.ts` (its `onUiPromptStart` heads-up stays), `src/telegram-client.ts` (existing `sendMessage`/`editMessageText` + `reply_markup` suffice), `tests/boundary.test.ts` (ui-dialogs.ts is pi-free by construction)

**Task map (TDD, one commit each):**

1. Config flag `mirrorDialogs`
2. `PendingDialogs` core: button dialogs (select/confirm) + answer/stamp/lifecycle
3. `PendingDialogs` text dialogs (input/editor) + numbered select
4. Router: `da:`/`dc:` callbacks + reply-to-dialog ⇒ `dialogText`
5. command-args: encode/parse for the 3 new actions
6. Bridge: dispatch the 3 dialog actions
7. `installUiProxy` in wiring.ts (patch + race)
8. index.ts integration + end-to-end smoke test
9. README + full verification

**Verification gates (every task):** `npx tsc --noEmit` (must pass) and `node --test` (all tests, must pass). Per AGENTS.md: always timeout bash, scope greps to the repo.

---

## Task 1: Config flag `mirrorDialogs`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/config.ts` (interface + DEFAULTS + sanitize)
- Modify: `tests/helpers.ts` (`makeDeps` cfg)
- Test: `tests/config.test.ts`

**Step 1: Write the failing tests** — append to `tests/config.test.ts`:

```ts
test("mirrorDialogs: default true, explicit false kept, garbage → default", () => {
  assert.equal(sanitize({}).mirrorDialogs, true);
  assert.equal(sanitize({ mirrorDialogs: false }).mirrorDialogs, false);
  assert.equal(sanitize({ mirrorDialogs: "nope" }).mirrorDialogs, true);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.ts`
Expected: FAIL — `sanitize({}).mirrorDialogs` is `undefined` (assertion `undefined === true` fails).

**Step 3: Implement**

`src/config.ts`:
- `TelegaConfig`: add
  ```ts
  /** Mirror other extensions' TUI dialogs (select/confirm/input/editor) to Telegram. */
  mirrorDialogs: boolean;
  ```
- `DEFAULTS`: add `"mirrorDialogs"` to the Pick and `mirrorDialogs: true,`.
- `sanitize()`: add `mirrorDialogs: typeof obj.mirrorDialogs === "boolean" ? obj.mirrorDialogs : DEFAULTS.mirrorDialogs,`

`tests/helpers.ts`: add `mirrorDialogs: true,` to the `cfg` literal in `makeDeps`.

**Step 4: Run tests** — `npx tsc --noEmit` && `node --test` → all pass.

**Step 5: Commit** — `git add src/config.ts tests/helpers.ts tests/config.test.ts && git commit -m "feat(dialogs): add mirrorDialogs config flag (default on)"`

---

## Task 2: `PendingDialogs` core — button dialogs (select/confirm)

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/ui-dialogs.ts`
- Test: `tests/ui-dialogs.test.ts`

**Step 1: Write the failing tests** — `tests/ui-dialogs.test.ts` (imports `FakeOut` from `./fake-pi.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingDialogs, renderDialog, type DialogSpec } from "../src/ui-dialogs.ts";
import { FakeOut } from "./fake-pi.ts";

const deps = (over: Partial<{ chatId: number | undefined; enabled: boolean }> = {}) => ({
  out: new FakeOut(),
  getChatId: () => over.chatId ?? 42,
  enabled: () => over.enabled ?? true,
  notify: undefined,
});

test("renderDialog select: title + one button per option + cancel row, index-based callback data", () => {
  const r = renderDialog({ kind: "select", title: "Pick", options: ["a", "b"] }, 7, false);
  assert.ok(r.text.includes("<b>Pick</b>"));
  const rows = r.buttons as { text: string; callback_data: string }[][];
  assert.deepEqual(rows[0].map((b) => b.callback_data), ["da:7:0", "da:7:1"]);
  assert.deepEqual(rows[rows.length - 1].map((b) => b.callback_data), ["dc:7"]);
});

test("renderDialog confirm: Yes/No buttons, no cancel row", () => {
  const r = renderDialog({ kind: "confirm", title: "Sure?", message: "m & <x>" }, 3, false);
  assert.ok(r.text.includes("Sure?") && r.text.includes("m &amp; &lt;x&gt;"));
  const flat = (r.buttons as { callback_data: string }[][]).flat();
  assert.deepEqual(flat.map((b) => b.callback_data), ["da:3:0", "da:3:1"]);
});

test("show: unpaired (no chatId) or disabled → undefined, nothing sent", async () => {
  const d1 = new PendingDialogs(deps({ chatId: undefined }));
  assert.equal(await d1.show({ kind: "confirm", title: "t", message: "m" }), undefined);
  const d2 = new PendingDialogs(deps({ enabled: false }));
  assert.equal(await d2.show({ kind: "confirm", title: "t", message: "m" }), undefined);
});

test("show + tgAnswer(option): resolves the race, stamps ✔️, removes the dialog", async () => {
  const d = new PendingDialogs(deps());
  const id = await d.show({ kind: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(id, 1);
  const answer = new Promise<unknown>((res) => d.answer(1, res));
  assert.equal(d.tgAnswer(1, { kind: "option", index: 1 }), true);
  assert.equal(await answer, { kind: "option", index: 1 });
  assert.equal(d.isDialogMessage(100), false); // the sent message id (FakeOut starts at 100) is released
  const lastEdit = d.out().calls.filter((c) => c.kind === "edit").pop()!;
  assert.ok(String(lastEdit.text).includes("answered: b"));
});

test("tgAnswer on unknown id → false (stale tap), nothing sent", async () => {
  const d = new PendingDialogs(deps());
  assert.equal(d.tgAnswer(99, { kind: "cancel" }), false);
});

test("tuiAnswered: releases the dialog, stamp says terminal, race resolves 'expired'", async () => {
  const d = new PendingDialogs(deps());
  await d.show({ kind: "confirm", title: "Sure?", message: "m" });
  const answer = new Promise<unknown>((res) => d.answer(1, res));
  d.tuiAnswered(1, "Yes");
  assert.equal(await answer, { kind: "expired" });
  const lastEdit = (d.out() as FakeOut).calls.filter((c) => c.kind => c.kind === "edit").pop();
  assert.ok(String(lastEdit?.text).includes("terminal"));
});
```

> NOTE for the implementer: `PendingDialogs` must expose a read-only `out` accessor for tests (or construct `FakeOut` outside and pass it in and keep a local reference — prefer keeping the local reference in the test instead of adding an accessor; adjust the two `d.out()` usages to the local `FakeOut` you passed into `deps()`).

**Step 2: Run test to verify it fails**

Run: `node --test tests/ui-dialogs.test.ts`
Expected: FAIL — `Cannot find module '../src/ui-dialogs.ts'`.

**Step 3: Implement `src/ui-dialogs.ts` (core part)**

```ts
import type { Out } from "./session-bridge.ts";
import { CB } from "./router.ts";
import { escapeHtml } from "./markdown.ts";

/** Dialog kinds that can be mirrored to Telegram (pi's custom() is not — it is an arbitrary TUI component). */
export type DialogKind = "select" | "confirm" | "input" | "editor";

export interface DialogSpec {
  kind: DialogKind;
  title: string;
  options?: string[]; // select
  message?: string; // confirm
  placeholder?: string; // input
  prefill?: string; // editor (informational only — the phone answer is always fresh text)
}

/** What happened on the Telegram side (or "expired": the TUI side won / the dialog was torn down). */
export type DialogAnswer =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string }
  | { kind: "cancel" }
  | { kind: "expired" };

/** What the bridge hands us from Telegram (never "expired"). */
export type DialogTgInput = { kind: "option"; index: number } | { kind: "text"; text: string } | { kind: "cancel" };

export interface PendingDialogsDeps {
  out: Out;
  getChatId(): number | undefined;
  /** cfg.mirrorDialogs — the master switch. */
  enabled(): boolean;
  notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}

interface Pending {
  chatId: number;
  spec: DialogSpec;
  messageId: number;
  numbered: boolean;
  resolve: (a: DialogAnswer) => void;
}

/** select/confirm render as inline buttons up to this many options; beyond that the owner replies with a number. */
export const MAX_BUTTON_OPTIONS = 20;

/** Pure rendering of a dialog into Telegram HTML + inline keyboard rows (one testable unit). */
export function renderDialog(spec: DialogSpec, id: number, numbered: boolean): { text: string; buttons: { text: string; callback_data: string }[][] } {
  const t = escapeHtml(spec.title);
  if (spec.kind === "confirm") {
    return {
      text: `🔔 <b>${t}</b>\n${escapeHtml(spec.message ?? "")}`,
      buttons: [[{ text: "✅ Yes", callback_data: CB.dialogAnswer(id, 0) }, { text: "❌ No", callback_data: CB.dialogAnswer(id, 1) }]],
    };
  }
  if (spec.kind === "select" && !numbered && (spec.options?.length ?? 0) > 0) {
    return {
      text: `🔔 <b>${t}</b>\nChoose an option:`,
      buttons: [
        ...(spec.options ?? []).map((o, i) => [{ text: `${i + 1}. ${escapeHtml(o.slice(0, 60))}`, callback_data: CB.dialogAnswer(id, i) }]),
        [{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }],
      ],
    };
  }
  if (spec.kind === "select" && numbered) {
    const lines = (spec.options ?? []).map((o, i) => `${i + 1}. ${o.slice(0, 80)}`).join("\n");
    return {
      text: `🔔 <b>${t}</b>\nReply with the option number:\n${lines}`,
      buttons: [[{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }]],
    };
  }
  // input / editor
  return {
    text: `✏️ <b>${t}</b>\nReply to this message with your answer${spec.placeholder ? ` (${escapeHtml(spec.placeholder)})` : ""}.`,
    buttons: [[{ text: "✖ Cancel", callback_data: CB.dialogCancel(id) }]],
  };
}

export class PendingDialogs {
  private deps: PendingDialogsDeps;
  private nextId = 1;
  private byId = new Map<number, Pending>();
  private byMessageId = new Map<number, number>(); // Telegram message id → dialog id (reply routing)

  constructor(deps: PendingDialogsDeps) {
    this.deps = deps; // parameter properties are NOT erasable — Node type-stripping forbids them
  }

  isDialogMessage(messageId: number): boolean {
    return this.byIdMessage(messageId) !== undefined;
  }

  dialogIdForMessage(messageId: number): number | undefined {
    return this.byIdMessage(messageId);
  }

  private byIdMessage(messageId: number): number | undefined {
    return this.byMessageId.get(messageId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Register + send the Telegram dialog. Resolves to the dialog id, or undefined when it
   *  cannot be shown (unpaired / disabled / send failed) — the caller then stays TUI-only. */
  async show(spec: DialogSpec): Promise<number | undefined> {
    const chatId = this.deps.getChatId();
    if (!this.deps.enabled() || chatId === undefined) return undefined;
    const id = this.nextId++;
    let resolveFn: (a: DialogAnswer) => void = () => {};
    const p: Pending = {
      chatId,
      spec,
      messageId: -1,
      numbered: spec.kind === "select" && (spec.options?.length ?? 0) > MAX_BUTTON_OPTIONS,
      resolve: (a) => {
        resolveFn(a);
      },
    };
    this.byId.set(id, p);
    const { text, buttons } = renderDialog(spec, id, p.numbered);
    let sent: number | undefined;
    try {
      sent = await this.deps.out.send(chatId, text, { replyMarkup: { inline_keyboard: buttons } });
    } catch (err) {
      this.deps.notify?.(`pi-telega: dialog send failed: ${String(err)}`, "error");
      this.release(id, { kind: "expired" });
      return undefined;
    }
    if (sent === undefined) {
      this.release(id, { kind: "expired" });
      return undefined;
    }
    p.messageId = sent;
    this.byMessageId.set(sent, id);
    return id;
  }

  /** Attach the race resolver (wiring's installUiProxy). */
  answer(id: number, resolve: (a: DialogAnswer) => void): void {
    const p = this.byId.get(id);
    if (p) p.resolve = resolve;
  }

  /** Telegram side answered (bridge dispatch). false = stale (already answered / unknown id). */
  tgAnswer(dialogId: number, input: DialogTgInput): boolean {
    const p = this.byId.get(dialogId);
    if (!p) return false;
    if (p.numbered && input.kind === "text") {
      const n = Number(input.text.trim());
      if (!Number.isInteger(n) || n < 1 || n > (p.spec.options?.length ?? 0)) return false; // ignore — dialog stays open
      input = { kind: "option", index: n - 1 };
    }
    const stamp =
      input.kind === "option"
        ? `✔️ ${p.spec.title}: answered: ${(p.spec.options ?? [])[input.index] ?? `#${input.index + 1}`}`
        : input.kind === "text"
          ? `✔️ ${p.spec.title}: answered (see reply)`
          : `✖️ ${p.spec.title}: cancelled`;
    void this.deps.out.edit(p.chatId, p.messageId, stamp, { parseMode: null }).catch(() => {});
    this.release(dialogId, input);
    return true;
  }

  /** The TUI side resolved first (or timed out): stamp + release. */
  tuiAnswered(dialogId: number, value: unknown): void {
    const p = this.byId.get(dialogId);
    if (!p) return;
    const stamp = value === undefined ? `💻 ${p.spec.title}: cancelled in the terminal` : `💻 ${p.spec.title}: answered in the terminal`;
    void this.deps.out.edit(p.chatId, p.messageId, stamp, { parseMode: null }).catch(() => {});
    this.release(dialogId, { kind: "expired" });
  }

  /** Instance swap / shutdown: stamp + release everything (best effort, synchronous). */
  cancelAll(): void {
    for (const id of [...this.byId.keys()]) {
      const p = this.byId.get(id)!;
      void this.deps.out.edit(p.chatId, p.messageId, `⚠️ ${p.spec.title}: expired`, { parseMode: null }).catch(() => {});
      this.release(id, { kind: "expired" });
    }
  }

  private release(dialogId: number, a: DialogAnswer): void {
    const p = this.byId.get(dialogId);
    if (!p) return;
    this.byId.delete(dialogId);
    this.byMessageId.delete(p.messageId);
    p.resolve(a);
  }
}
```

**Step 4: Router dependency** — `CB.dialogAnswer`/`CB.dialogCancel` do not exist yet (Task 4). For THIS task add only to `src/router.ts` (router routing comes in Task 4):

```ts
dialogAnswer: (d: number, i: number) => `da:${d}:${i}`,
dialogCancel: (d: number) => `dc:${d}`,
```

Run: `npx tsc --noEmit` && `node --test tests/ui-dialogs.test.ts` → pass. Then full `node --test` (boundary test must still pass — `src/ui-dialogs.ts` imports only pi-free modules).

**Step 5: Commit** — `git add src/ui-dialogs.ts tests/ui-dialogs.test.ts src/router.ts && git commit -m "feat(dialogs): PendingDialogs core — button dialogs, stamps, lifecycle"`

---

## Task 3: `PendingDialogs` — text replies, numbered select, reply routing

**TDD scenario:** Modifying tested code — tests first, then fix gaps. (Task 2's `renderDialog`/`show`/`tgAnswer` already implement these paths; this task locks them with tests and fixes whatever the tests reveal.)

**Files:**
- Test: `tests/ui-dialogs.test.ts` (append)
- Modify: `src/ui-dialogs.ts` (only if a test fails)

**Step 1: Write the failing tests** — append to `tests/ui-dialogs.test.ts`:

```ts
test("input: reply-based message with cancel button; tgAnswer(text) resolves {kind:'text'}", async () => {
  const out = new FakeOut();
  const d = new PendingDialogs({ out, getChatId: () => 42, enabled: () => true });
  const id = await d.show({ kind: "input", title: "Name", placeholder: "e.g. alpha" });
  assert.equal(id, 1);
  const sent = out.calls.filter((c) => c.kind === "send").pop()!;
  assert.ok(String(sent.text).includes("Reply to this message"));
  assert.ok(String(sent.text).includes("e.g. alpha"));
  const answer = new Promise<unknown>((res) => d.answer(1, res));
  assert.equal(d.tgAnswer(1, { kind: "text", text: "hello" }), true);
  assert.equal(await answer, { kind: "text", text: "hello" });
});

test("numbered select (>20 options): numbered list, numeric reply → option, non-numeric ignored (stays open)", async () => {
  const out = new FakeOut();
  const d = new PendingDialogs({ out, getChatId: () => 42, enabled: () => true });
  const opts = Array.from({ length: 25 }, (_, i) => `opt${i}`);
  const id = await d.show({ kind: "select", title: "Many", options: opts });
  const sent = out.calls.filter((c) => c.kind === "send").pop()!;
  assert.ok(String(sent.text).includes("Reply with the option number"));
  assert.ok(String(sent.text).includes("25. opt24"));
  const answer = new Promise<unknown>((res) => d.answer(1, res));
  assert.equal(d.tgAnswer(1, { kind: "text", text: "not a number" }), false, "ignored — dialog stays open");
  assert.equal(d.size, 1);
  assert.equal(d.tgAnswer(1, { kind: "text", text: " 25 " }), true, "whitespace-padded number accepted");
  assert.equal(await answer, { kind: "option", index: 24 });
});

test("reply routing: isDialogMessage / dialogIdForMessage track the SENT message id", async () => {
  const out = new FakeOut();
  const d = new PendingDialogs({ out, getChatId: () => 42, enabled: () => true });
  await d.show({ kind: "input", title: "t" }); // FakeOut sends message id 100
  assert.equal(d.isDialogMessage(100), true);
  assert.equal(d.dialogIdForMessage(100), 1);
  assert.equal(d.isDialogMessage(101), false);
  d.tuiAnswered(1, undefined);
  assert.equal(d.isDialogMessage(100), false, "released after TUI-side answer");
});

test("cancelAll: stamps every pending and releases with 'expired'", async () => {
  const out = new FakeOut();
  const d = new PendingDialogs({ out, getChatId: () => 42, enabled: () => true });
  await d.show({ kind: "confirm", title: "A", message: "m" });
  await d.show({ kind: "input", title: "B" });
  const a1 = new Promise<unknown>((res) => d.answer(1, res));
  const a2 = new Promise<unknown>((res) => d.answer(2, res));
  d.cancelAll();
  assert.equal(await a1, { kind: "expired" });
  assert.equal(await a2, { kind: "expired" });
  assert.equal(d.size, 0);
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 2);
  assert.ok(edits.every((e) => String(e.text).includes("expired")));
});

test("show: send failure → notify + undefined (TUI-only fallback)", async () => {
  const out = new FakeOut();
  out.sendFailsWith = new Error("network down");
  const notes: string[] = [];
  const d = new PendingDialogs({ out, getChatId: () => 42, enabled: () => true, notify: (m) => notes.push(m) });
  assert.equal(await d.show({ kind: "confirm", title: "t", message: "m" }), undefined);
  assert.equal(d.size, 0);
  assert.ok(notes.some((n) => n.includes("dialog send failed")));
});
```

**Step 2: Run tests** — `node --test tests/ui-dialogs.test.ts`. Fix any gap in `src/ui-dialogs.ts` until green. (Expected gaps: none — Task 2's implementation covers all of this; if one fails, the failure message points at the exact branch.)

**Step 3: Run full gate** — `npx tsc --noEmit` && `node --test` → all pass.

**Step 4: Commit** — `git add tests/ui-dialogs.test.ts src/ui-dialogs.ts && git commit -m "test(dialogs): lock text-reply, numbered-select and reply-routing behavior"`

---

## Task 4: Router — dialog callbacks + reply-to-dialog

**TDD scenario:** Modifying tested code — existing tests first, new cases after.

**Files:**
- Modify: `src/router.ts` (`CB` — already added in Task 2 — and `route`)
- Test: `tests/router.test.ts`

**Step 1: Write the failing tests** — append to `tests/router.test.ts`:

```ts
test("dialog callbacks: da:<id>:<idx> → dialogAnswer, dc:<id> → dialogCancel, owner-gated", () => {
  const cb = (data: string, fromId = 7): TgUpdate => ({
    update_id: 1,
    callback_query: { id: "cb", from: { id: fromId, is_bot: false }, data, message: { message_id: 5, date: 1, chat: { id: 42, type: "private" } } },
  });
  assert.deepEqual(route(cb("da:3:1"), 7), { kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 1 });
  assert.deepEqual(route(cb("dc:3"), 7), { kind: "dialogCancel", chatId: 42, dialogId: 3 });
  assert.equal(route(cb("da:3:1"), 8).kind, "notAuthorized");
  assert.equal(route(cb("da:x:1"), 7).kind, "ignore"); // malformed → ignore (never crash)
  assert.equal(route(cb("da:3:x"), 7).kind, "ignore");
});

test("reply to a dialog message → dialogText (even when it looks like a command); reply to other messages stays a prompt", () => {
  const msg = (text: string, replyTo?: number): TgUpdate => ({
    update_id: 1,
    message: { message_id: 9, date: 1, chat: { id: 42, type: "private" }, from: { id: 7, is_bot: false }, text, ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo } } : {}) },
  });
  const isDialog = (id: number) => id === 100;
  assert.deepEqual(route(msg("hello", 100), 7, { isDialogMessage: isDialog }), { kind: "dialogText", chatId: 42, replyToMessageId: 100, text: "hello" });
  assert.deepEqual(route(msg("/stop", 100), 7, { isDialogMessage: isDialog }), { kind: "dialogText", chatId: 42, replyToMessageId: 100, text: "/stop" });
  assert.deepEqual(route(msg("hello", 101), 7, { isDialogMessage: isDialog }), { kind: "prompt", chatId: 42, text: "hello" });
  assert.deepEqual(route(msg("hello", 100), 7), { kind: "prompt", chatId: 42, text: "hello" }); // no mapper (tests/legacy) → prompt
});
```

**Step 2: Run test to verify it fails** — `node --test tests/router.test.ts` → FAIL (dialogAnswer/dialogCancel/dialogText unknown; third arg ignored).

**Step 3: Implement in `src/router.ts`**

- `TgAction`: add
  ```ts
  | { kind: "dialogAnswer"; chatId: number; dialogId: number; index: number }
  | { kind: "dialogCancel"; chatId: number; dialogId: number }
  | { kind: "dialogText"; chatId: number; replyToMessageId: number; text: string };
  ```
- `route` signature: `export function route(update: TgUpdate, ownerId: number | undefined, opts?: { isDialogMessage?: (messageId: number) => boolean }): TgAction`
- Callback branch (after the `c:` case, before `return { kind: "ignore" }`):
  ```ts
  if (d.startsWith("da:")) {
    const [ds, is] = d.slice(3).split(":");
    const dialogId = Number(ds);
    const index = Number(is);
    if (Number.isInteger(dialogId) && dialogId > 0 && Number.isInteger(index) && index >= 0)
      return { kind: "dialogAnswer", chatId, dialogId, index };
    return { kind: "ignore" };
  }
  if (d.startsWith("dc:")) {
    const dialogId = Number(d.slice(3));
    if (Number.isInteger(dialogId) && dialogId > 0) return { kind: "dialogCancel", chatId, dialogId };
    return { kind: "ignore" };
  }
  ```
- Message branch — AFTER the `fromId !== ownerId` gate, BEFORE `const cmd = CMD_RE.exec(text)`:
  ```ts
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo !== undefined && opts?.isDialogMessage?.(replyTo))
    return { kind: "dialogText", chatId, replyToMessageId: replyTo, text };
  ```

**Step 4: Run tests** — `node --test tests/router.test.ts` → pass; then `npx tsc --noEmit` && `node --test` (the command-args default branch will now mis-encode the new kinds, but nothing routes to them yet; if an existing test breaks, fix it in Task 5).

**Step 5: Commit** — `git add src/router.ts tests/router.test.ts && git commit -m "feat(dialogs): router — da:/dc: callbacks + reply-to-dialog ⇒ dialogText"`

---

## Task 5: command-args — encode/parse the dialog actions

**TDD scenario:** Modifying tested code — TDD cycle.

**Files:**
- Modify: `src/command-args.ts`
- Test: `tests/command-args.test.ts`

**Step 1: Write the failing tests** — append to `tests/command-args.test.ts`:

```ts
test("dialog actions round-trip", () => {
  const a1: TgAction = { kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 7 };
  assert.deepEqual(parseInternal(encodeInternal(a1)!), a1);
  const a2: TgAction = { kind: "dialogCancel", chatId: 42, dialogId: 3 };
  assert.deepEqual(parseInternal(encodeInternal(a2)!), a2);
  const a3: TgAction = { kind: "dialogText", chatId: 42, replyToMessageId: 100, text: "it's a \"reply\" /stop" };
  assert.deepEqual(parseInternal(encodeInternal(a3)!), a3);
  // malformed → null (never crash)
  assert.equal(parseInternal("internal dialogAnswer 42 x 1"), null);
  assert.equal(parseInternal("internal dialogAnswer 42 3 -1"), null);
  assert.equal(parseInternal("internal dialogText 42 notjson"), null);
  assert.equal(parseInternal("internal dialogText 42 {}"), null); // missing fields
});
```

**Step 2: Run test to verify it fails** — `node --test tests/command-args.test.ts` → FAIL (`encodeInternal` falls into the default branch / `parseInternal` returns null).

**Step 3: Implement in `src/command-args.ts`**

`encodeInternal` — add cases (before the `default`):
```ts
case "dialogAnswer":
  return `internal dialogAnswer ${action.chatId} ${action.dialogId} ${action.index}`;
case "dialogCancel":
  return `internal dialogCancel ${action.chatId} ${action.dialogId}`;
case "dialogText":
  return `internal dialogText ${action.chatId} ${JSON.stringify({ r: action.replyToMessageId, t: action.text })}`;
```

`parseInternal` — add (in the `switch (kind)`):
```ts
case "dialogAnswer": {
  const partsRest = rest.split(/\s+/);
  if (partsRest.length !== 2) return null;
  const dialogId = Number(partsRest[0]);
  const index = Number(partsRest[1]);
  if (!Number.isInteger(dialogId) || dialogId <= 0 || !Number.isInteger(index) || index < 0) return null;
  return { kind: "dialogAnswer", chatId, dialogId, index };
}
case "dialogCancel": {
  const dialogId = Number(rest);
  if (!Number.isInteger(dialogId) || dialogId <= 0) return null;
  return { kind: "dialogCancel", chatId, dialogId };
}
case "dialogText": {
  try {
    const v: unknown = JSON.parse(rest);
    if (!v || typeof v !== "object") return null;
    const o = v as { r?: unknown; t?: unknown };
    if (typeof o.r !== "number" || !Number.isInteger(o.r) || o.r <= 0 || typeof o.t !== "string") return null;
    return { kind: "dialogText", chatId, replyToMessageId: o.r, text: o.t };
  } catch {
    return null;
  }
}
```

**Step 4: Run tests** — `node --test tests/command-args.test.ts` → pass; then `npx tsc --noEmit` && `node --test` → all pass.

**Step 5: Commit** — `git add src/command-args.ts tests/command-args.test.ts && git commit -m "feat(dialogs): command-args — encode/parse dialog actions"`

---

## Task 6: Bridge — dispatch the dialog actions

**TDD scenario:** Modifying tested code — TDD cycle.

**Files:**
- Modify: `src/session-bridge.ts` (`BridgeDeps` + `handle`)
- Test: `tests/bridge-dialogs.test.ts` (new)

**Step 1: Write the failing tests** — create `tests/bridge-dialogs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge } from "../src/session-bridge.ts";
import type { DialogsPort } from "../src/session-bridge.ts";
import { FakePi } from "./fake-pi.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeDeps } from "./helpers.ts";

test("dialogAnswer / dialogCancel / dialogText dispatch to the dialogs port", async () => {
  const calls: unknown[] = [];
  const port: DialogsPort = {
    tgAnswer: (id, input) => {
      calls.push(["tg", id, input]);
      return true;
    },
    dialogIdForMessage: (m) => (m === 100 ? 7 : undefined),
  };
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), new FakeOut(), {}));
  (bridge as unknown as { deps: { dialogs?: DialogsPort } }).deps.dialogs = port; // test seam: set after construction
  const out = new FakeOut();
  // re-wire: construct properly instead of poking (replace the line above with this):
  const bridge2 = new SessionBridge({ ...makeDeps(new FakePi().build(), out), dialogs: port });
  await bridge2.dispatch({ kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 1 });
  await bridge2.dispatch({ kind: "dialogCancel", chatId: 42, dialogId: 3 });
  await bridge2.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 100, text: "hello" });
  await bridge2.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 999, text: "orphan" });
  assert.deepEqual(calls, [
    ["tg", 3, { kind: "option", index: 1 }],
    ["tg", 3, { kind: "cancel" }],
    ["tg", 7, { kind: "text", text: "hello" }],
  ]);
  assert.equal(out.calls.length, 0, "stale/orphan dialog actions are silent (no sends)");
});

test("no dialogs port (flag off at wiring) → dialog actions are silent no-ops", async () => {
  const out = new FakeOut();
  const bridge = new SessionBridge(makeDeps(new FakePi().build(), out));
  await bridge.dispatch({ kind: "dialogAnswer", chatId: 42, dialogId: 3, index: 0 });
  await bridge.dispatch({ kind: "dialogText", chatId: 42, replyToMessageId: 1, text: "x" });
  assert.equal(out.calls.length, 0);
  assert.equal(out.calls.length, 0); // no crash, no noise
});
```

> NOTE for the implementer: the first test contains a deliberate simplification — DELETE the `bridge`/poke lines and keep only the clean `bridge2` construction via `makeDeps(..., cfg)` + `dialogs` spread (i.e. `new SessionBridge({ ...makeDeps(pi, out), dialogs: port })`). The final test file must not contain the poke.

**Step 2: Run test to verify it fails** — `node --test tests/bridge-dialogs.test.ts` → FAIL (`DialogsPort` not exported / `dialogs` not in `BridgeDeps`).

**Step 3: Implement in `src/session-bridge.ts`**

```ts
/** Structural view of the dialog host (src/ui-dialogs.ts) — keeps the bridge pi-free & testable. */
export interface DialogsPort {
  tgAnswer(dialogId: number, input: { kind: "option"; index: number } | { kind: "text"; text: string } | { kind: "cancel" }): boolean;
  dialogIdForMessage(messageId: number): number | undefined;
}
```
- `BridgeDeps`: add `/** Dialog mirroring host (absent when mirrorDialogs is off or tests don't exercise it). */ dialogs?: DialogsPort;`
- `handle(action)` — add cases (next to the other leaf cases):
  ```ts
  case "dialogAnswer":
    this.deps.dialogs?.tgAnswer(action.dialogId, { kind: "option", index: action.index });
    return;
  case "dialogCancel":
    this.deps.dialogs?.tgAnswer(action.dialogId, { kind: "cancel" });
    return;
  case "dialogText": {
    const id = this.deps.dialogs?.dialogIdForMessage(action.replyToMessageId);
    if (id !== undefined) this.deps.dialogs?.tgAnswer(id, { kind: "text", text: action.text });
    return;
  }
  ```

**Step 4: Run tests** — `node --test tests/bridge-dialogs.test.ts` → pass; then `npx tsc --noEmit` && `node --test` → all pass.

**Step 5: Commit** — `git add src/session-bridge.ts tests/bridge-dialogs.test.ts && git commit -m "feat(dialogs): bridge dispatch for dialogAnswer/dialogCancel/dialogText"`

---

## Task 7: `installUiProxy` — the in-place ctx.ui patch + race (wiring.ts)

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/wiring.ts` (append the proxy section)
- Test: `tests/wiring.test.ts` (append)

**Step 1: Write the failing tests** — append to `tests/wiring.test.ts` (imports: `installUiProxy, UI_PROXY_MARKER, type UiDialogHost, type UiDialogAnswer` from `../src/wiring.ts`):

```ts
// ── TUI dialog mirroring (Option A) ──

function fakeTuiDialog<T = string | undefined>() {
  let press: (v?: T) => void = () => {};
  let opened = 0;
  const fn = (_title: string, _args?: unknown, opts?: { signal?: AbortSignal; timeout?: number }) =>
    new Promise<T | undefined>((resolve) => {
      opened++;
      if (opts?.signal?.aborted) return resolve(undefined);
      const onAbort = () => resolve(undefined);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      press = (v) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
    });
  return { fn, press, opened: () => opened };
}

function fakeHost(over: { enabled?: () => boolean; showResult?: number | undefined } = {}) {
  const calls = {
    show: 0,
    tuiAnswered: [] as [number, unknown][],
    answers: new Map<number, (a: UiDialogAnswer) => void>(),
  };
  const host: UiDialogHost = {
    enabled: () => (over.enabled ? over.enabled() : true),
    show: async () => {
      calls.show++;
      return over.showResult === undefined ? 1 : over.showResult;
    },
    answer: (id, resolve) => calls.answers.set(id, resolve),
    tuiAnswered: (id, value) => calls.tuiAnswered.push([id, value]),
  };
  return { host, calls };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("installUiProxy: patches all four methods, idempotent, returns true", () => {
  const { host } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: () => {}, editor: () => {} };
  assert.equal(installUiProxy(ui as never, host), true);
  assert.ok(ui[UI_PROXY_MARKER as never]);
  assert.notEqual(ui.select, () => {}); // replaced
  assert.equal(installUiProxy(ui as never, host), true, "second install is a no-op");
});

test("installUiProxy: getter-only property → throws-safe false + warn, no marker", () => {
  const { host } = fakeHost();
  const obj: Record<string, unknown> = {};
  Object.defineProperty(obj, "select", { get: () => () => {} });
  const warns: string[] = [];
  assert.equal(installUiProxy(obj as never, host, (m) => warns.push(m)), false);
  assert.ok(!obj[UI_PROXY_MARKER as never]);
  assert.ok(warns.length >= 1);
});

test("wrapped select: TG tap wins → resolves the option; TUI dialog gets aborted; no tuiAnswered", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a", "b"]);
  await tick(); // wrapper awaits host.show before opening the TUI dialog
  assert.equal(calls.show, 1);
  assert.equal(sel.opened(), 1);
  calls.answers.get(1)!({ kind: "option", index: 1 });
  assert.equal(await p, "b");
  assert.equal(calls.tuiAnswered.length, 0, "TG side won — no terminal stamp bookkeeping");
  sel.press("a"); // the abort already resolved the fake with undefined — harmless
});

test("wrapped select: terminal key wins → resolves the TUI value; late TG tap ignored; tuiAnswered called", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a", "b"]);
  await tick();
  sel.press("a");
  assert.equal(await p, "a");
  assert.deepEqual(calls.tuiAnswered, [[1, "a"]]);
  calls.answers.get(1)!({ kind: "option", index: 1 }); // stale TG tap after TUI win
  await tick();
  assert.equal(calls.tuiAnswered.length, 1, "late TG answer ignored");
});

test("wrapped confirm: TG 'No' → false; TG cancel → false", async () => {
  const sel = fakeTuiDialog<boolean>();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: sel.fn, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p1 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await tick();
  calls.answers.get(1)!({ kind: "option", index: 1 });
  assert.equal(await p1, false);
  const p2 = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Sure?", "m");
  await tick();
  calls.answers.get(2)!({ kind: "cancel" });
  assert.equal(await p2, false);
});

test("wrapped input: TG text → resolves the text; cancel → undefined", async () => {
  const inp = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: () => {}, confirm: () => {}, input: inp.fn, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.input as (t: string) => Promise<string | undefined>)("Name");
  await tick();
  calls.answers.get(1)!({ kind: "text", text: "hello" });
  assert.equal(await p, "hello");
  const p2 = (ui.input as (t: string) => Promise<string | undefined>)("Name");
  await tick();
  calls.answers.get(2)!({ kind: "cancel" });
  assert.equal(await p2, undefined);
});

test("wrapped select: host disabled → plain passthrough (no show, no race)", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost({ enabled: () => false });
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  sel.press("a");
  assert.equal(await p, "a");
  assert.equal(calls.show, 0);
});

test("wrapped select: show → undefined (unpaired) → TUI-only passthrough", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost({ showResult: undefined });
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const p = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["a"]);
  await tick();
  assert.equal(calls.show, 1);
  sel.press("a");
  assert.equal(await p, "a");
  assert.equal(calls.answers.size, 0, "no race registered when TG dialog never went out");
});

test("wrapped select: caller-provided signal is COMBINED (caller abort still dismisses the TUI dialog)", async () => {
  const sel = fakeTuiDialog();
  const { host, calls } = fakeHost();
  const ui = { select: sel.fn, confirm: () => {}, input: () => {}, editor: () => {} };
  installUiProxy(ui as never, host);
  const ac = new AbortController();
  const p = (ui.select as (t: string, o: string[], o3?: { signal?: AbortSignal }) => Promise<string | undefined>)("Pick", ["a"], { signal: ac.signal });
  await tick();
  ac.abort(); // the caller (extension) aborts its own dialog
  assert.equal(await p, undefined);
  assert.deepEqual(calls.tuiAnswered, [[1, undefined]]);
});
```

**Step 2: Run test to verify it fails** — `node --test tests/wiring.test.ts` → FAIL (`installUiProxy` not exported).

**Step 3: Implement — append to `src/wiring.ts`**

```ts
// ── TUI dialog mirroring (Option A) ─────────────────────────────────────────
// pi's ctx.ui is ONE shared plain object (runner.uiContext, wrapped by pi's
// wrapUIPromptContext) that EVERY extension's ctx resolves live. We patch its
// dialog methods in place: the real TUI dialog opens as usual while a Telegram
// twin goes out; the first resolution wins. TG win ⇒ the TUI dialog is
// dismissed via the combined AbortSignal (pi's supported dismiss path); TUI
// win ⇒ host.tuiAnswered stamps the Telegram message. custom() is NOT
// mirrorable (arbitrary component) — it stays TUI-only with the existing
// ui_prompt_start heads-up. Verified against pi 0.87.1: select/confirm/input
// accept opts.signal (abort ⇒ resolve(undefined)); editor has NO opts (a TG-
// first answer leaves the TUI editor open until Esc — its late resolution is
// discarded harmlessly).

export interface UiDialogSpec {
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}

export type UiDialogAnswer =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string }
  | { kind: "cancel" }
  | { kind: "expired" };

/** Implemented by PendingDialogs (src/ui-dialogs.ts). */
export interface UiDialogHost {
  /** cfg.mirrorDialogs master switch. */
  enabled(): boolean;
  /** Register + send the Telegram twin. undefined = cannot show (unpaired/disabled/send failed) → TUI-only. */
  show(spec: UiDialogSpec): Promise<number | undefined>;
  /** Attach the race resolver for a shown dialog. */
  answer(id: number, resolve: (a: UiDialogAnswer) => void): void;
  /** The TUI side resolved first (or timed out): stamp + release. */
  tuiAnswered(id: number, value: unknown): void;
}

export const UI_PROXY_MARKER = Symbol.for("pi-telega.ui-proxy");

function specFor(method: UiDialogSpec["kind"], args: unknown[]): UiDialogSpec {
  const [title, a2] = args;
  switch (method) {
    case "select":
      return { kind: "select", title: String(title), options: Array.isArray(a2) ? a2.map(String) : undefined };
    case "confirm":
      return { kind: "confirm", title: String(title), message: typeof a2 === "string" ? a2 : "" };
    case "input":
      return { kind: "input", title: String(title), placeholder: typeof a2 === "string" ? a2 : undefined };
    case "editor":
      return { kind: "editor", title: String(title), prefill: typeof a2 === "string" ? a2 : undefined };
  }
}

function mapAnswer(method: UiDialogSpec["kind"], args: unknown[], a: UiDialogAnswer): unknown {
  switch (method) {
    case "select": {
      const options = Array.isArray(args[1]) ? args[1] : [];
      return a.kind === "option" ? options[a.index] : undefined;
    }
    case "confirm":
      return a.kind === "option" ? a.index === 0 : false; // mirror pi: cancel ⇒ false
    case "input":
    case "editor":
      return a.kind === "text" ? a.text : undefined;
  }
}

/** select/confirm/input take opts LAST (maybe omitted); editor has no opts at all. */
function withCombinedSignal(
  method: UiDialogSpec["kind"],
  orig: (...a: unknown[]) => unknown,
  args: unknown[],
  signal: AbortSignal,
): unknown {
  if (method === "editor") return orig(...args);
  const next = [...args];
  const last = next[next.length - 1];
  if (last === undefined || (typeof last === "object" && !Array.isArray(last))) {
    const opts = (typeof last === "object" && last !== null ? last : {}) as { signal?: AbortSignal };
    next[next.length - 1] = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal };
  } else {
    next.push({ signal });
  }
  return orig(...next);
}

/**
 * Install the in-place proxy on the shared ctx.ui object. Idempotent (marker);
 * returns false (with a warn) when the object is not patchable or has no dialog
 * methods — the caller degrades to heads-up-only (today's behavior). Must be
 * re-called on every session_start: each runner swap creates a FRESH wrapped
 * object, so a previous patch never carries over.
 */
export function installUiProxy(ui: Record<PropertyKey, unknown>, host: UiDialogHost, warn?: (msg: string) => void): boolean {
  if (ui[UI_PROXY_MARKER]) return true;
  const methods = ["select", "confirm", "input", "editor"] as const;
  let patched = 0;
  for (const m of methods) {
    const orig = ui[m];
    if (typeof orig !== "function") continue;
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      if (!host.enabled()) return (orig as (...a: unknown[]) => unknown)(...args);
      const spec = specFor(m, args);
      let id: number | undefined;
      try {
        id = await host.show(spec);
      } catch {
        id = undefined;
      }
      if (id === undefined) return (orig as (...a: unknown[]) => unknown)(...args); // TG unavailable → TUI-only
      const ac = new AbortController();
      let tuiPromise: Promise<unknown>;
      try {
        tuiPromise = Promise.resolve(withCombinedSignal(m, orig, args, ac.signal));
      } catch (err) {
        host.tuiAnswered(id, undefined); // release the already-sent Telegram twin
        throw err; // propagate exactly as unmirrored pi would
      }
      const dialogId = id;
      return new Promise<unknown>((resolve, reject) => {
        let done = false;
        tuiPromise.then(
          (v) => {
            if (done) return;
            done = true;
            host.tuiAnswered(dialogId, v);
            resolve(v);
          },
          (err) => {
            if (done) return;
            done = true;
            host.tuiAnswered(dialogId, undefined);
            reject(err);
          },
        );
        host.answer(dialogId, (a) => {
          if (done || a.kind === "expired") return;
          done = true;
          ac.abort(); // dismiss the TUI dialog (select/confirm/input); editor has no signal — it stays open until Esc
          resolve(mapAnswer(m, args, a));
        });
      });
    };
    try {
      ui[m] = wrapped;
    } catch {
      // getter-only property (strict mode): the assignment throws — not patchable
      warn?.("pi-telega: ctx.ui is not patchable — dialog mirroring disabled (heads-up only)");
      return false;
    }
    if (ui[m] !== wrapped) {
      warn?.("pi-telega: ctx.ui is not patchable — dialog mirroring disabled (heads-up only)");
      return false;
    }
    patched++;
  }
  if (patched === 0) {
    warn?.("pi-telega: no dialog methods on ctx.ui — dialog mirroring disabled");
    return false;
  }
  ui[UI_PROXY_MARKER] = true;
  return true;
}
```

**Step 4: Run tests** — `node --test tests/wiring.test.ts` → pass; then `npx tsc --noEmit` && `node --test` → all pass (boundary test: wiring.ts remains pi-free).

**Step 5: Commit** — `git add src/wiring.ts tests/wiring.test.ts && git commit -m "feat(dialogs): installUiProxy — in-place ctx.ui patch with TG/TUI race"`

---

## Task 8: index.ts integration + end-to-end smoke test

**TDD scenario:** Modifying tested code — write the E2E test first, then wire.

**Files:**
- Modify: `index.ts`
- Test: `tests/index-smoke.test.ts`

**Step 1: Write the failing E2E test** — modify `tests/index-smoke.test.ts`:

(a) Extend the shared `fakeCtx` so the proxy has something to patch and the gate passes:
```ts
let selectPress: ((v?: string) => void) | undefined;
const fakeCtx = {
  cwd: "/tmp",
  mode: "tui",
  hasUI: true,
  ui: {
    notify: () => {},
    // mimics pi's showExtensionSelector: resolves on keypress OR opts.signal abort
    select: (_title: string, _options?: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => {
        if (opts?.signal?.aborted) return resolve(undefined);
        const onAbort = () => resolve(undefined);
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        selectPress = (v?: string) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          resolve(v);
        };
      }),
    confirm: () => Promise.resolve(false),
    input: () => Promise.resolve(undefined),
    editor: () => Promise.resolve(undefined),
  },
  sessionManager: { /* unchanged buildSessionContext as before */ },
};
```

(b) Replace the fake pi so the `/tg internal …` command round-trip is simulated (registerCommand captures the real handler; sendUserMessage replays it — exactly what real pi does):
```ts
const handlers = new Map<string, (...a: unknown[]) => unknown>();
let tgCommand: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
piTelega({
  registerCommand: (name: string, def: unknown) => {
    if (name === "tg") tgCommand = def as typeof tgCommand;
  },
  on: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn),
  sendUserMessage: (text: string, _opts?: unknown) => {
    if (typeof text === "string" && text.startsWith("/tg ") && tgCommand)
      void tgCommand.handler(text.slice(4), { ui: { notify: () => {} } });
  },
} as never);
```
(Existing tests keep passing: they only trigger the direct-dispatch `prompt` path, whose text never starts with `/tg `.)

(c) New test (append):
```ts
test("dialog mirroring E2E: extension select → TG buttons → owner tap wins (stamped); terminal key wins (stamped 'terminal')", async (t) => {
  const calls: WireCall[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let batch = 0;
  let resolveLongPoll: ((updates: unknown[]) => void) | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body, markdown: "" });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      batch++;
      if (batch === 1)
        // teaches the owner chat (42)
        return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, from: { id: 123456, is_bot: false, first_name: "O" }, text: "hi" } }] }), { status: 200 });
      // every later poll hangs until the test resolves it with a batch
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true }); }
        resolveLongPoll = (updates) => resolve(new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }));
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  handlers.get("session_start")!({}, fakeCtx);
  // wait until batch 1 was processed (the 2nd getUpdates went out = chat learned)
  await waitFor(() => calls.filter((c) => c.method === "getUpdates").length >= 2, "owner chat learned");

  // 1) TG tap wins: another extension asks via the shared ctx.ui
  const p1 = fakeCtx.ui.select("Pick flavor", ["vanilla", "chocolate"]);
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes("da:1:0")),
    "TG dialog with buttons on the wire",
  );
  resolveLongPoll!([{ update_id: 10, callback_query: { id: "cb1", from: { id: 123456, is_bot: false }, data: "da:1:1", message: { message_id: 200, date: 1, chat: { id: 42, type: "private" } } } }]);
  assert.equal(await p1, "chocolate", "the extension got the TAPPED option");
  await waitFor(
    () => calls.some((c) => c.method === "editMessageText" && String(c.body.text ?? "").includes("chocolate")),
    "✔️ stamp on the wire",
  );

  // 2) terminal key wins: the TUI answer resolves, the TG message is stamped 'terminal'
  const p2 = fakeCtx.ui.select("Pick again", ["a", "b"]);
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes("da:2:0")),
    "second TG dialog on the wire",
  );
  selectPress!("b");
  assert.equal(await p2, "b");
  await waitFor(
    () => calls.some((c) => c.method === "editMessageText" && String(c.body.text ?? "").includes("terminal")),
    "💻 terminal stamp on the wire",
  );
});
```

**Step 2: Run test to verify it fails** — `node --test tests/index-smoke.test.ts` → FAIL (no `sendMessage` with `da:1:0` — the proxy is not installed).

**Step 3: Implement in `index.ts`**

- Imports: `import { PendingDialogs } from "./src/ui-dialogs.ts";` and add `installUiProxy` to the wiring import line.
- Module state: `let dialogs: PendingDialogs | undefined;`
- `startPolling` — after `out = outAdapter;`:
  ```ts
  dialogs = new PendingDialogs({
    out: outAdapter,
    getChatId: () => ownerChatId,
    enabled: () => cfg.mirrorDialogs,
    notify: (m, l) => ui(m, l),
  });
  ```
  and add `dialogs,` to the bridge `deps` object.
- `handleUpdate`: `const action = route(update, cfg.ownerId, { isDialogMessage: (id) => dialogs?.isDialogMessage(id) ?? false });`
- `session_start` handler — after `const loop = startPolling();`:
  ```ts
  // TUI dialog mirroring (Option A): patch the NEW runner's shared ctx.ui object.
  // Every runner swap (new session / reload) creates a fresh wrapped object, so
  // this re-runs each session_start; the marker makes a repeat on the same
  // object a no-op. Non-tui modes (rpc/print) have no TUI dialogs to mirror.
  if (dialogs && ctx.mode === "tui" && ctx.hasUI)
    installUiProxy(ctx.ui as unknown as Record<PropertyKey, unknown>, dialogs, (m) => ui(m, "warning"));
  ```
- `session_shutdown` handler: add `dialogs?.cancelAll();` (stamp + release any pending dialogs — their TUI twins die with the old runner).

**Step 4: Run tests** — `node --test tests/index-smoke.test.ts` → pass (ALL smoke tests, including the pre-existing ones); then `npx tsc --noEmit` && `node --test` → all pass.

**Step 5: Commit** — `git add index.ts tests/index-smoke.test.ts && git commit -m "feat(dialogs): wire PendingDialogs + installUiProxy into the extension (E2E covered)"`

---

## Task 9: Docs + full verification

**TDD scenario:** Trivial change — judgment.

**Files:**
- Modify: `README.md`

**Step 1: README section** — add a `## Dialog mirroring` section (after the output-levels section) covering:
- Other extensions' TUI dialogs (`ctx.ui.select/confirm/input/editor`) are mirrored to the chat: select/confirm as inline buttons, input/editor as *reply to the dialog message*, >20 options as a numbered list + reply with the number.
- First answer wins: tap the phone → the terminal dialog dismisses itself and the message is stamped `✔️`; press a key in the terminal → the message is stamped `💻 answered in the terminal`.
- `custom()` (arbitrary terminal UI) is NOT mirrorable — it stays terminal-only with the usual "⚠️ terminal prompt" heads-up in the work log. `editor` caveat: if the phone answers first, the terminal editor stays open until Esc (pi gives it no programmatic dismiss).
- Config: `"mirrorDialogs": false` in `~/.pi/agent/pi-telega.json` disables mirroring (default `true`; independent of the output level).

**Step 2: Full verification** — run and read the output of BOTH:
```bash
npx tsc --noEmit          # must exit 0, no output
node --test               # all suites pass (was 345 tests before this feature; +~25 now)
```
Also confirm `git status` is clean after the commit and the branch has 10 commits (plan + 8 feature tasks + docs).

**Step 3: Commit** — `git add README.md && git commit -m "docs: dialog mirroring section in README"`

---

## Follow-ups (deliberately out of scope)

1. **`custom()` via key simulation (Option B):** reach the TUI through the `setWidget` factory, drive the focused component — the only route for arbitrary components; fragile, needs its own design.
2. **`notify` forwarding:** wrap `ctx.ui.notify` to forward extension toasts to the phone (TUI toasts are invisible on the phone today).
3. **Upstream API request:** a `respond()`/`cancel()` handle on `ui_prompt_start` (or a public `setUIContext`) would replace the in-place patch with a supported API.
4. **`/dialogs_on` / `/dialogs_off` bot commands** if the config-file toggle proves inconvenient.
5. **Telegram-side timeout:** only pi's `opts.timeout` cancels today; a bot-side deadline (e.g. 1 h) for pending text dialogs is a small `PendingDialogs` addition.
