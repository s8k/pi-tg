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
piTelega({ registerCommand: () => {}, on: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) } as never);
const fakeCtx = { cwd: "/tmp", ui: { notify: () => {} } };

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
      return new Promise<Response>(() => {}); // long poll: never resolves
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = realFetch), ownerLearned: () => getUpdatesCount >= 2 };
}

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

  // success: the auto detail is the pre-compact token count (no "after" is
  // exposed to extensions)
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
          c.markdown.includes("🗜 Context auto-compacted ✔️ — 128,432 tokens"),
      ),
    "stamped narration in the draft (status back to the spinner)",
  );

  // the (continued) run confirms → m1 carries the stamped narration
  handlers.get("agent_start")!();
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
  handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessage" && c.markdown.includes("🗜 Context auto-compacted ✔️ — 128,432 tokens")),
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
    () => calls.some((c) => c.method === "sendMessage" && String(c.body.text ?? "") === "🗜 Context auto-compacted ✔️ — 128,432 tokens"),
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
