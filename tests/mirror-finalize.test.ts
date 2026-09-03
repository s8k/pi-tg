// Finalization (clean end): flip → persist m1 → persist m2, in that order;
// chunking past the rich cap; the rich → HTML → plain fallback chain; 3
// attempts with 1s/2s/4s backoff honoring the 429 retry_after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { RICH_CAP } from "../src/markdown.ts";
import { TgError } from "../src/telegram-client.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";
import type { FakeOutCall } from "./fake-pi.ts";

type H = ReturnType<typeof makeMirrorDeps>;
type Call = FakeOutCall;

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

const toolMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "check it" },
    { type: "text", text },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
  ],
  ...extra,
});

/**
 * A run that produces a non-empty log (one stamped tool block) and a
 * confirmed answer. Returns the deps + mirror; the final message_end has NOT
 * been called yet — the test decides how to drive the confirm.
 */
async function runToConfirm(h: H): Promise<Mirror> {
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(toolMsg("Let me check."));
  m.onAssistantEnd(toolMsg("Let me check.", { stopReason: "toolUse" }));
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  await tick();
  return m;
}

const richCalls = (h: H): Call[] => h.out.calls.filter((c) => c.kind === "sendRich");
const draftCalls = (h: H): Call[] => h.out.calls.filter((c) => c.kind === "sendDraft");
const idx = (h: H, c: Call): number => h.out.calls.indexOf(c);

test("confirm: flip (Completed ✔️) → persist m1 → persist m2, in that order; no drafts after m1", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runToConfirm(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const flip = draftCalls(h).find((c) => c.text?.includes("Completed ✔️"));
  assert.ok(flip, `flip draft update, got: ${JSON.stringify(draftCalls(h).map((c) => c.text))}`);
  assert.equal(flip?.draftId, 1, "the flip updates the work-log draft");
  assert.equal(flip?.keepOnStop, true);

  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2 rich sends, got ${rich.length}`);
  assert.ok(rich[0]?.text?.includes("Completed ✔️"), "m1 is the full log with the marker");
  assert.ok(rich[0]?.text?.includes("⚙ read a.ts ✔"), "m1 carries the stamped tool block");
  assert.equal(rich[1]?.text, "The answer is 42.", "m2 is the answer");

  assert.ok(idx(h, flip!) < idx(h, rich[0]!), "flip before m1");
  assert.ok(idx(h, rich[0]!) < idx(h, rich[1]!), "m1 before m2");
  const draftsAfterM1 = h.out.calls.slice(idx(h, rich[0]!) + 1).filter((c) => c.kind === "sendDraft");
  assert.equal(draftsAfterM1.length, 0, "no draft updates after the run is finalized");
});

test("long log: m1 is chunked at the rich cap; the answer follows as one send", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();
  const long = "word ".repeat(20_000).trim(); // ~100k chars → several chunks
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(toolMsg(long));
  m.onAssistantEnd(toolMsg(long, { stopReason: "toolUse" }));
  await tick();
  m.onToolEnd("c1", false, { content: [{ type: "text", text: "ok" }] });
  await tick();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("The answer is 42."));
  await tick();
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const rich = richCalls(h);
  assert.ok(rich.length > 2, `expected a chunked m1, got ${rich.length}`);
  for (const c of rich) assert.ok((c.text?.length ?? 0) <= RICH_CAP + 8, `chunk within cap, got ${c.text?.length}`);
  const markerIdx = rich.findIndex((c) => c.text?.includes("Completed ✔️"));
  assert.ok(markerIdx >= 0, "the marker chunk exists");
  assert.equal(rich[markerIdx + 1]?.text, "The answer is 42.", "m2 follows the last m1 chunk");
  assert.equal(rich.length, markerIdx + 2, "no sends after m2");
});

test("rich 400 → the whole message falls back to HTML chunks", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = await runToConfirm(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const html = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === "HTML");
  assert.equal(html.length, 2, `m1 + m2 via the HTML path, got ${JSON.stringify(html.map((c) => c.text))}`);
  assert.ok(html[0]?.text?.includes("Completed ✔️"), "m1 content");
  assert.equal(html[1]?.text, "The answer is 42.", "m2 content");
});

test("rich 400 AND html 400 → plain text (no parse mode)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  h.out.sendHtmlFailsWith = new TgError("sendMessage", 400, "html parse error");
  const m = await runToConfirm(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.equal(plain.length, 2, `m1 + m2 plain, got ${JSON.stringify(plain.map((c) => c.text))}`);
  assert.ok(plain[0]?.text?.includes("Completed ✔️"), "m1 content");
  assert.equal(plain[1]?.text, "The answer is 42.", "m2 content");
});

test("429 with retry_after: retried with backoff (max of backoff and retry_after) until success", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailScript = (attempt) => (attempt < 2 ? new TgError("sendRichMessage", 429, "slow down", 3) : undefined);
  const m = await runToConfirm(h);

  const p = m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick(); // attempt 1 fires; the first backoff timer arms
  h.advance(3000); // max(1s backoff, 3s retry_after)
  await tick();
  h.advance(3000); // max(2s backoff, 3s retry_after)
  await tick();
  await p;

  assert.equal(h.out.sendRichAttempts, 4, "m1: 3 attempts; m2: 1");
  assert.ok(richCalls(h).some((c) => c.text === "The answer is 42."), "m2 eventually sent");
});

test("all 3 attempts fail → finalize rejects (TUI surfaces it via the existing safe() path); m2 not attempted", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailScript = () => new TgError("sendRichMessage", 429, "down", 1);
  const m = await runToConfirm(h);

  const p = m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  const settled = p.catch((e: unknown) => e); // handler attached up front (no unhandled-rejection window)
  await tick(); // attempt 1 fires; the first backoff timer arms
  h.advance(1000);
  await tick();
  h.advance(2000);
  await tick();
  const err = (await settled) as TgError | undefined;
  assert.ok(err instanceof TgError && err.code === 429, `finalize rejects with the last error, got: ${String(err)}`);
  assert.equal(h.out.sendRichAttempts, 3, "exactly 3 attempts");
  assert.ok(!richCalls(h).some((c) => c.text === "The answer is 42."), "m2 is never attempted after m1 fails");
});

test("the flip bypasses a closed throttle window", async () => {
  const h = makeMirrorDeps({ streamEditMs: 5000 });
  const m = await runToConfirm(h);
  // the window is closed here (the last candidate send set it)
  m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();
  const flip = draftCalls(h).find((c) => c.text?.includes("Completed ✔️"));
  assert.ok(flip, "the flip goes out immediately, not gated by streamEditMs");
});
