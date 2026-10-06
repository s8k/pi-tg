// Task 7: per-chunk demotion — a 400 on chunk N re-sends ONLY chunks N..end
// as plain text (the delivered prefix is never re-sent — duplication
// regression). The HTML tier is gone: blocks → plain is the whole chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { TgError } from "../src/telegram-client.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

/** A run whose narration is long enough that the finalized m1 splits into ≥ 2 rich chunks. */
const toolMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
  ...extra,
});

async function runWithLongLog(h: ReturnType<typeof makeMirrorDeps>, prefix = ""): Promise<Mirror> {
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  const long = prefix + "word ".repeat(20_000).trim(); // ~100k chars → several chunks
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(toolMsg(long));
  m.onAssistantEnd(toolMsg(long, { stopReason: "toolUse" }));
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  await tick();
  return m;
}

test("happy path: every chunk goes out as blocks (no markdown key anywhere)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runWithLongLog(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.ok(rich.length >= 2, `chunked m1, got ${rich.length}`);
  for (const c of rich) assert.ok(Array.isArray(c.blocks), "every rich call carries a blocks array");
  assert.equal(h.out.calls.filter((c) => c.kind === "send").length, 0, "no plain send on the happy path");
});

test("400 on the FIRST chunk → the WHOLE message re-sent as plain", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = await runWithLongLog(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.ok(plain.length >= 1, "the plain demotion went out");
  assert.ok(plain.some((c) => c.text?.includes("word")), "m1's log content is in the plain chunks");
});

test("partial delivery: chunk 0 lands, chunk 1 400s → ONLY the undelivered tail is re-sent as plain (no duplication)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  // chunk 0 (attempt 0) succeeds; chunk 1 (attempt 1) 400s
  h.out.sendRichFailScript = (attempt) => (attempt === 1 ? new TgError("sendRichMessage", 400, "chunk 1 rejected") : undefined);
  const m = await runWithLongLog(h, "MARKER-ALPHA ");
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.ok(rich.length >= 1, "chunk 0 landed as blocks");
  assert.ok(plain.length >= 1, "the tail was re-sent as plain");
  // the DUPLICATION REGRESSION: chunk 0 carries the unique MARKER-ALPHA
  // opening — if the whole message were re-sent as plain, the marker would
  // appear in the plain chunks. It must not.
  for (const c of plain) {
    assert.ok(!c.text!.includes("MARKER-ALPHA"), `chunk 0's content was NOT re-sent: ${JSON.stringify(c.text?.slice(0, 60))}`);
  }
  // the tail keeps its (continued) marker — chunks 1..n are the re-sent part
  assert.ok(plain[0]!.text!.includes("(continued)"), "the tail starts at the (continued) chunk");
});

test("disableNotification survives the blocks → plain chain", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = await runWithLongLog(h);
  // an aborted end finalizes SILENT (disableNotification: true)
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "aborted" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();

  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.ok(plain.length >= 1, "the plain demotion went out");
  for (const c of plain) assert.equal(c.opts?.disableNotification, true, "silence survived the demotion");
});

test("a 400 that survives ALL rungs rethrows once (no infinite loop, no retry)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  h.out.sendFailsWith = new TgError("sendMessage", 400, "plain parse error");
  const m = await runWithLongLog(h);
  await assert.rejects(
    () => m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" })),
    /plain parse error/,
    "the 400-through-all rethrows once (no retry loop)",
  );
  await tick();
  assert.equal(m.hasLiveDraft(), false, "the run still finalized (settlement released)");
});

test("429 never changes rung: the backoff retries the SAME blocks chunk, then lands", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  // first attempt 429 (retry_after 0 → the 1s backoff floor), second lands
  h.out.sendRichFailScript = (attempt) => (attempt === 0 ? new TgError("sendRichMessage", 429, "slow down", 0) : undefined);
  const m = await runWithLongLog(h);
  const endP = m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();
  h.advance(5000); // past the 1s backoff (the finalize is parked in the sleep)
  await tick();
  await endP;
  await tick();

  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.equal(plain.length, 0, "a 429 demotes to NOTHING — the blocks rung is retried");
  const rich = h.out.calls.filter((c) => c.kind === "sendRich");
  assert.ok(rich.length >= 1, "the blocks send landed after the backoff");
});
