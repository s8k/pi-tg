// Wiring smoke: boot the real extension entry (index.ts) with a fake pi +
// fake fetch, and drive it with pi events — proving the glue end to end:
//   - the single draft goes out with can_stop + keep_on_stop,
//   - tool_execution_end's `result` reaches the wire (✖ block + error text),
//   - the clean-end finalization: the draft gets the completed state
//     ([log] Completed ✔️ [answer] — no divider), then the split —
//     m1 = log + Completed ✔️ (answer cut) and m2 = the answer, as
//     regular richMessages.
// Config is isolated via PI_CODING_AGENT_DIR (a fresh temp agent dir — the
// module snapshots getAgentDir() at load time, so the env must be set before
// importing index.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-telega-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_TELEGA_BOT_TOKEN = "TEST-TOKEN";
// paired config: the mirror only works for the owner's chat, and the chat id
// is learned from the first owner update (below)
writeFileSync(join(agentDir, "pi-telega.json"), JSON.stringify({ botToken: "TEST-TOKEN", ownerId: 123456 }));

const { default: piTelega } = await import("../index.ts");

interface WireCall {
  method: string;
  body: Record<string, unknown>;
  markdown: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await sleep(10);
  }
}

// shared across the tests in this file: the extension is registered ONCE
// against a fake pi; each test boots a fresh polling generation via
// session_start.
const handlers = new Map<string, (...a: unknown[]) => unknown>();
// The fake pi replays `/tg …` sendUserMessage calls through the captured
// command handler — exactly what real pi does (the poller's dispatch path).
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
// The fake ctx exposes the post-compact session context so index.ts can
// re-derive pi's "after" count exactly as pi does internally (Σ estimateTokens
// over buildSessionContext().messages): user "hi" = ceil(2/4) = 1,
// compactionSummary "s" = ceil(1/4) = 1 → after = 2.
// `ui` mimics pi's shared ctx.ui object (mode tui + dialog methods) so
// installUiProxy has something to patch, exactly like the real runner's.
let selectPress: ((v?: string) => void) | undefined;
const fakeCtx = {
  cwd: "/tmp",
  mode: "tui",
  hasUI: true,
  isIdle: () => true, // the bridge's prompt gate calls ctx.isIdle()
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
  sessionManager: {
    buildSessionContext: () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "compactionSummary", summary: "s" },
      ],
    }),
  },
};

/**
 * Fake wire: getMe ok; the FIRST getUpdates returns one owner prompt (that
 * teaches the extension the owner's chat id); later getUpdates long-poll
 * forever. Every call lands in `calls`.
 */
function fakeWire(calls: WireCall[]): { restore: () => void; ownerLearned: () => boolean } {
  let getUpdatesCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = u.split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body, markdown: String((body.rich_message as { markdown?: string } | undefined)?.markdown ?? "") });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      getUpdatesCount++;
      if (getUpdatesCount === 1)
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  date: 1,
                  chat: { id: 42, type: "private" },
                  from: { id: 123456, is_bot: false, first_name: "O" },
                  text: "hi",
                },
              },
            ],
          }),
          { status: 200 },
        );
      // long poll: hangs forever — unless the request is aborted (generation
      // replaced), in which case reject like real fetch does on AbortSignal.
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = realFetch), ownerLearned: () => getUpdatesCount >= 2 };
}

test("poller liveness: double session_start → old long-poll aborted, new poller keeps polling (no 409 death)", async (t) => {
  // Emulates Telegram's getUpdates concurrency rule: while one long poll is in
  // flight, a second concurrent getUpdates gets 409 Conflict. The first
  // session_start boots the poller; the second (resume/swap/reload) must abort
  // the old long poll BEFORE its new getUpdates goes out — otherwise the new
  // poll 409s and (on pre-fix code) dies, leaving the bot deaf.
  const calls: WireCall[] = [];
  const getUpdatesOffsets: number[] = [];
  const conflicts: number[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body, markdown: "" });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      getUpdatesOffsets.push(body.offset as number);
      if (inFlight) {
        // a second getUpdates while one is in flight → 409 (the incident)
        conflicts.push(body.offset as number);
        return new Response(
          JSON.stringify({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot client is running" }),
          { status: 409 },
        );
      }
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => {
          inFlight = undefined; // an aborted request frees the in-flight slot
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
        inFlight = () => {
          inFlight = undefined;
          resolve(new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }));
        };
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  let inFlight: (() => void) | undefined;

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(() => getUpdatesOffsets.length >= 1, "first generation starts polling");
  // session resume/swap/reload → a second session_start while the first long poll is in flight
  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(() => getUpdatesOffsets.length >= 2, "new generation started polling");
  assert.equal(conflicts.length, 0, "no concurrent getUpdates ever — the old long poll is aborted before the new one starts");
  // Prove the new loop is ALIVE (not 409-dead): resolve its long poll and it
  // must issue the next one.
  inFlight?.();
  await waitFor(() => getUpdatesOffsets.length >= 3, "surviving poller issued its next poll after the double session_start");
});

test("index.ts wiring: events → mirror → client wire (full clean run)", async (t) => {
  const calls: WireCall[] = [];
  const wire = fakeWire(calls);
  t.after(wire.restore);

  // bootstrap (getMe → mirror created); pendingAction is absent (fresh config).
  // The owner prompt's bridge.dispatch throws against the fake ctx (no pi
  // behind it); dispatch's catch swallows it after posting a ⚠ message.
  handlers.get("session_start")!({}, fakeCtx);
  // wait until the first owner update was processed (the 2nd getUpdates went out)
  await waitFor(wire.ownerLearned, "owner chat learned");

  // run 1: the work log
  handlers.get("agent_start")!();
  await waitFor(() => calls.some((c) => c.method === "sendRichMessageDraft"), "draft 1 spawn");
  const spawn = calls.filter((c) => c.method === "sendRichMessageDraft")[0]!;
  assert.equal(spawn.body.can_stop, true, "draft 1 is stoppable");
  assert.equal(spawn.body.keep_on_stop, true, "draft 1 survives Stop (the bot persists it)");

  // Realistic gap: the model takes a moment to start. This matters — the
  // spawn's pump must have finished (and armed its drain at the old window
  // edge) before the first message's forced send extends the window. That is
  // exactly the interleaving that used to deadlock the draft pipeline.
  await sleep(50);

  const toolContent = [
    { type: "thinking", thinking: "check it" },
    { type: "text", text: "Let me check." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
  ];
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: toolContent } });
  handlers.get("message_end")!({ message: { role: "assistant", content: toolContent, stopReason: "toolUse" } });
  // the pi event's `result` must reach the wire — this is the glue under test
  handlers.get("tool_execution_end")!({
    toolCallId: "c1",
    toolName: "read",
    isError: true,
    result: { content: [{ type: "text", text: "RangeError: boom" }] },
  });
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("RangeError: boom")),
    "tool result on the wire",
  );
  const stamped = calls.filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("RangeError: boom")).pop()!;
  assert.ok(stamped.markdown.includes("✖"), "the ✖ stamp is on the wire");

  // the answer
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] } });
  handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }], stopReason: "stop" } });

  // the draft's completed state: the full composed message is visible in the
  // draft (log → marker → divider → answer, spinner gone)
  await waitFor(
    () =>
      calls.some(
        (c) =>
          c.method === "sendRichMessageDraft" &&
          c.markdown.includes("Completed ✔️") &&
          c.markdown.includes("The answer is 42."),
      ),
    "completed-state draft",
  );
  const preview = calls
    .filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("Completed ✔️"))
    .pop()!;
  assert.ok(!preview.markdown.includes("---"), "no divider between the log and the answer");
  const pOrder = [preview.markdown.indexOf("⚙ read ✖"), preview.markdown.indexOf("Completed ✔️"), preview.markdown.indexOf("The answer is 42.")];
  assert.ok(pOrder.every((i) => i >= 0), `all parts in the preview, got: ${JSON.stringify(preview.markdown)}`);
  assert.ok(pOrder[0]! < pOrder[1]! && pOrder[1]! < pOrder[2]!, `wrong preview order: ${pOrder}`);
  assert.ok(!preview.body.can_stop, "no Stop button on the completed preview (can_stop omitted when false)");
  assert.ok(!preview.markdown.includes("<tg-thinking>"), "the spinner is gone from the preview");

  // the split: m1 = log + Completed ✔️ (the answer is CUT) → m2 = the answer
  await waitFor(() => calls.filter((c) => c.method === "sendRichMessage").length >= 2, "the two persistent sends");
  const richSends = calls.filter((c) => c.method === "sendRichMessage");
  assert.equal(richSends.length, 2, `m1 + m2, got ${richSends.length}`);
  const m1 = richSends[0]!;
  const m2 = richSends[1]!;
  assert.ok(m1.markdown.includes("⚙ read ✖"), "the failed tool block is in m1");
  assert.ok(m1.markdown.includes("Completed ✔️"), "m1 ends with the marker");
  assert.ok(!m1.markdown.includes("The answer is 42."), "the answer is cut from m1");
  assert.ok(!m1.markdown.includes("---"), "no divider in m1");
  assert.equal(m2.markdown, "The answer is 42.", "m2 is the answer, verbatim");
  const draftIdx = calls.indexOf(calls.filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("Completed ✔️")).pop()!);
  assert.ok(draftIdx < calls.indexOf(m1) && calls.indexOf(m1) < calls.indexOf(m2), "chronology: completed-state draft → m1 → m2");
});

// ── T6: early draft + auto-compaction lanes (index.ts wiring) ──────────────

test("T6 early draft: the run's draft goes out at prompt acceptance — before any agent event", async (t) => {
  const calls: WireCall[] = [];
  const wire = fakeWire(calls);
  t.after(wire.restore);

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(wire.ownerLearned, "owner chat learned");

  // NO agent event has fired in this test — the early draft must already be
  // on the wire (spawned when the prompt was dispatched).
  const drafts = calls.filter((c) => c.method === "sendRichMessageDraft");
  assert.ok(drafts.length >= 1, "the early draft went out before any agent event");
  assert.equal(drafts[0]!.body.can_stop, true, "the early draft is stoppable");

  // agent_start takes over the SAME draft — no second spawn
  const before = drafts.length;
  handlers.get("agent_start")!();
  await sleep(80);
  assert.equal(calls.filter((c) => c.method === "sendRichMessageDraft").length, before, "no new draft at takeover");
});

test("T6 lane 2: auto-compact with a live draft → C1 status in the run's draft, stamped line lands in m1", async (t) => {
  const calls: WireCall[] = [];
  const wire = fakeWire(calls);
  t.after(wire.restore);

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(wire.ownerLearned, "owner chat learned");
  assert.ok(calls.some((c) => c.method === "sendRichMessageDraft"), "the early draft is live");

  // pi auto-compacts (threshold) while the early draft is live → lane 2
  handlers.get("session_before_compact")!({
    reason: "threshold",
    preparation: {},
    branchEntries: [],
    willRetry: false,
    signal: new AbortController().signal,
  }, fakeCtx);
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("🗜 Auto-compacting…")),
    "C1 status in the run's draft",
  );

  // success: the auto detail is "before → after tokens" — the "after" is
  // re-derived by index.ts from the public buildSessionContext() +
  // estimateTokens (pi's own internal formula, same number)
  handlers.get("session_compact")!({
    reason: "threshold",
    compactionEntry: {
      id: "e2", parentId: "e1", timestamp: 0, type: "compaction",
      summary: "s", firstKeptEntryId: "e1", tokensBefore: 128432,
    },
    fromExtension: false,
    willRetry: false,
  });
  await waitFor(
    () =>
      calls.some(
        (c) =>
          c.method === "sendRichMessageDraft" &&
          !c.markdown.includes("🗜 Auto-compacting…") &&
          c.markdown.includes("🗜 Context auto-compacted ✔️ 128,432 → 2 tokens"),
      ),
    "stamped narration in the draft (status back to the spinner)",
  );

  // the (continued) run confirms → m1 carries the stamped narration
  handlers.get("agent_start")!();
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
  handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessage" && c.markdown.includes("🗜 Context auto-compacted ✔️ 128,432 → 2 tokens")),
    "stamped narration in m1",
  );
});

test("T6 lane 2 failure: the draft carries on; a standalone ⚠️ notice goes out (C3); abort w/o message: silent", async (t) => {
  const calls: WireCall[] = [];
  const wire = fakeWire(calls);
  t.after(wire.restore);

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(wire.ownerLearned, "owner chat learned");

  // lane 2: auto-compact with the early draft live
  handlers.get("session_before_compact")!({
    reason: "overflow", preparation: {}, branchEntries: [], willRetry: true, signal: new AbortController().signal,
  }, fakeCtx);
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("🗜 Auto-compacting…")),
    "C1 status in the run's draft",
  );

  // it FAILS → the standalone ⚠️ notice (pi's prefixed message verbatim)
  handlers.get("session_compact_failed")!({
    reason: "overflow", aborted: false, errorMessage: "Auto-compaction failed: the model exploded", willRetry: true, fromExtension: false,
  });
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && String(c.body.text ?? "").includes("⚠️ Auto-compaction failed: the model exploded")),
    "standalone ⚠️ notice on the wire",
  );
  const notice = calls.filter((c) => c.method === "sendMessage").pop()!;
  assert.ok(!("parse_mode" in notice.body), "the ⚠️ notice is plain text (no parse_mode)");
  // the live draft is back to the spinner (no C1 status left) — the update
  // is throttled (~1.2 s on the real clock), so wait for it
  await waitFor(
    () => !calls.filter((c) => c.method === "sendRichMessageDraft").pop()!.markdown.includes("🗜 Auto-compacting…"),
    "the draft carries on (status reverted)",
  );

  // an aborted failure WITHOUT a message (teardown/cancel) → silent
  const sendsBefore = calls.filter((c) => c.method === "sendMessage").length;
  handlers.get("session_before_compact")!({
    reason: "threshold", preparation: {}, branchEntries: [], willRetry: false, signal: new AbortController().signal,
  }, fakeCtx);
  await waitFor(
    () => calls.filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("🗜 Auto-compacting…")).length >= 2,
    "C1 status again",
  );
  handlers.get("session_compact_failed")!({
    reason: "threshold", aborted: true, willRetry: false, fromExtension: false,
  });
  await sleep(60);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, sendsBefore, "no ⚠️ for a silent abort");
});

test("T6 lane 1: auto-compact with no live draft → standalone draft; finish stamps it and sends the result", async (t) => {
  const calls: WireCall[] = [];
  const wire = fakeWire(calls);
  t.after(wire.restore);

  handlers.get("session_start")!({}, fakeCtx);
  await waitFor(wire.ownerLearned, "owner chat learned");

  // finish a run first, so NO run draft is live when the auto-compact fires
  handlers.get("agent_start")!();
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
  await waitFor(() => calls.some((c) => c.method === "sendRichMessage" && c.markdown === "ok"), "the run finalized");

  const draftsBefore = calls.filter((c) => c.method === "sendRichMessageDraft").length;
  // no live draft → lane 1: the bridge's standalone draft (id ≥ 1e6, no Stop)
  handlers.get("session_before_compact")!({
    reason: "threshold", preparation: {}, branchEntries: [], willRetry: false, signal: new AbortController().signal,
  }, fakeCtx);
  await waitFor(
    () =>
      calls.filter((c) => c.method === "sendRichMessageDraft").length > draftsBefore &&
      calls.filter((c) => c.method === "sendRichMessageDraft").pop()!.markdown.includes("🗜 Auto-compacting…"),
    "the standalone auto-compact draft",
  );
  const lane1 = calls.filter((c) => c.method === "sendRichMessageDraft").pop()!;
  assert.ok((lane1.body.draft_id as number) >= 1_000_000, "the standalone draft uses a dedicated id space");
  assert.ok(!("can_stop" in lane1.body), "no Stop button on the auto-compact draft");

  // success → stamp + plain-text result
  handlers.get("session_compact")!({
    reason: "threshold",
    compactionEntry: {
      id: "e2", parentId: "e1", timestamp: 0, type: "compaction",
      summary: "s", firstKeptEntryId: "e1", tokensBefore: 128432,
    },
    fromExtension: false,
    willRetry: false,
  });
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && String(c.body.text ?? "") === "🗜 Context auto-compacted ✔️ 128,432 → 2 tokens"),
    "the plain-text result",
  );
  const stampedDrafts = calls.filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("✔️"));
  assert.ok(stampedDrafts.some((c) => (c.body.draft_id as number) >= 1_000_000), "the standalone draft was stamped");

  // a FAILED lane-1 compact → ⚠️ result, stamped draft
  handlers.get("session_before_compact")!({
    reason: "threshold", preparation: {}, branchEntries: [], willRetry: false, signal: new AbortController().signal,
  }, fakeCtx);
  await waitFor(
    () =>
      calls.filter((c) => c.method === "sendRichMessageDraft" && !c.markdown.includes("✔️") && c.markdown.includes("🗜 Auto-compacting…")).length >= 2,
    "the second standalone draft",
  );
  handlers.get("session_compact_failed")!({
    reason: "threshold", aborted: false, errorMessage: "Auto-compaction failed: disk on fire", willRetry: false, fromExtension: false,
  });
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && String(c.body.text ?? "") === "⚠️ Auto-compaction failed: disk on fire"),
    "the ⚠️ result",
  );
});

// ── dialog mirroring E2E (Option A: the in-place ctx.ui proxy) ─────────────

test("dialog mirroring E2E: extension select → TG buttons → owner tap wins (stamped); terminal key wins (stamped 'terminal')", async (t) => {
  const calls: WireCall[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let batch = 0;
  let msgId = 100;
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
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, from: { id: 123456, is_bot: false, first_name: "O" }, text: "hi" } },
            ],
          }),
          { status: 200 },
        );
      // every later poll hangs until the test resolves it with a batch
      return new Promise<Response>((resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
        resolveLongPoll = (updates) => resolve(new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }));
      });
    }
    if (method === "sendMessage")
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  // A FRESH ctx per generation is what pi does (each runner swap creates a
  // new shared ui object) — the proxy must be (re)installed on it.
  let e2ePress: ((v?: string) => void) | undefined;
  let e2eOpened = 0; // how many times the TUI dialog actually opened (a key can only be pressed once it did)
  const e2eCtx = {
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: () => {},
      select: (_title: string, _options?: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          if (opts?.signal?.aborted) return resolve(undefined);
          const onAbort = () => resolve(undefined);
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
          e2eOpened++;
          // mimic pi's wrapUIPromptContext: the TUI dialog opening emits ui_prompt_start
          handlers.get("ui_prompt_start")?.({ title: _title });
          e2ePress = (v?: string) => {
            opts?.signal?.removeEventListener("abort", onAbort);
            resolve(v);
          };
        }),
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve(undefined),
      editor: () => Promise.resolve(undefined),
    },
    sessionManager: fakeCtx.sessionManager,
  };

  handlers.get("session_start")!({}, e2eCtx);
  // wait until batch 1 was processed (the 2nd getUpdates went out = chat learned)
  await waitFor(() => calls.filter((c) => c.method === "getUpdates").length >= 2, "owner chat learned");

  // 1) TG tap wins: another extension asks via the shared ctx.ui
  const p1 = e2eCtx.ui.select("Pick flavor", ["vanilla", "chocolate"]);
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes("da:1:0")),
    "TG dialog with buttons on the wire",
  );
  resolveLongPoll!([
    {
      update_id: 10,
      callback_query: { id: "cb1", from: { id: 123456, is_bot: false }, data: "da:1:1", message: { message_id: 200, date: 1, chat: { id: 42, type: "private" } } },
    },
  ]);
  assert.equal(await p1, "chocolate", "the extension got the TAPPED option");
  await waitFor(
    () => calls.some((c) => c.method === "editMessageText" && String(c.body.text ?? "").includes("chocolate")),
    "✔️ stamp on the wire",
  );

  // 2) terminal key wins: the TUI answer resolves, the TG message is stamped 'terminal'
  const p2 = e2eCtx.ui.select("Pick again", ["a", "b"]);
  await waitFor(
    () => calls.some((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes("da:2:0")),
    "second TG dialog on the wire",
  );
  // The TUI dialog opens only after the TG dialog's send settled — a key can
  // not be pressed before that (the wrapper races the TUI dialog against the
  // phone). Wait for the open, then press.
  await waitFor(() => e2eOpened >= 2, "TUI dialog 2 opened (the press needs an open dialog)");
  e2ePress!("b");
  assert.equal(await p2, "b");
  await waitFor(
    () => calls.some((c) => c.method === "editMessageText" && String(c.body.text ?? "").includes("terminal")),
    "💻 terminal stamp on the wire",
  );

  // 3) ⚠️ dedupe: a TUI-only prompt keeps the “⚠️ terminal prompt” work-log line
  //    (positive control — proves the mirror is in the work phase), but a MIRROR-ed
  //    dialog must not add one (the TG dialog is the notification itself).
  // The work-log line lives in the LIVE DRAFT (rich_message.markdown), not in
  // plain sends — look at both shapes.
  const wireText = (c: WireCall): string =>
    String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? "");
  handlers.get("ui_prompt_start")!({ title: "unmirrored prompt" });
  await waitFor(
    () => calls.some((c) => wireText(c).includes("⚠️ terminal prompt: unmirrored prompt")),
    "⚠️ line for the unmirrored prompt (positive control)",
  );
  assert.ok(
    !calls.some((c) => wireText(c).includes("⚠️ terminal prompt: Pick flavor")),
    "no ⚠️ work-log line for the mirrored dialog (the TG dialog is the notification)",
  );
});
