// toolResultText: the work log's ✖ error text comes from the tool result —
// strings pass through, AgentToolResult text parts are joined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResultText } from "../src/mirror.ts";

test("toolResultText: string passthrough", () => {
  assert.equal(toolResultText("boom"), "boom");
});

test("toolResultText: joins the text parts of an AgentToolResult", () => {
  const result = {
    content: [
      { type: "text", text: "line one" },
      { type: "thinking", thinking: "not text" },
      { type: "text", text: "line two" },
    ],
  };
  assert.equal(toolResultText(result), "line one\nline two");
});

test("toolResultText: absent/unknown shapes → empty string", () => {
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText(42), "");
  assert.equal(toolResultText({ details: { x: 1 } }), "");
});
