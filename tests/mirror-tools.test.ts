// Single-message content builder — pure: block layout, blank-line
// separation, tool-block rendering, and the bottom-line layout:
//  - while working:  [blocks] [streaming tail] [blank line] [<tg-thinking>…]
//    — spinner LAST; any text above it is separated by an extra blank line
//    (an NBSP paragraph — no horizontal line, which collides with the
//    <details> handle below tool blocks; no text above → no blank line)
//  - done:           [blocks] [Completed ✔️] [answer]
//    (marker at the end of the work, then the answer — NO divider;
//    the answer is split into its own message anyway)
//  - error:          [blocks] [answer]  — NO marker (the `⚠️ error: …` log
//    block already carries the signal)
//  - none:           [blocks] [tail]
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMd, toolResultText, type LogBlock, type BottomLine } from "../src/mirror.ts";
import { renderToolBlock } from "../src/markdown.ts";

const thinking = (word = "Pondering"): BottomLine => ({ kind: "thinking", word });
const done: BottomLine = { kind: "done" };
const error = (text = "boom"): BottomLine => ({ kind: "error", text });
const aborted: BottomLine = { kind: "aborted" };

const toolBlock: LogBlock = {
  type: "tool",
  id: "c1",
  name: "read",
  argsJson: "{\n  \"path\": \"src/app.ts\"\n}",
  why: "the test expects a 302.",
  state: "✔",
};

test("blocksToMd: single narration + thinking bottom line — extra blank line (NBSP) between the text and the spinner", () => {
  const out = blocksToMd([{ type: "narration", text: "Let me check the failing test." }], { bottom: thinking() });
  assert.equal(out, `Let me check the failing test.\n\n\u00a0\n\n<tg-thinking>Pondering…</tg-thinking>`);
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
  assert.equal(blocksToMd(log, { bottom: aborted }), `${rendered.join("\n\n")}\n\n⚠️ Request was aborted`);
});

test("blocksToMd: done/error/aborted WITHOUT an answer — done has the marker, error/aborted their bottom line", () => {
  const log: LogBlock[] = [{ type: "narration", text: "A" }];
  assert.equal(blocksToMd(log, { bottom: done }), "A\n\nCompleted ✔️");
  assert.equal(blocksToMd(log, { bottom: error("Provider timeout") }), "A\n\n⚠️ error: Provider timeout");
  assert.equal(blocksToMd(log, { bottom: aborted }), "A\n\n⚠️ Request was aborted");
});

test("blocksToMd: done — marker at the end of the log, then the answer (NO divider)", () => {
  const log: LogBlock[] = [{ type: "narration", text: "A" }];
  const out = blocksToMd(log, { tail: "The answer is 42.", bottom: done });
  assert.equal(out, "A\n\nCompleted ✔️\n\nThe answer is 42.");
});

test("blocksToMd: error — log, then the (partial) answer, then the ⚠️ line LAST (bottom-line slot)", () => {
  const log: LogBlock[] = [{ type: "narration", text: "A" }];
  const out = blocksToMd(log, { tail: "Partial…", bottom: error("Provider timeout") });
  assert.equal(out, "A\n\nPartial…\n\n⚠️ error: Provider timeout");
});

test("blocksToMd: done with an empty log — marker + answer only", () => {
  const out = blocksToMd([], { tail: "Just an answer.", bottom: done });
  assert.equal(out, "Completed ✔️\n\nJust an answer.");
});

test("blocksToMd: empty log — spinner only, no line (there is no text above it)", () => {
  assert.equal(blocksToMd([], { bottom: thinking("Weaving") }), "<tg-thinking>Weaving…</tg-thinking>");
});

test("blocksToMd: blocks only (no tail) — the blank line separates the log from the spinner", () => {
  const out = blocksToMd([toolBlock], { bottom: thinking() });
  assert.ok(out.endsWith("\n\n\u00a0\n\n<tg-thinking>Pondering…</tg-thinking>"), out);
});

test("blocksToMd: while working — the streaming tail goes between the log and the blank line + spinner", () => {
  const out = blocksToMd(
    [{ type: "narration", text: "Earlier text." }],
    { tail: "Let me check the failing test…", bottom: thinking() },
  );
  assert.equal(out, `Earlier text.\n\nLet me check the failing test…\n\n\u00a0\n\n<tg-thinking>Pondering…</tg-thinking>`);
});

test("blocksToMd: aborted — the partial answer follows the log, then the ⚠️ line LAST", () => {
  const out = blocksToMd([{ type: "narration", text: "A" }], { tail: "Partial answer.", bottom: aborted });
  assert.equal(out, "A\n\nPartial answer.\n\n⚠️ Request was aborted");
});

test("blocksToMd: whitespace-only tail is dropped (every bottom kind)", () => {
  assert.equal(blocksToMd([], { tail: "   ", bottom: thinking() }), "<tg-thinking>Pondering…</tg-thinking>"); // nothing above the spinner → no blank line
  assert.equal(blocksToMd([{ type: "narration", text: "A" }], { tail: "   ", bottom: thinking() }), "A\n\n\u00a0\n\n<tg-thinking>Pondering…</tg-thinking>"); // the log is still text above it
  assert.equal(blocksToMd([], { tail: "   ", bottom: done }), "Completed ✔️");
  assert.equal(blocksToMd([], { tail: "   ", bottom: error("boom") }), "⚠️ error: boom");
  assert.equal(blocksToMd([], { tail: "   ", bottom: aborted }), "⚠️ Request was aborted");
  assert.equal(blocksToMd([], { tail: "   ", bottom: error("") }), ""); // no text → no line
});

// ── tool blocks ──

test("renderToolBlock: done, with why — the tool name + state is the details summary (no separate params label)", () => {
  // Segments are separated by BLANK lines: a bare newline is a soft wrap in
  // Markdown, so 💭/details/<pre> would otherwise render as one visual line.
  const out = renderToolBlock({
    name: "read",
    argsJson: "{\n  \"path\": \"src/app.ts\"\n}",
    why: "the test expects a 302.",
    state: "✔",
  });
  assert.equal(
    out,
    [
      '💭 *"the test expects a 302."*',
      "",
      "<details><summary>⚙ read ✔</summary>",
      "",
      "```json",
      "{\n  \"path\": \"src/app.ts\"\n}",
      "```",
      "",
      "</details>",
    ].join("\n"),
  );
});

test("renderToolBlock: pending state — the … stamp is in the details summary", () => {
  const out = renderToolBlock({ name: "bash", argsJson: "{}", state: "…" });
  assert.equal(out.split("\n")[0], "<details><summary>⚙ bash …</summary>");
  assert.ok(!out.includes("params"), "no separate params label");
});

test("renderToolBlock: no why → no 💭 line; the details summary is the first line", () => {
  const out = renderToolBlock({ name: "mytool", argsJson: "{}", state: "✔" });
  const lines = out.split("\n");
  assert.equal(lines[0], "<details><summary>⚙ mytool ✔</summary>");
  assert.ok(!out.includes("💭"));
});

test("renderToolBlock: ✖ shows the error in a visible <pre>, HTML-escaped", () => {
  const out = renderToolBlock({
    name: "edit",
    argsJson: "{}",
    state: "✖",
    errorText: "RangeError: Invalid arg <bad> & more",
  });
  assert.equal(out.split("\n").pop(), "<pre>RangeError: Invalid arg &lt;bad&gt; &amp; more</pre>");
});

test("renderToolBlock: ✔ never carries the <pre>", () => {
  const out = renderToolBlock({ name: "read", argsJson: "{}", state: "✔", errorText: "ignored" });
  assert.ok(!out.includes("<pre>"));
});

test("renderToolBlock: argsJson is HTML-escaped inside the json fence", () => {
  const argsJson = "{\n  \"command\": \"echo hi <b> & bye\"\n}";
  const out = renderToolBlock({ name: "bash", argsJson, state: "✔" });
  const fence = ["```json", "{", '  "command": "echo hi &lt;b&gt; &amp; bye"', "}", "```"].join("\n");
  assert.ok(out.includes(fence), out);
});

test("renderToolBlock: why is HTML-escaped", () => {
  const out = renderToolBlock({ name: "read", argsJson: "{}", why: "a < b & c", state: "✔" });
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
