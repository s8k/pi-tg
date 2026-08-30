import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { escapeAttr, escapeHtml, inlineToHtml, markdownToHtml } from "../src/markdown.ts";

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
