// src/compact.ts — the stoppable manual-compaction core (pi's default
// compaction replayed with our own AbortController). Pure unit tests: the LLM
// completion is injected, no pi imports allowed (boundary test enforces).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runTgCompaction,
  serializeLlmConversation,
  computeFileLists,
  formatFileOperations,
  combineUsage,
  COMPACT_CANCELLED_MSG,
  type TgComplete,
  type TgAssistantResponse,
  type TgUsage,
  type TgLlmMessage,
  type TgCompactionPreparation,
  type TgModel,
} from "../src/compact.ts";

const usage = (input = 10, output = 20): TgUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
});

const textResponse = (text: string, u: TgUsage = usage()): TgAssistantResponse => ({
  stopReason: "stop",
  content: [{ type: "text", text }],
  usage: u,
});

const model: TgModel = { id: "m1", maxTokens: 8192, reasoning: false };

const prep = (over: Partial<TgCompactionPreparation> = {}): TgCompactionPreparation => ({
  firstKeptEntryId: "e-1",
  messagesToSummarize: [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 5000,
  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  settings: { reserveTokens: 16384 },
  ...over,
});

const noAbort = new AbortController();

// ── serialization (pi's serializeConversation replica) ──

test("serializeLlmConversation: role lines, tool-call args, 2000-char tool truncation", () => {
  const msgs: TgLlmMessage[] = [
    { role: "user", content: [{ type: "text", text: "do it" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "working" },
        { type: "toolCall", name: "bash", arguments: { cmd: "ls -la", timeout: 30 } },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(2100) }] },
    { role: "compactionSummary", content: "special roles are skipped" },
    { role: "user", content: [] }, // empty → skipped
  ];
  const s = serializeLlmConversation(msgs);
  assert.ok(s.includes("[User]: do it"));
  assert.ok(s.includes("[Assistant thinking]: hm"));
  assert.ok(s.includes("[Assistant]: working"));
  assert.ok(s.includes("[Assistant tool calls]: bash(cmd=\"ls -la\", timeout=30)"));
  assert.ok(s.includes(`[Tool result]: ${"x".repeat(2000)}`));
  assert.ok(s.includes("[... 100 more characters truncated]"));
  assert.ok(!s.includes("special roles are skipped"));
  // parts joined with a blank line
  assert.ok(s.includes("[User]: do it\n\n[Assistant thinking]: hm"));
});

// ── file ops & usage (pi replicas) ──

test("computeFileLists: modified excludes read-only, both sorted", () => {
  const lists = computeFileLists({ read: new Set(["b.ts", "a.ts"]), written: new Set(["b.ts", "c.ts"]), edited: new Set(["a.ts"]) });
  assert.deepEqual(lists, { readFiles: [], modifiedFiles: ["a.ts", "b.ts", "c.ts"] });
  const lists2 = computeFileLists({ read: new Set(["z.ts", "a.ts"]), written: new Set(["a.ts"]), edited: new Set() });
  assert.deepEqual(lists2, { readFiles: ["z.ts"], modifiedFiles: ["a.ts"] });
});

test("formatFileOperations: sections only when non-empty; empty → \"\"", () => {
  assert.equal(formatFileOperations([], []), "");
  const md = formatFileOperations(["a.ts"], ["b.ts"]);
  assert.equal(md, '\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>');
});

test("combineUsage: sums inputs/outputs/costs, keeps optional splits", () => {
  const a: TgUsage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 9, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const b: TgUsage = { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cacheWrite1h: 2, totalTokens: 18, cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 } };
  const c = combineUsage(a, b);
  assert.equal(c.input, 6);
  assert.equal(c.output, 8);
  assert.equal(c.cacheRead, 10);
  assert.equal(c.cacheWrite, 12);
  assert.equal(c.cacheWrite1h, 2);
  assert.equal(c.totalTokens, 27);
  assert.equal(c.cost.total, 36);
});

// ── runTgCompaction ──

test("runTgCompaction: happy path — prompt shape, result shape, max-token math", async () => {
  const seen: { systemPrompt: string; prompt: string; maxTokens: number; reasoning?: string }[] = [];
  const complete: TgComplete = async (m, context, options) => {
    const prompt = (context.messages[0] as { content: { type: string; text?: string }[] }).content.find((b) => b.type === "text")!.text!;
    seen.push({ systemPrompt: context.systemPrompt, prompt, maxTokens: options.maxTokens, reasoning: options.reasoning });
    return textResponse("SUMMARY");
  };
  const r = await runTgCompaction({ preparation: prep(), model, signal: noAbort.signal, complete });
  assert.ok(!("aborted" in r), "not aborted");
  const c = r.compaction;
  assert.equal(c.summary, "SUMMARY");
  assert.equal(c.firstKeptEntryId, "e-1");
  assert.equal(c.tokensBefore, 5000);
  assert.equal(c.usage?.output, 20);
  assert.deepEqual(c.details, { readFiles: [], modifiedFiles: [] });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].systemPrompt.includes("context summarization assistant"));
  assert.ok(seen[0].prompt.includes("<conversation>\n[User]: hello\n\n[Assistant]: hi\n</conversation>"));
  assert.ok(seen[0].prompt.includes("## Goal"));
  assert.ok(seen[0].prompt.includes("## Critical Context"));
  assert.equal(seen[0].maxTokens, 8192, "capped by model.maxTokens (8192 < 0.8*16384)");
  assert.equal(seen[0].reasoning, undefined, "non-reasoning model → no reasoning option");
});

test("runTgCompaction: maxTokens = floor(0.8 * reserveTokens) when below the model cap", async () => {
  let maxTokens = 0;
  const complete: TgComplete = async (_m, _c, options) => {
    maxTokens = options.maxTokens;
    return textResponse("S");
  };
  await runTgCompaction({ preparation: prep(), model: { id: "m", maxTokens: 100_000 }, signal: noAbort.signal, complete });
  assert.equal(maxTokens, Math.floor(0.8 * 16384));
});

test("runTgCompaction: previousSummary → UPDATE prompt; customInstructions → Additional focus", async () => {
  const prompts: string[] = [];
  const complete: TgComplete = async (_m, context, _o) => {
    prompts.push((context.messages[0] as { content: { type: string; text?: string }[] }).content.find((b) => b.type === "text")!.text!);
    return textResponse("S");
  };
  await runTgCompaction({
    preparation: prep({ previousSummary: "old summary" }),
    model,
    customInstructions: "focus on tests",
    signal: noAbort.signal,
    complete,
  });
  assert.ok(prompts[0].includes("NEW conversation messages"), "update prompt used");
  assert.ok(prompts[0].includes("PRESERVE all existing information"), "update instructions embedded");
  assert.ok(prompts[0].includes("Additional focus: focus on tests"));
  // pi embeds the old summary in its tags, between the conversation and the prompt
  assert.match(prompts[0], /<conversation>\n[\s\S]*<\/conversation>\n\n<previous-summary>\nold summary\n<\/previous-summary>\n\n/);
  // fresh compaction → no previous-summary block
  const prompts2: string[] = [];
  const complete2: TgComplete = async (_m, context, _o) => {
    prompts2.push((context.messages[0] as { content: { type: string; text?: string }[] }).content.find((b) => b.type === "text")!.text!);
    return textResponse("S");
  };
  await runTgCompaction({ preparation: prep(), model, signal: noAbort.signal, complete: complete2 });
  assert.ok(!prompts2[0].includes("<previous-summary>"));
});

test("runTgCompaction: reasoning model + thinking level → reasoning passthrough (off → none)", async () => {
  const reasoning: TgModel = { id: "m", reasoning: true, maxTokens: 100_000 };
  const seen: (string | undefined)[] = [];
  const complete: TgComplete = async (_m, _c, options) => {
    seen.push(options.reasoning);
    return textResponse("S");
  };
  await runTgCompaction({ preparation: prep(), model: reasoning, thinkingLevel: "high", signal: noAbort.signal, complete });
  await runTgCompaction({ preparation: prep(), model: reasoning, thinkingLevel: "off", signal: noAbort.signal, complete });
  assert.deepEqual(seen, ["high", undefined]);
});

test("runTgCompaction: split turn — two calls (0.8 then 0.5 factor), combined summary, combined usage", async () => {
  const calls: { maxTokens: number }[] = [];
  const complete: TgComplete = async (_m, context, options) => {
    calls.push({ maxTokens: options.maxTokens });
    const prompt = (context.messages[0] as { content: { type: string; text?: string }[] }).content.find((b) => b.type === "text")!.text!;
    return textResponse(prompt.includes("**Turn Context (split turn):**") || prompt.includes("PREFIX of a turn") ? "PREFIX" : "HISTORY", usage(1, 2));
  };
  const r = await runTgCompaction({
    preparation: prep({
      isSplitTurn: true,
      turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "prefix work" }] }],
    }),
    model: { id: "m", maxTokens: 100_000 },
    signal: noAbort.signal,
    complete,
  });
  assert.ok("compaction" in r);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].maxTokens, Math.floor(0.8 * 16384));
  assert.equal(calls[1].maxTokens, Math.floor(0.5 * 16384));
  assert.equal(r.compaction.summary, "HISTORY\n\n---\n\n**Turn Context (split turn):**\n\nPREFIX");
  assert.equal(r.compaction.usage?.output, 4, "usages combined");
});

test("runTgCompaction: split turn with EMPTY history → 'No prior history.'", async () => {
  const r = await runTgCompaction({
    preparation: prep({ isSplitTurn: true, messagesToSummarize: [], turnPrefixMessages: [{ role: "user", content: "x" }] }),
    model,
    signal: noAbort.signal,
    complete: async () => textResponse("PREFIX"),
  });
  assert.ok("compaction" in r);
  assert.ok(r.compaction.summary.startsWith("No prior history.\n\n---\n\n**Turn Context (split turn):**"));
});

test("runTgCompaction: file ops → details + formatted section appended to the summary", async () => {
  const r = await runTgCompaction({
    preparation: prep({ fileOps: { read: new Set(["a.ts", "b.ts"]), written: new Set(["b.ts"]), edited: new Set(["c.ts"]) } }),
    model,
    signal: noAbort.signal,
    complete: async () => textResponse("SUMMARY"),
  });
  assert.ok("compaction" in r);
  assert.deepEqual(r.compaction.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts", "c.ts"] });
  assert.ok(r.compaction.summary.startsWith("SUMMARY\n\n<read-files>"));
  assert.ok(r.compaction.summary.includes("<modified-files>\nb.ts\nc.ts\n</modified-files>"));
});

test("runTgCompaction: already-aborted signal → {aborted: true} without any LLM call", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const r = await runTgCompaction({ preparation: prep(), model, signal: controller.signal, complete: async () => { called++; return textResponse("S"); } });
  assert.deepEqual(r, { aborted: true });
  assert.equal(called, 0);
});

test("runTgCompaction: Stop mid-call (provider rejects with AbortError) → {aborted: true}", async () => {
  const controller = new AbortController();
  const p = runTgCompaction({
    preparation: prep(),
    model,
    signal: controller.signal,
    complete: async (_m, _c, options) => {
      await new Promise((r) => setImmediate(r)); // in flight…
      if (!options.signal.aborted) throw new Error("test: expected the signal to be aborted");
      // pi's model stream rejects with an AbortError when our signal aborts
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  });
  controller.abort(); // the user presses Stop while the call is in flight
  assert.deepEqual(await p, { aborted: true });
});

test("runTgCompaction: stopReason 'aborted' → {aborted: true}", async () => {
  const r = await runTgCompaction({
    preparation: prep(),
    model,
    signal: noAbort.signal,
    complete: async () => ({ stopReason: "aborted", content: [], usage: usage() }),
  });
  assert.deepEqual(r, { aborted: true });
});

test("runTgCompaction: stopReason 'error' → throws with the provider message", async () => {
  await assert.rejects(
    runTgCompaction({ preparation: prep(), model, signal: noAbort.signal, complete: async () => ({ stopReason: "error", errorMessage: "boom <html>", content: [], usage: usage() }) }),
    /Summarization failed: boom <html>/,
  );
});

test("runTgCompaction: stopReason 'length' → throws (incomplete summary must not be stored)", async () => {
  await assert.rejects(
    runTgCompaction({ preparation: prep(), model, signal: noAbort.signal, complete: async () => ({ stopReason: "length", content: [{ type: "text", text: "cut" }], usage: usage() }) }),
    /hit the token cap/,
  );
});

test("runTgCompaction: tool call in the response → throws", async () => {
  await assert.rejects(
    runTgCompaction({
      preparation: prep(),
      model,
      signal: noAbort.signal,
      complete: async () => ({ stopReason: "stop", content: [{ type: "toolCall", name: "read", arguments: {} } as never], usage: usage() }),
    }),
    /attempted to call a tool/,
  );
});

test("COMPACT_CANCELLED_MSG is the error pi reports for a cancelled compaction", () => {
  assert.equal(COMPACT_CANCELLED_MSG, "Compaction cancelled");
});
