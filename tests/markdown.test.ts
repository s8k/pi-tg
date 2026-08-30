import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, chunkText, escapeAttr, escapeHtml, inlineToHtml, markdownToHtml, toPlainText } from "../src/markdown.ts";

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
