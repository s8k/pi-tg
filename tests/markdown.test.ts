import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, escapeHtml, extractWhy, RICH_CAP, richUnits, toolArgsJson } from "../src/markdown.ts";

describe("escape", () => {
  test("escapeHtml: & < >", () => {
    assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  });
});

describe("chunking (plain rung)", () => {
  const MARKER = "(continued)\n";

  test("small doc → one chunk, no marker", () => {
    assert.deepEqual(chunkText("hello world"), ["hello world"]);
  });

  test("split: marker on 2nd chunk only, all chunks ≤ maxLen", () => {
    const a = "x".repeat(4000);
    const b = "y".repeat(900);
    const chunks = chunkText(a + "\n" + b, 4096);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], a);
    assert.ok(chunks[1].startsWith(MARKER));
    assert.equal(chunks[1].slice(MARKER.length), b);
    for (const c of chunks) assert.ok(c.length <= 4096);
  });

  test("empty doc → no chunks; blank lines are skipped, whitespace lines are content", () => {
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("\n\n"), []);
    assert.deepEqual(chunkText("  "), ["  "]); // chunkText is the plain rung — "  " is a real line
  });

  test("chunkText: line-boundary split, reconstructable", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ` + "x".repeat(100));
    const text = lines.join("\n");
    const chunks = chunkText(text, 300);
    for (const c of chunks) assert.ok(c.length <= 300);
    const joined = chunks.map((c, i) => (i ? c.slice(MARKER.length) : c)).join("\n");
    assert.equal(joined, text);
  });
});

test("RICH_CAP: exported number with margin under the documented 32768", () => {
  assert.equal(RICH_CAP, 32_000);
  assert.ok(RICH_CAP < 32_768);
});

test("richUnits: paragraph / heading / fence / list / table / blank handling", () => {
  const md = ["# T", "", "a para", "more", "", "```js", "x=1", "```", "", "- one", "1. two", "", "| h1 | h2 |", "| --- | --- |", "| a | b |"].join("\n");
  assert.deepEqual(richUnits(md), [
    { type: "heading", text: "# T" },
    { type: "paragraph", text: "a para\nmore" },
    { type: "fence", text: "```js\nx=1\n```" },
    { type: "list", text: "- one\n1. two" },
    { type: "table", text: "| h1 | h2 |\n| --- | --- |\n| a | b |" },
  ]);
});

test("richUnits: adjacent paragraph lines merge; blank lines separate", () => {
  assert.deepEqual(richUnits("a\nb\nc\n\nd"), [
    { type: "paragraph", text: "a\nb\nc" },
    { type: "paragraph", text: "d" },
  ]);
});

test("richUnits: unclosed fence (streaming) → single fence unit to EOF", () => {
  assert.deepEqual(richUnits("```\nline1\nline2"), [{ type: "fence", text: "```\nline1\nline2" }]);
});

test("richUnits: table needs a separator row after the header", () => {
  const units = richUnits("| a |\n| b |");
  assert.equal(units.length, 1);
  assert.equal(units[0].type, "paragraph");
});

test("richUnits: <details> region → one details unit", () => {
  assert.deepEqual(richUnits("before\n<details>\nbody\n</details>\nafter"), [
    { type: "paragraph", text: "before" },
    { type: "details", text: "<details>\nbody\n</details>" },
    { type: "paragraph", text: "after" },
  ]);
});

// ─────────────────────────── Work-log tool blocks (two-message mirror) ───────────────────────────

describe("toolArgsJson", () => {
  test("pretty-prints the args", () => {
    assert.equal(toolArgsJson({ path: "a.ts" }), '{\n  "path": "a.ts"\n}');
  });

  test("caps around 2 KB with a trailing ellipsis", () => {
    const out = toolArgsJson({ s: "x".repeat(3000) });
    assert.ok(out.length <= 2048 + "\n…".length);
    assert.ok(out.endsWith("\n…"));
  });

  test("undefined/null → {}", () => {
    assert.equal(toolArgsJson(undefined), "{}");
    assert.equal(toolArgsJson(null), "{}");
  });

  test("non-serializable → String fallback, no throw", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    assert.equal(toolArgsJson(circ), "[object Object]");
  });
});

describe("extractWhy (last thinking sentence before a tool call)", () => {
  test("last sentence of the stream", () => {
    assert.equal(extractWhy(["Let me check the handler. Then I will read it."]), "Then I will read it.");
  });

  test("joins multiple thinking parts in content order", () => {
    assert.equal(extractWhy(["First. Second.", "Third. Fourth."]), "Fourth.");
  });

  test("no sentence punctuation → the whole text", () => {
    assert.equal(extractWhy(["just some thoughts"]), "just some thoughts");
  });

  test("empty / whitespace-only → undefined (absent or redacted thinking)", () => {
    assert.equal(extractWhy([]), undefined);
    assert.equal(extractWhy(["", "   "]), undefined);
  });

  test("truncated to 200 chars (+ ellipsis)", () => {
    const long = "word ".repeat(60).trim(); // 299 chars, no punctuation
    const out = extractWhy([long + "."]) as string;
    assert.equal(out.length, 201);
    assert.ok(out.endsWith("…"));
  });

  test("honors a custom cap", () => {
    assert.equal(extractWhy(["abcdef"], 3), "abc…");
  });
});
