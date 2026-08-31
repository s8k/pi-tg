import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, chunkRich, chunkText, escapeAttr, escapeHtml, foldLongFences, inlineToHtml, markdownToHtml, RICH_CAP, richUnits, toPlainText } from "../src/markdown.ts";

describe("escape", () => {
  test("escapeHtml: & < >", () => {
    assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  });
  test("escapeAttr: also quotes", () => {
    assert.equal(escapeAttr('a"b&c'), "a&quot;b&amp;c");
  });
});

describe("inline", () => {
  test("code span: content verbatim + escaped, no formatting inside", () => {
    assert.equal(inlineToHtml("`a<b> & **x**`"), `<code>a&lt;b&gt; &amp; **x**</code>`);
  });
  test("bold ** and __", () => {
    assert.equal(inlineToHtml("**hi**"), "<b>hi</b>");
    assert.equal(inlineToHtml("__hi__"), "<b>hi</b>");
  });
  test("italic * and _", () => {
    assert.equal(inlineToHtml("*hi*"), "<i>hi</i>");
    assert.equal(inlineToHtml("_hi_"), "<i>hi</i>");
  });
  test("strikethrough ~~", () => {
    assert.equal(inlineToHtml("~~old~~"), "<s>old</s>");
  });
  test("link: url attr-escaped, text parsed recursively", () => {
    assert.equal(inlineToHtml("[t](http://x/?a=1&b=2)"), `<a href="http://x/?a=1&amp;b=2">t</a>`);
    assert.equal(inlineToHtml("[**b**](u)"), `<a href="u"><b>b</b></a>`);
  });
  test("nested emphasis, both directions", () => {
    assert.equal(inlineToHtml("**bold *ital* bold**"), "<b>bold <i>ital</i> bold</b>");
    assert.equal(inlineToHtml("*ital **bold** ital*"), "<i>ital <b>bold</b> ital</i>");
  });
  test("intraword underscores stay literal (identifiers)", () => {
    assert.equal(inlineToHtml("snake_case_name"), "snake_case_name");
    assert.equal(inlineToHtml("foo__bar__"), "foo__bar__");
  });
  test("unmatched markers stay literal; tags always balanced", () => {
    assert.equal(inlineToHtml("*unterminated"), "*unterminated");
    assert.equal(inlineToHtml("**no close"), "**no close");
    const samples = ["a * b ** c ` d", "**bold *x", "100% * 2 ~ 3 _ v1.2_", "[broken](", "`unclosed"];
    for (const s of samples) {
      const out = inlineToHtml(s);
      for (const [open, close] of [
        [/<b>/g, "</b>"],
        [/<i>/g, "</i>"],
        [/<s>/g, "</s>"],
        [/<code>/g, "</code>"],
      ]) {
        assert.equal((out.match(open) ?? []).length, (out.match(new RegExp(close, "g")) ?? []).length,
          `unbalanced in ${JSON.stringify(out)} from ${JSON.stringify(s)}`);
      }
    }
  });
});

describe("blocks", () => {
  test("fence → <pre>, content escaped, newlines kept", () => {
    assert.equal(markdownToHtml("```js\nconst a = 1 < 2;\n```"), "<pre>const a = 1 &lt; 2;</pre>");
  });
  test("unclosed fence (streaming) renders to EOF", () => {
    assert.equal(markdownToHtml("```\npartial ="), "<pre>partial =</pre>");
  });
  test("tilde fences work; fence longer than 3 closes", () => {
    assert.equal(markdownToHtml("~~~\nx\n~~~"), "<pre>x</pre>");
    assert.equal(markdownToHtml("````\n```inner```\n````"), "<pre>```inner```</pre>");
  });
  test("headings → bold", () => {
    assert.equal(markdownToHtml("# Title"), "<b>Title</b>");
    assert.equal(markdownToHtml("## Sub #"), "<b>Sub</b>");
  });
  test("lists, quote, hr", () => {
    assert.equal(markdownToHtml("- one\n* two\n1. num"), "• one\n• two\n1. num");
    assert.equal(markdownToHtml("> quoted"), "❝ quoted");
    assert.equal(markdownToHtml("---"), "────────");
    assert.equal(markdownToHtml("- - -"), "────────");
  });
  test("combined document", () => {
    const md = "## Plan\n\n- do `x`\n\n```\na < b\n```\n\n**done**";
    assert.equal(markdownToHtml(md), "<b>Plan</b>\n• do <code>x</code>\n<pre>a &lt; b</pre>\n<b>done</b>");
  });
});

describe("chunking", () => {
  const MARKER = "(continued)\n";

  test("small doc → one chunk, no marker", () => {
    assert.deepEqual(chunkMarkdown("hello world"), ["hello world"]);
  });

  test("split: marker on 2nd chunk only, all chunks ≤ maxLen", () => {
    const a = "x".repeat(4000);
    const b = "y".repeat(900);
    const chunks = chunkMarkdown(a + "\n" + b, 4096);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], a);
    assert.ok(chunks[1].startsWith(MARKER));
    assert.equal(chunks[1].slice(MARKER.length), b);
    for (const c of chunks) assert.ok(c.length <= 4096);
  });

  test("code fence stays whole; trailing text moves to next chunk", () => {
    const code = Array.from({ length: 240 }, () => "line").join("\n"); // 1439 chars
    const md = "```\n" + code + "\n```\ntrailing";
    const chunks = chunkMarkdown(md, 1230);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith("<pre>") && chunks[0].endsWith("</pre>"));
    assert.ok(chunks[1].startsWith(MARKER));
    assert.equal(chunks[1].slice(MARKER.length), "trailing");
    for (const c of chunks) assert.ok(c.length <= 1230);
  });

  test("oversized fence re-wrapped as multiple valid <pre> blocks, content preserved", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `l${i}x`);
    const md = "```\n" + codeLines.join("\n") + "\n```";
    const chunks = chunkMarkdown(md, 1500);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      const body = c.startsWith(MARKER) ? c.slice(MARKER.length) : c;
      assert.ok(body.startsWith("<pre>") && body.endsWith("</pre>"), body.slice(0, 40));
    }
    const reconstructed = chunks
      .map((c) => (c.startsWith(MARKER) ? c.slice(MARKER.length) : c))
      .map((c) => c.slice(5, -6)) // strip <pre> / </pre>
      .join("\n");
    assert.equal(reconstructed, codeLines.join("\n"));
  });

  test("empty doc → no chunks", () => {
    assert.deepEqual(chunkMarkdown(""), []);
    assert.deepEqual(chunkMarkdown("  \n\n"), []);
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

describe("toPlainText", () => {
  test("strips markers, keeps content", () => {
    const md = "# Title\n\n- `x` item\n- two\n1. num\n\n**bold** and [t](http://u) ~~gone~~\n\n---\n\n> quote";
    assert.equal(
      toPlainText(md),
      ["Title", "", "• x item", "• two", "1. num", "", "bold and t (http://u) gone", "", "────────", "", "quote"].join("\n"),
    );
  });

  test("fence content kept verbatim (no HTML)", () => {
    assert.equal(toPlainText("```\n<a & b>\n```"), "<a & b>");
  });
});

// ── rich pipeline (Bot API 10.2) ──

test("RICH_CAP: exported number with margin under the documented 32768", () => {
  assert.ok(RICH_CAP >= 16_000 && RICH_CAP < 32_768, `RICH_CAP=${RICH_CAP}`);
});

test("richUnits: paragraph / heading / fence / list / table / blank handling", () => {
  const md = [
    "# Title", "", "Para one", "", "- a", "- b", "",
    "| h1 | h2 |", "| --- | --- |", "| v1 | v2 |", "",
    "```js", "const x = 1;", "```", "", "tail para",
  ].join("\n");
  const u = richUnits(md);
  assert.deepEqual(u.map((x) => x.type), ["heading", "paragraph", "list", "table", "fence", "paragraph"]);
  assert.equal(u[0].text, "# Title");
  assert.equal(u[1].text, "Para one");
  assert.equal(u[2].text, "- a\n- b");
  assert.equal(u[3].text, "| h1 | h2 |\n| --- | --- |\n| v1 | v2 |");
  assert.equal(u[4].text, "```js\nconst x = 1;\n```");
  assert.equal(u[5].text, "tail para");
});

test("richUnits: adjacent paragraph lines merge; blank lines separate", () => {
  const u = richUnits("l1\nl2\n\nl3");
  assert.deepEqual(u.map((x) => x.text), ["l1\nl2", "l3"]);
});

test("richUnits: unclosed fence (streaming) → single fence unit to EOF", () => {
  const u = richUnits("before\n\n```py\nprint(1)\nprint(2)");
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "fence"]);
  assert.equal(u[1].text, "```py\nprint(1)\nprint(2)");
});

test("richUnits: table needs a separator row after the header", () => {
  const u = richUnits("| a | b |\n\ntext"); // no separator → not a table (two plain paragraphs)
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "paragraph"]);
  assert.equal(u[0].text, "| a | b |");
});

test("richUnits: <details> region → one details unit", () => {
  const md = "a\n\n<details><summary>more</summary>\n\ninner text\n\n</details>\n\nb";
  const u = richUnits(md);
  assert.deepEqual(u.map((x) => x.type), ["paragraph", "details", "paragraph"]);
  assert.ok(u[1].text.startsWith("<details>"));
  assert.ok(u[1].text.endsWith("</details>"));
  assert.ok(u[1].text.includes("inner text"));
});

const fenceOf = (n: number, lang = "") =>
  [lang ? "```" + lang : "```", ...Array.from({ length: n }, (_, i) => `line${i}`), "```"].join("\n");

test("foldLongFences: short fence (≤ N lines) untouched", () => {
  const md = `intro\n\n${fenceOf(5)}\n\noutro`;
  assert.equal(foldLongFences(md, 25), md);
});

test("foldLongFences: exactly N lines → untouched; N+1 → wrapped", () => {
  assert.equal(foldLongFences(fenceOf(25), 25), fenceOf(25));
  assert.ok(foldLongFences(fenceOf(26), 25).startsWith("<details>"));
});

test("foldLongFences: wraps with summary (line count + language), fence intact inside", () => {
  const out = foldLongFences(fenceOf(30, "python"), 25);
  assert.ok(out.startsWith("<details><summary>code, python (30 lines)</summary>"), out.slice(0, 80));
  assert.ok(out.includes("```python"));
  assert.ok(out.trimEnd().endsWith("</details>"));
  assert.ok(out.includes("line0") && out.includes("line29"));
});

test("foldLongFences: no language → plain summary", () => {
  const out = foldLongFences(fenceOf(30), 25);
  assert.ok(out.startsWith("<details><summary>code (30 lines)</summary>"));
});

test("foldLongFences: multiple fences, only the long one wrapped", () => {
  const md = `${fenceOf(3)}\n\ntext\n\n${fenceOf(40, "ts")}`;
  const out = foldLongFences(md, 25);
  assert.equal((out.match(/<details>/g) ?? []).length, 1);
  assert.ok(out.includes("code, ts (40 lines)"));
});

test("foldLongFences: unclosed long fence (streaming) also wrapped", () => {
  const md = ["```js", ...Array.from({ length: 30 }, (_, i) => `x${i}`)].join("\n");
  const out = foldLongFences(md, 25);
  assert.ok(out.startsWith("<details><summary>code, js (30 lines)</summary>"));
  assert.ok(out.includes("</details>"));
});
const CAP = 200; // small cap so the tests stay readable; packing logic is cap-agnostic

test("chunkRich: small doc → one chunk, no marker", () => {
  assert.deepEqual(chunkRich("hello\n\nworld"), ["hello\n\nworld"]);
});

test("chunkRich: marker from chunk 2; all chunks ≤ cap; no unit split across chunks", () => {
  const md = ["# Head", "p1", "p2", "p3"].join("\n\n").replace(/p(\d)/g, (_m, d) => "x".repeat(70) + d);
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= CAP, `chunk ${c.length} > ${CAP}`);
  assert.ok(!chunks[0].startsWith("(continued)"));
  for (const c of chunks.slice(1)) assert.ok(c.startsWith("(continued)\n"));
  // reassembled content (minus markers, newlines normalized) equals the source
  const norm = (s: string) => s.replace(/\n+/g, "\n");
  const joined = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  assert.equal(norm(joined), norm(md));
});

test("chunkRich: oversized fence re-emitted per chunk WITH language; all lines preserved", () => {
  const body = Array.from({ length: 30 }, (_, i) => `l${i} ` + "x".repeat(10)).join("\n");
  const md = "```python\n" + body + "\n```";
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const body = c.startsWith("(continued)\n") ? c.slice("(continued)\n".length) : c;
    assert.ok(body.startsWith("```python\n"), JSON.stringify(body.slice(0, 40)));
    assert.ok(c.trimEnd().endsWith("```"));
    assert.ok(c.length <= CAP);
  }
  const all = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  for (let i = 0; i < 30; i++) assert.ok(all.includes(`l${i} `), `line ${i} lost`);
});

test("chunkRich: oversized table keeps header+separator in every piece; rows preserved", () => {
  const header = "| col-a | col-b |";
  const sep = "| --- | --- |";
  const rows = Array.from({ length: 20 }, (_, i) => `| row-${i} | ${"y".repeat(15)} |`);
  const md = [header, sep, ...rows].join("\n");
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const body = c.startsWith("(continued)\n") ? c.slice("(continued)\n".length) : c;
    assert.ok(body.startsWith(header + "\n" + sep), JSON.stringify(body.slice(0, 60)));
    assert.ok(c.length <= CAP);
  }
  const all = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n");
  for (const r of rows) assert.ok(all.includes(r), r);
});

test("chunkRich: oversized <details> unit unwrapped (summary kept as plain line, content split)", () => {
  const inner = Array.from({ length: 30 }, (_, i) => `i${i} ` + "z".repeat(8)).join("\n");
  const md = `<details><summary>code (30 lines)</summary>\n\n${inner}\n\n</details>`;
  const chunks = chunkRich(md, CAP);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= CAP);
  // hard-cut may break a line mid-character-run, so compare newline-stripped content
  const flatAll = chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join("\n").replace(/\n/g, "");
  assert.ok(!flatAll.includes("<details>"), "wrapper must be gone");
  assert.equal(flatAll, "code (30 lines)" + inner.replace(/\n/g, ""));
});

test("chunkRich: single giant paragraph → hard-cut pieces ≤ cap", () => {
  const md = "a".repeat(500);
  const chunks = chunkRich(md, CAP);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= CAP);
  assert.equal(chunks.map((c, i) => (i === 0 ? c : c.slice("(continued)\n".length))).join(""), md);
});

test("chunkRich: length is counted in JS units, not bytes", () => {
  const md = "é".repeat(31_900); // 31 900 JS units but 63 800 UTF-8 bytes
  assert.ok(Buffer.byteLength(md) > 32_768, "precondition: bytes exceed the documented limit");
  assert.equal(chunkRich(md, RICH_CAP).length, 1, "31 900 units must fit under RICH_CAP=32 000 in one chunk");
});
