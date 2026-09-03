// Message 1 (work log) content builder — pure: block layout, blank-line
// separation, tool-block rendering, tag/marker bottom lines, escaping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMd, toolResultText, type LogBlock, type BottomLine } from "../src/mirror.ts";
import { renderToolBlock } from "../src/markdown.ts";

const thinking = (word = "Pondering"): BottomLine => ({ kind: "thinking", word });
const done: BottomLine = { kind: "done" };
const error: BottomLine = { kind: "error" };
const none: BottomLine = { kind: "none" };

const toolBlock: LogBlock = {
  type: "tool",
  id: "c1",
  name: "read",
  keyArg: "src/app.ts",
  argsJson: "{\n  \"path\": \"src/app.ts\"\n}",
  why: "the test expects a 302.",
  state: "✔",
};

test("blocksToMd: single narration + thinking bottom line", () => {
  const out = blocksToMd([{ type: "narration", text: "Let me check the failing test." }], { bottom: thinking() });
  assert.equal(out, 'Let me check the failing test.\n\n<tg-thinking>Pondering…</tg-thinking>');
});

test("blocksToMd: blocks are separated by exactly one blank line, in order", () => {
  const log: LogBlock[] = [
    { type: "narration", text: "Let me check the failing test." },
    toolBlock,
    { type: "prompt", text: "⚠️ terminal prompt: pick a model — answer there" },
    { type: "agentError", text: "⚠️ error: overloaded" },
  ];
  const rendered = [
    "Let me check the failing test.",
    renderToolBlock(toolBlock),
    "⚠️ terminal prompt: pick a model — answer there",
    "⚠️ error: overloaded",
  ];
  assert.equal(blocksToMd(log, { bottom: none }), rendered.join("\n\n"));
});

test("blocksToMd: bottom lines — Completed ✔️ / ⚠ Error / stripped", () => {
  const log: LogBlock[] = [{ type: "narration", text: "A" }];
  assert.equal(blocksToMd(log, { bottom: done }), "A\n\nCompleted ✔️");
  assert.equal(blocksToMd(log, { bottom: error }), "A\n\n⚠ Error");
  assert.equal(blocksToMd(log, { bottom: none }), "A");
});

test("blocksToMd: empty log", () => {
  assert.equal(blocksToMd([], { bottom: none }), "");
  assert.equal(blocksToMd([], { bottom: thinking("Weaving") }), "<tg-thinking>Weaving…</tg-thinking>");
});

test("blocksToMd: the demoted tail goes between the log and the bottom line", () => {
  const out = blocksToMd(
    [{ type: "narration", text: "Earlier text." }],
    { tail: "Let me check the failing test…", bottom: thinking() },
  );
  assert.equal(out, 'Earlier text.\n\nLet me check the failing test…\n\n<tg-thinking>Pondering…</tg-thinking>');
});

test("blocksToMd: whitespace-only tail is dropped", () => {
  const out = blocksToMd([], { tail: "   ", bottom: thinking() });
  assert.equal(out, "<tg-thinking>Pondering…</tg-thinking>");
});

// ── tool blocks ──

test("renderToolBlock: done, with why — full layout", () => {
  const out = renderToolBlock({
    name: "read",
    keyArg: "src/app.ts",
    argsJson: "{\n  \"path\": \"src/app.ts\"\n}",
    why: "the test expects a 302.",
    state: "✔",
  });
  assert.equal(
    out,
    [
      "⚙ read src/app.ts ✔",
      '💭 *"the test expects a 302."*',
      "<details><summary>params</summary>",
      "",
      "```json",
      "{\n  \"path\": \"src/app.ts\"\n}",
      "```",
      "",
      "</details>",
    ].join("\n"),
  );
});

test("renderToolBlock: pending state is the … stamp", () => {
  const out = renderToolBlock({ name: "bash", keyArg: "ls -la", argsJson: "{}", state: "…" });
  assert.equal(out.split("\n")[0], "⚙ bash ls -la …");
});

test("renderToolBlock: no why → no 💭 line; no keyArg → name only", () => {
  const out = renderToolBlock({ name: "mytool", keyArg: "", argsJson: "{}", state: "✔" });
  const lines = out.split("\n");
  assert.equal(lines[0], "⚙ mytool ✔");
  assert.ok(!out.includes("💭"));
});

test("renderToolBlock: ✖ shows the error in a visible <pre>, HTML-escaped", () => {
  const out = renderToolBlock({
    name: "edit",
    keyArg: "src/app.ts",
    argsJson: "{}",
    state: "✖",
    errorText: "RangeError: Invalid arg <bad> & more",
  });
  assert.equal(out.split("\n").pop(), "<pre>RangeError: Invalid arg &lt;bad&gt; &amp; more</pre>");
});

test("renderToolBlock: ✔ never carries the <pre>", () => {
  const out = renderToolBlock({ name: "read", keyArg: "a", argsJson: "{}", state: "✔", errorText: "ignored" });
  assert.ok(!out.includes("<pre>"));
});

test("renderToolBlock: argsJson is HTML-escaped inside the json fence", () => {
  const argsJson = "{\n  \"command\": \"echo hi <b> & bye\"\n}";
  const out = renderToolBlock({ name: "bash", keyArg: "echo", argsJson, state: "✔" });
  const fence = ["```json", "{", '  "command": "echo hi &lt;b&gt; &amp; bye"', "}", "```"].join("\n");
  assert.ok(out.includes(fence), out);
});

test("renderToolBlock: why is HTML-escaped", () => {
  const out = renderToolBlock({ name: "read", keyArg: "a", argsJson: "{}", why: "a < b & c", state: "✔" });
  assert.ok(out.includes('💭 *"a &lt; b &amp; c"*'), out);
});

// ── tool result text (feeds ✖ blocks) ──

test("toolResultText: string passthrough", () => {
  assert.equal(toolResultText("boom"), "boom");
});

test("toolResultText: joins the text parts of an AgentToolResult", () => {
  const result = {
    content: [
      { type: "text", text: "line one" },
      { type: "image", data: "AAA=", mimeType: "image/png" },
      { type: "text", text: "line two" },
    ],
    details: undefined,
  };
  assert.equal(toolResultText(result), "line one\nline two");
});

test("toolResultText: absent/unknown shapes → empty string", () => {
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText(42), "");
  assert.equal(toolResultText({ details: { x: 1 } }), "");
});
