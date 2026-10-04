// Finalization (2026-09-03 flow, revised): the clean end is a THREE-STEP
// split —
//  1) the draft gets the COMPLETED STATE: [log] Completed ✔️ [answer]
//     (the final composed message is visible in the draft, spinner gone,
//     NO divider between the log and the answer);
//  2) message 1 — the work log + Completed ✔️ as a regular richMessage (the
//     answer is CUT; this send also finalizes the draft: per the Bot API any
//     message sent to the chat instantly clears the ephemeral draft, and
//     sendRichMessage has no draft_id — no in-place promotion);
//  3) message 2 — the final answer as its own regular richMessage.
// End state: the tool log is the previous message, the answer is the new one.
// Stop/error ends stay single messages. Chunking past the rich cap; the rich →
// HTML → plain fallback chain; 3 attempts with 1s/2s/4s backoff honoring the
// 429 retry_after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { RICH_CAP } from "../src/markdown.ts";
import { blocksLen } from "../src/rich-blocks.ts";
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

test("confirm: draft completed state → m1 (log + Completed, answer cut) → m2 (answer)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = await runToConfirm(h);
  const draftsBefore = draftCalls(h).length;
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  // step 1: exactly ONE draft update — the completed state (log + marker +
  // divider + answer), no Stop button (the run is over)
  const newDrafts = draftCalls(h).slice(draftsBefore);
  assert.equal(newDrafts.length, 1, `exactly the completed-state draft update, got: ${JSON.stringify(newDrafts.map((c) => c.text))}`);
  const preview = newDrafts[0]!.text ?? "";
  assert.ok(preview.includes("⚙ read ✔"), "the preview carries the stamped tool block");
  assert.ok(preview.includes("Completed ✔️"), "the marker is in the preview");
  assert.ok(!preview.includes("---"), "no divider between the log and the answer");
  assert.ok(preview.includes("The answer is 42."), "the answer is in the preview");
  assert.ok(!preview.includes("<tg-thinking>"), "the spinner is gone from the preview");
  assert.equal(newDrafts[0]?.canStop, false, "no Stop button on the completed preview");
  assert.equal(newDrafts[0]?.keepOnStop, true);

  // steps 2+3: m1 (log + Completed — the answer is CUT) then m2 (the answer)
  const rich = richCalls(h);
  assert.equal(rich.length, 2, `m1 + m2, got ${rich.length}`);
  const m1 = rich[0]!.text ?? "";
  const m2 = rich[1]!.text ?? "";
  assert.ok(m1.includes("⚙ read ✔"), "m1 carries the stamped tool block");
  assert.ok(m1.includes("Completed ✔️"), "m1 ends with the marker");
  assert.ok(!m1.includes("The answer is 42."), "the answer is cut from m1");
  assert.ok(!m1.includes("---"), "no divider in m1 (there is no answer after it)");
  assert.equal(m2, "The answer is 42.", "m2 is the answer, verbatim");
  assert.equal(rich[0]?.opts?.disableNotification, true, "m1 (the work log) is SILENT — no notification");
  assert.ok(!rich[1]?.opts?.disableNotification, "m2 (the final answer) NOTIFIES");

  // chronology: completed-state draft → m1 → m2
  assert.ok(idx(h, newDrafts[0]!) < idx(h, rich[0]!), "the completed-state preview precedes m1");
  assert.ok(idx(h, rich[0]!) < idx(h, rich[1]!), "m1 before m2");
});

test("long log: m1 is chunked at the rich cap; the answer is the final send", async () => {
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
  assert.ok(rich.length > 2, `expected a chunked m1 + m2, got ${rich.length}`);
  for (const c of rich) assert.ok(blocksLen(c.blocks ?? []) <= RICH_CAP, `chunk within the rendered cap, got ${blocksLen(c.blocks ?? [])}`);
  const markerIdx = rich.findIndex((c) => c.text?.includes("Completed ✔️"));
  assert.ok(markerIdx >= 0, "the marker chunk exists");
  assert.ok(markerIdx < rich.length - 1, "m2 follows the last m1 chunk");
  assert.equal(rich[rich.length - 1]?.text, "The answer is 42.", "m2 is the final send");
  assert.ok(!rich[rich.length - 2]?.text?.includes("The answer is 42."), "the answer is not in the last m1 chunk");
});

test("rich 400 → both messages fall back to plain chunks", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = await runToConfirm(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  // the HTML tier retires with the blocks migration — a 400 demotes straight to plain text
  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.ok(plain.some((c) => c.text?.includes("Completed ✔️")), "m1 via the plain path");
  assert.ok(plain.some((c) => c.text === "The answer is 42."), "m2 via the plain path");
});

test("rich 400 → both messages plain text (no parse mode)", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0 });
  h.out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = await runToConfirm(h);
  await m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();

  const plain = h.out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.ok(plain.some((c) => c.text?.includes("Completed ✔️")), "m1 plain");
  assert.ok(plain.some((c) => c.text === "The answer is 42."), "m2 plain");
});

test("429 with retry_after: m1 retried with backoff (max of backoff and retry_after) until success", async () => {
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

test("all 3 attempts on m1 fail → finalize rejects; m2 not attempted", async () => {
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
  assert.equal(h.out.sendRichAttempts, 3, "exactly 3 attempts on m1");
  assert.ok(!richCalls(h).some((c) => c.text === "The answer is 42."), "m2 is never attempted after m1 fails");
});

test("finalize is not gated by a closed stream window", async () => {
  const h = makeMirrorDeps({ streamEditMs: 5000 });
  const m = await runToConfirm(h);
  // the window is closed here (the last candidate send set it); the
  // persistent sends must go out immediately — the run is over
  const p = m.onAssistantEnd(textMsg("The answer is 42.", { stopReason: "stop" }));
  await tick();
  assert.ok(richCalls(h)[0]?.text?.includes("Completed ✔️"), "m1 persists immediately despite the closed window");
  await p;
  assert.equal(richCalls(h).length, 2, "m2 follows");
});
