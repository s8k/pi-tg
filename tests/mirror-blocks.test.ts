// mirrorBlocks: LogBlock[] + tail + bottom → TgBlock[] (the blocks-tier
// replacement for blocksToMd). The SAME builder feeds drafts (thinking kept)
// and persistent sends (thinking stripped at the caller).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorBlocks } from "../src/mirror.ts";
import type { LogBlock, BottomLine } from "../src/mirror.ts";
import { blocksToPlainText } from "../src/rich-blocks.ts";
import type { TgBlock } from "../src/rich-blocks.ts";

type Opts = { tail?: string; bottom: BottomLine; tokens?: { input: number; output: number } };
const last = (bs: TgBlock[]): TgBlock => bs[bs.length - 1]!;
const plain = (b: TgBlock | undefined): string => {
  if (!b) return "";
  if (b.type === "paragraph" || b.type === "heading" || b.type === "thinking") return blocksToPlainText([b]);
  if (b.type === "pre") return b.text;
  if (b.type === "details") return blocksToPlainText([{ type: "paragraph", text: b.summary }]);
  return b.type;
};

test("narration → mdToBlocks (full conversion, plan spec — not a raw paragraph)", () => {
  const bs = mirrorBlocks([{ type: "narration", text: "hello **bold**" }], { bottom: { kind: "done" } });
  assert.deepEqual(bs[0], { type: "paragraph", text: ["hello ", { type: "bold", text: "bold" }] });
});

test("narration with a list → list block", () => {
  const bs = mirrorBlocks([{ type: "narration", text: "- a\n- b" }], { bottom: { kind: "done" } });
  assert.equal(bs[0]?.type, "list");
});

test("agentError / prompt stay raw paragraphs (short bot strings, no LLM markdown)", () => {
  const bs = mirrorBlocks(
    [{ type: "agentError", text: "boom" }, { type: "prompt", text: "**hi**" }],
    { bottom: { kind: "done" } },
  );
  assert.equal(bs[0]?.type, "paragraph");
  assert.equal(plain(bs[0]), "⚠️ error: boom");
  // the prompt's markdown is NOT converted (raw string text)
  const promptPara = bs.find((b) => b.type === "paragraph" && (b as { text: unknown }).text === "**hi**");
  assert.ok(promptPara, "prompt stays a raw paragraph");
});

test("tool → details(⚙ name state) + pre(json args)", () => {
  const bs = mirrorBlocks(
    [{ type: "tool", id: "1", name: "bash", argsJson: '{"a":1}', state: "…" }],
    { bottom: { kind: "done" } },
  );
  const d = bs[0];
  assert.equal(d?.type, "details");
  if (d?.type !== "details") return;
  assert.equal(plain(d), "⚙ bash …");
  assert.equal(d.blocks.length, 1);
  const pre = d.blocks[0];
  assert.equal(pre?.type, "pre");
  if (pre?.type !== "pre") return;
  assert.equal(pre.text, '{"a":1}');
  assert.equal(pre.language, "json");
});

test("tool with why → leading 💭 italic paragraph", () => {
  const bs = mirrorBlocks(
    [{ type: "tool", id: "1", name: "bash", argsJson: "{}", state: "…", why: "checking" }],
    { bottom: { kind: "done" } },
  );
  const first = bs[0];
  assert.equal(first?.type, "paragraph");
  assert.equal(plain(first), `💭 "checking"`);
});

test("tool error state + errorText → details + pre(error)", () => {
  const bs = mirrorBlocks(
    [{ type: "tool", id: "1", name: "bash", argsJson: "{}", state: "✖", errorText: "boom" }],
    { bottom: { kind: "done" } },
  );
  assert.equal(bs.length, 3); // details + pre(error) + Completed marker
  assert.equal(plain(bs[1]), "boom");
});

test("prompt → paragraph; agentError → ⚠️ line", () => {
  const bs = mirrorBlocks(
    [
      { type: "prompt", text: "do X" },
      { type: "agentError", text: "boom" },
    ],
    { bottom: { kind: "done" } },
  );
  assert.equal(bs[0]?.type, "paragraph");
  const err = bs.find((b: TgBlock) => b.type === "paragraph" && plain(b).startsWith("⚠️ error:"));
  assert.ok(err, "agentError renders as a ⚠️ line");
});

test("agentError + following content → divider after it", () => {
  const log: LogBlock[] = [
    { type: "agentError", text: "boom" },
    { type: "narration", text: "retry" },
  ];
  const bs = mirrorBlocks(log, { bottom: { kind: "done" } });
  const errIdx = bs.findIndex((b: TgBlock) => b.type === "paragraph" && plain(b).includes("boom"));
  assert.equal(bs[errIdx + 1]?.type, "divider");
});

test("done: [blocks] [Completed ✔️] [tail] — marker before the answer", () => {
  const bs = mirrorBlocks([{ type: "narration", text: "log" }], { tail: "the answer", bottom: { kind: "done" } });
  const doneIdx = bs.findIndex((b: TgBlock) => b.type === "paragraph" && plain(b).includes("Completed ✔️"));
  assert.ok(doneIdx > 0);
  assert.equal(bs[bs.length - 1]?.type, "paragraph");
  assert.equal(plain(bs[bs.length - 1]), "the answer");
});

test("done with tokens: marker carries the ↑↓ suffix", () => {
  const bs = mirrorBlocks([], { tail: "a", bottom: { kind: "done" }, tokens: { input: 100, output: 25 } });
  const marker = bs.find((b: TgBlock) => b.type === "paragraph" && plain(b).includes("Completed"));
  const t = plain(marker);
  assert.ok(t.includes("↑100"), t);
  assert.ok(t.includes("↓25"), t);
});

test("thinking bottom: [blocks] [tail] [NBSP] [thinking]", () => {
  const bs = mirrorBlocks([{ type: "narration", text: "log" }], { tail: "stream", bottom: { kind: "thinking", word: "Working" } });
  const t = last(bs);
  assert.equal(t.type, "thinking");
  assert.ok(plain(t).includes("Working…"));
  // NBSP gap before the spinner (there is content above)
  const gap = bs[bs.length - 2];
  assert.equal(gap?.type, "paragraph");
  assert.equal(plain(gap), "\u00a0");
});

test("thinking bottom with empty log+tail: no NBSP gap, spinner alone", () => {
  const bs = mirrorBlocks([], { bottom: { kind: "thinking", word: "Working" } });
  assert.equal(bs.length, 1);
  assert.equal(bs[0]?.type, "thinking");
});

test("thinking bottom with tokens: suffix inside the thinking text", () => {
  const bs = mirrorBlocks([], { bottom: { kind: "thinking", word: "Working" }, tokens: { input: 12_500, output: 3 } });
  const t = last(bs);
  if (t.type !== "thinking") return;
  const p = plain(t);
  assert.ok(p.includes("↑12.5k"), p);
  assert.ok(p.includes("↓3"), p);
});

test("compact bottom: status replaces the word, no trailing …", () => {
  const bs = mirrorBlocks([], { bottom: { kind: "compact", status: "Compacting 105,414 → 32,876 tokens" } });
  const t = last(bs);
  if (t.type !== "thinking") return;
  const p = plain(t);
  assert.ok(p.startsWith("Compacting"), p);
  assert.ok(!p.includes("…"), p);
});

test("error + thinking: [blocks] [tail] [⚠ line] [divider] [thinking]", () => {
  const bs = mirrorBlocks(
    [{ type: "narration", text: "log" }],
    { tail: "partial", bottom: { kind: "error", text: "boom", thinking: true, word: "Working" } },
  );
  assert.deepEqual(bs.map((b) => b.type), ["paragraph", "paragraph", "paragraph", "divider", "thinking"]);
});

test("error + thinking, empty ⚠ text: NBSP gap, no ⚠ line", () => {
  const bs = mirrorBlocks(
    [{ type: "narration", text: "log" }],
    { bottom: { kind: "error", text: "", thinking: true, word: "Working" } },
  );
  assert.deepEqual(bs.map((b) => b.type), ["paragraph", "paragraph", "thinking"]);
  assert.equal(plain(bs[1]), "\u00a0");
});

test("error (finalized, no thinking): ⚠ line LAST + trailing divider when content above", () => {
  const bs = mirrorBlocks(
    [{ type: "narration", text: "log" }],
    { tail: "partial", bottom: { kind: "error", text: "boom" } },
  );
  assert.deepEqual(bs.map((b) => b.type), ["paragraph", "paragraph", "paragraph", "divider"]);
  assert.ok(plain(bs[2]).includes("⚠️ error: boom"));
});

test("error (finalized), bare ⚠ only: no divider", () => {
  const bs = mirrorBlocks([], { bottom: { kind: "error", text: "boom" } });
  assert.equal(bs.length, 1);
  assert.equal(bs[0]?.type, "paragraph");
});

test("aborted: ⚠️ Request was aborted, no divider", () => {
  const bs = mirrorBlocks([{ type: "narration", text: "log" }], { bottom: { kind: "aborted" } });
  const t = last(bs);
  assert.equal(t.type, "paragraph");
  assert.equal(plain(t), "⚠️ Request was aborted");
});

test("paused: ⏸ line, no spinner", () => {
  const bs = mirrorBlocks([], { tail: "tail", bottom: { kind: "paused" } });
  const t = last(bs);
  assert.equal(t.type, "paragraph");
  assert.ok(plain(t).includes("⏸️ Paused"));
});

test("empty tail is dropped (whitespace-only)", () => {
  const bs = mirrorBlocks([], { tail: "   ", bottom: { kind: "done" } });
  assert.equal(bs.length, 1); // just the Completed marker
});
