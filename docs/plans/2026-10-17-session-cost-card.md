# Session Cost Card Line — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show the accumulated USD cost of the current session on the session (status) card, only when the session has spent > $0.

**Architecture:** `sessionUsage()` in `src/wiring.ts` already walks the session branch once per card render to sum assistant tokens; extend the same walk to sum `usage.cost.total` over assistant messages, `usage` entries, and `compaction`/`branch_summary` entries. `statusBlocks()` in `src/session-bridge.ts` adds a `💲 cost:` line after the tokens line when cost > 0, formatted by a new pure `fmtUsd` helper (adaptive precision) in `src/mirror.ts`.

**Tech Stack:** TypeScript (Node ≥ 24, type-stripping, `node --test`), pi-coding-agent extension API (`ctx.sessionManager.getBranch()`).

**Design doc:** `docs/plans/2026-10-17-session-cost-card-design.md` (scope, decisions, rationale — read it first).

**Test command:** `node --test tests/<file>.test.ts` (always pass a timeout; full suite: `node --test tests/*.test.ts`).

---

### Task 1: `fmtUsd` helper (pure)

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/mirror.ts` (add export next to `fmtTokens`, ~line 162)
- Test: `tests/mirror-usd.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/mirror-usd.test.ts`:

```ts
// fmtUsd — adaptive-precision USD for the session card's cost line.
// The line is only rendered when cost > 0, so the format must never
// produce a misleading $0.00 for a visible line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtUsd } from "../src/mirror.ts";

test("fmtUsd: >= $1 → 2 decimals", () => {
  assert.equal(fmtUsd(1), "$1.00");
  assert.equal(fmtUsd(0.45), "$0.450"); // 3-decimal band, not 2
  assert.equal(fmtUsd(12.345), "$12.35"); // rounds at the chosen width
});

test("fmtUsd: >= $0.01 → 3 decimals", () => {
  assert.equal(fmtUsd(0.01), "$0.010");
  assert.equal(fmtUsd(0.999), "$0.999"); // boundary: still below $1
  assert.equal(fmtUsd(0.4521), "$0.452");
});

test("fmtUsd: below $0.01 → 4 decimals", () => {
  assert.equal(fmtUsd(0.0099), "$0.0099");
  assert.equal(fmtUsd(0.00004), "$0.0000"); // known edge: sub-0.05¢ renders zero — accepted (design doc)
  assert.equal(fmtUsd(0), "$0.0000"); // 0 is never rendered (guard is in statusBlocks), but defined
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/mirror-usd.test.ts`
Expected: FAIL — `fmtUsd` is not exported from `src/mirror.ts` (import error).

**Step 3: Write minimal implementation**

In `src/mirror.ts`, after `fmtTokens` (~line 167):

```ts
/**
 * USD amount for the session card's cost line (adaptive precision — the
 * line is only shown for cost > 0, so this never renders a misleading
 * $0.00 for a visible line): `$1.23` ≥ $1, `$0.452` ≥ $0.01, `$0.0045` below.
 */
export function fmtUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/mirror-usd.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/mirror.ts tests/mirror-usd.test.ts
git commit -m "feat: fmtUsd — adaptive-precision USD formatting for the cost line"
```

---

### Task 2: `sessionUsage()` sums cost

**TDD scenario:** Modifying tested code — existing `wiring.test.ts:306` asserts `deepEqual` on the return shape and WILL fail when `cost` is added; update it in the same task.

**Files:**
- Modify: `src/wiring.ts:237-251` (`sessionUsage` impl)
- Test: `tests/wiring.test.ts` (update line ~306-321; add new test after it)

**Step 1: Write the failing test**

In `tests/wiring.test.ts`, update the existing test's expectation (line 321) from
`assert.deepEqual(t.sessionUsage(), { input: 150, output: 275 });`
to
`assert.deepEqual(t.sessionUsage(), { input: 150, output: 275, cost: 0 });`,
and add a new test after it:

```ts
test("makeTelegramPi: sessionUsage sums cost over assistant + usage + compaction/branch-summary entries (branch scope)", () => {
  const ctx = makeFakeCtx({
    sessionManager: {
      getSessionFile: () => "/proj/s.jsonl",
      getSessionName: () => undefined,
      getBranch: () => [
        { type: "message", message: { role: "user", content: "hi" } },
        { type: "message", message: { role: "assistant", usage: { input: 100, output: 200, cost: { total: 0.1 } } } },
        { type: "message", message: { role: "assistant", usage: { input: 50, output: 75 } } }, // local model — no cost field
        { type: "usage", kind: "cache_warm", usage: { input: 0, output: 0, totalTokens: 50000, cost: { total: 0.015 } } },
        { type: "compaction", usage: { input: 10, output: 20, cost: { total: 0.005 } } },
        { type: "branch_summary", usage: { cost: { total: 0.001 } } },
        { type: "usage", kind: "mystery-kind", usage: { cost: { total: 0.004 } } }, // unknown kinds count (docs)
      ],
    },
  });
  const t = makeTelegramPi({ pi: {} as PiLike, getCmdCtx: () => ctx, getSessionCtx: () => undefined, listSessions: async () => [] });
  assert.deepEqual(t.sessionUsage(), { input: 150, output: 275, cost: 0.125 });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/wiring.test.ts`
Expected: FAIL — `sessionUsage` returns `{ input, output }` without `cost` (both tests fail: deepEqual mismatch / missing cost).

**Step 3: Write minimal implementation**

Replace the `sessionUsage` impl in `src/wiring.ts` (~lines 237-251):

```ts
    // Cost = ALL cost-bearing entries on the branch (assistant messages +
    // `usage` entries of any kind + compaction/branch-summary generation) —
    // exact for the session being viewed, same branch scope as the tokens.
    sessionUsage: () => {
      let input = 0;
      let output = 0;
      let cost = 0;
      for (const e of ctx()?.sessionManager.getBranch() ?? []) {
        if (e.type === "message") {
          const m = e.message as
            | { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } }
            | undefined;
          if (m?.role !== "assistant") continue;
          input += m.usage?.input ?? 0;
          output += m.usage?.output ?? 0;
          cost += m.usage?.cost?.total ?? 0;
        } else if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") {
          cost += (e as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
        }
      }
      return { input, output, cost };
    },
```

**Step 4: Run test to verify it passes**

Run: `node --test tests/wiring.test.ts`
Expected: PASS (all).

**Step 5: Run the full suite** (the `TelegramPi` type change lands in Task 3; until then `tests/fake-pi.ts` still returns the 2-field shape — check nothing else broke):

Run: `node --test tests/*.test.ts`
Expected: PASS. If `tsc`/type checks complain about the widened return (it's a superset — `{input, output, cost}` is assignable to `{input, output}`, so nothing should), fix at the source.

**Step 6: Commit**

```bash
git add src/wiring.ts tests/wiring.test.ts
git commit -m "feat: sessionUsage sums session cost (assistant + usage + compaction/branch-summary)"
```

---

### Task 3: `💲 cost:` line on the session card

**TDD scenario:** Modifying tested code — `tests/bridge-core.test.ts` card-format tests pin the exact line list; the cost-0 case is already covered by them (line must NOT appear), the cost>0 case is new.

**Files:**
- Modify: `src/session-bridge.ts` (`TelegramPi.sessionUsage` type ~line 87-88; `statusBlocks` ~line 502-523; import line 12)
- Modify: `tests/fake-pi.ts:16,90` (option type + default)
- Test: `tests/bridge-core.test.ts` (new test after the "status: card format" test)

**Step 1: Write the failing test**

In `tests/bridge-core.test.ts`, after the `status: card format …` test:

```ts
test("status: 💲 cost line — only when cost > 0, right after the tokens line, adaptive precision", async () => {
  // cost 0.4521 → 3-decimal band; sits between 🪙 tokens and 📨 messages
  const pi = new FakePi({
    cwd: "/proj",
    model: { id: "m1", name: "Model One", provider: "p", reasoning: false },
    sessionUsage: { input: 12500, output: 128000, cost: 0.4521 },
  });
  const out = new FakeOut();
  await new SessionBridge(makeDeps(pi.build(), out)).dispatch({ kind: "status", chatId: 7 });
  const lines = lastRichText(out).split("\n");
  assert.deepEqual(lines, [
    "📌 Untitled session — idle · 🔊 full",
    "📁 dir: /proj",
    "🤖 model: Model One · 🧠 thinking: default",
    "📖 context: n/a",
    "🪙 tokens: ↑12.5k ↓128k",
    "💲 cost: $0.452",
    "📨 messages: 0",
  ]);

  // cost 0 → the line is absent entirely (local-model card is unchanged)
  const pi2 = new FakePi({ cwd: "/proj", sessionUsage: { input: 5, output: 6, cost: 0 } });
  const out2 = new FakeOut();
  await new SessionBridge(makeDeps(pi2.build(), out2)).dispatch({ kind: "status", chatId: 7 });
  assert.ok(!lastRichText(out2).includes("💲"), "no cost line at $0");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/bridge-core.test.ts`
Expected: FAIL — no `💲` line in the card (deepEqual mismatch on the line list).

**Step 3: Write minimal implementation**

In `src/session-bridge.ts`:

1. Import (line 12): add `fmtUsd` to the `./mirror.ts` import:
   `import { AUTO_COMPACT_STATUS, AUTO_COMPACT_DONE_TEXT, fmtTokens, fmtUsd } from "./mirror.ts";`
2. Type (line ~87-88):
   ```ts
   /** The session's cumulative usage (tokens over assistant messages; cost over all cost-bearing branch entries). */
   sessionUsage(): { input: number; output: number; cost: number };
   ```
3. `statusBlocks()` — after the tokens paragraph, before the messages paragraph:
   ```ts
   // The session's cost — shown ONLY when something was actually spent
   // (local models report cost 0 → the card is unchanged for them).
   ...(tokens.cost > 0 ? [{ type: "paragraph", text: `💲 cost: ${fmtUsd(tokens.cost)}` }] : []),
   ```

In `tests/fake-pi.ts`:
- line 16: `sessionUsage?: { input: number; output: number; cost?: number };`
- line 90: `sessionUsage: () => ({ input: 0, output: 0, cost: 0, ...self.opts.sessionUsage }),`

**Step 4: Run tests to verify they pass**

Run: `node --test tests/bridge-core.test.ts`
Expected: PASS (new test + all existing card-format tests, incl. the `l0.length === 6` GPU test — cost 0 keeps 6 lines).

**Step 5: Run the full suite**

Run: `node --test tests/*.test.ts`
Expected: PASS (all ~693+ tests).

**Step 6: Commit**

```bash
git add src/session-bridge.ts tests/fake-pi.ts tests/bridge-core.test.ts
git commit -m "feat: session card shows a 💲 cost line when the session has spent > \$0"
```

---

### Task 4: End-to-end smoke (real wiring, fake wire)

**TDD scenario:** New feature — full TDD cycle against the real `index.ts` extension (same harness as the "sent message ids persist" regression at the bottom of `tests/index-smoke.test.ts`).

**Files:**
- Test: `tests/index-smoke.test.ts` (append at the end)

**Step 1: Write the failing test**

Append to `tests/index-smoke.test.ts`:

```ts
test("smoke: session card carries a 💲 cost line when the session branch has cost (real wiring, fake wire)", async (t) => {
  // End-to-end: wiring.ts's branch walk (cost over all cost-bearing entries)
  // feeds statusBlocks' conditional line. The smoke's fakeCtx has no
  // getBranch → give it a branch with one paid assistant message + a
  // cache-warm usage entry, fire session_start, and inspect the card.
  const calls: (WireCall & { msgId?: number })[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const blocks = (body.rich_message as { blocks?: unknown[] } | undefined)?.blocks;
    const call: WireCall & { msgId?: number } = { method, body, markdown: blocks ? blocksToPlainText(blocks as TgBlock[]) : "" };
    calls.push(call);
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates")
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // The shared module-level fakeCtx is rebuilt per test run; point its
  // sessionManager at a cost-bearing branch BEFORE session_start.
  (fakeCtx.sessionManager as { getBranch?: () => unknown[] }).getBranch = () => [
    { type: "message", message: { role: "assistant", usage: { input: 1000, output: 100, cost: { total: 0.45 } } } },
    { type: "usage", kind: "cache_warm", usage: { cost: { total: 0.015 } } },
  ];

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(() => calls.some((c) => c.method === "sendRichMessage"), "the session card");
  const card = calls.find((c) => c.method === "sendRichMessage")!.markdown;
  assert.ok(card.includes("💲 cost: $0.465"), `the card carries the summed cost line (got: ${card})`);
  assert.ok(card.includes("🪙 tokens: ↑1k ↓100"), "the tokens line is intact");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/index-smoke.test.ts`
Expected: FAIL — before Task 3 this file compiles fine but the card has no 💲 line (assertion fails). (If Tasks 1–3 are done, it should PASS immediately — that's fine: this test then guards the integration; note it in the commit message.)

**Step 3: Implement**

Nothing expected — Tasks 1–3 already implement it. If it fails, debug the integration (most likely: the smoke harness's `fakeCtx` is a shared const and a previous test's branch override leaked — in that case make the override restore the previous value in `t.after`).

**Step 4: Run the full suite**

Run: `node --test tests/*.test.ts`
Expected: PASS (all).

**Step 5: Commit**

```bash
git add tests/index-smoke.test.ts
git commit -m "test: smoke — session card cost line end-to-end (real wiring, fake wire)"
```

---

## Final verification (after Task 4)

- `node --test tests/*.test.ts` — full suite green
- `npx tsc --noEmit` — types clean (CI runs this)
- Push `feat/session-cost-card`; merge path mirrors the previous branch (fast-forward onto `feat/npm-publish` or PR — decide with the user at that point).
