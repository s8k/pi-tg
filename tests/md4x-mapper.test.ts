// The md4x AST→TgBlock mapper (src/md4x-mapper.ts) — T3/T4/T5/T6 of the
// migration plan (docs/plans/2026-10-07-md4x-parser-migration.md).
//
// These tests pin the NEW implementation in isolation (V2 exports). At T7 the
// public exports in rich-blocks.ts flip to these, and the original ~130
// converter tests become the full gate. Intended behavioral diffs from the
// old parser are asserted HERE with comments citing plan §3.1/§4.4.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inlineToRichTextV2, mapBlocks, mapInline, mdToBlocksV2, parseComark } from "../src/md4x-mapper.ts";
import type { TgBlock, TgRichText } from "../src/rich-blocks.ts";

const B = (t: TgRichText): TgRichText => ({ type: "bold", text: t });
const I = (t: TgRichText): TgRichText => ({ type: "italic", text: t });
const S = (t: TgRichText): TgRichText => ({ type: "strikethrough", text: t });
const M = (t: TgRichText): TgRichText => ({ type: "marked", text: t });
const C = (t: TgRichText): TgRichText => ({ type: "code", text: t });
const U = (t: TgRichText, url: string): TgRichText => ({ type: "url", text: t, url });
const P = (t: TgRichText): TgBlock => ({ type: "paragraph", text: t });

const paraText = (bs: TgBlock[]): TgRichText => {
  const p = bs[0];
  if (!p || p.type !== "paragraph") throw new Error(`expected paragraph, got ${JSON.stringify(p)}`);
  return p.text;
};

describe("mapInline (T3)", () => {
  test("plain text → string", () => {
    assert.deepEqual(inlineToRichTextV2("hello world"), "hello world");
  });
  test("all emphasis kinds", () => {
    assert.deepEqual(inlineToRichTextV2("**b**"), B("b"));
    assert.deepEqual(inlineToRichTextV2("__b__"), B("b"));
    assert.deepEqual(inlineToRichTextV2("*i*"), I("i"));
    assert.deepEqual(inlineToRichTextV2("_i_"), I("i"));
    assert.deepEqual(inlineToRichTextV2("~~s~~"), S("s"));
    assert.deepEqual(inlineToRichTextV2("==m=="), M("m"));
    assert.deepEqual(inlineToRichTextV2("`c`"), C("c"));
  });
  test("nested emphasis", () => {
    assert.deepEqual(inlineToRichTextV2("**a *b* c**"), B(["a ", I("b"), " c"]));
    assert.deepEqual(inlineToRichTextV2("*a **b** c*"), I(["a ", B("b"), " c"]));
  });
  test("intraword underscores stay literal", () => {
    assert.deepEqual(inlineToRichTextV2("snake_case_name"), "snake_case_name");
  });
  test("code span content verbatim (no emphasis inside)", () => {
    assert.deepEqual(inlineToRichTextV2("`a * b`"), C("a * b"));
  });
  test("link + autolink (3.1 #2: bare URLs now link)", () => {
    assert.deepEqual(inlineToRichTextV2("[t](https://x.y)"), U("t", "https://x.y"));
    assert.deepEqual(inlineToRichTextV2("see https://a.b now"), ["see ", U("https://a.b", "https://a.b"), " now"]);
  });
  test("empty href stays literal (no url entity with empty url)", () => {
    assert.deepEqual(inlineToRichTextV2("a [t]() b"), "a [t]() b");
  });
  test("inline math $x$ → literal $x$ (no inline-math entity; §4.4 #2)", () => {
    assert.deepEqual(inlineToRichTextV2("cost is $x^2$ today"), "cost is $x^2$ today");
  });
  test("image → literal ![alt](src) (no image block in TgBlock)", () => {
    assert.deepEqual(inlineToRichTextV2("a ![alt](u) b"), "a ![alt](u) b");
  });
  test("||spoiler|| → literal (3.1 #1: dropped — md4x has no such syntax)", () => {
    assert.deepEqual(inlineToRichTextV2("||x||"), "||x||");
  });
  test("hard break (two trailing spaces) → \\n in text", () => {
    assert.deepEqual(inlineToRichTextV2("one  \ntwo"), "one\ntwo");
  });
  test("soft break → \\n in text", () => {
    assert.deepEqual(inlineToRichTextV2("one\ntwo"), "one\ntwo");
  });
  test("backslash EOL → \\n (md4x quirk workaround, §4.4 #1)", () => {
    assert.deepEqual(inlineToRichTextV2("one\\\ntwo"), "one\ntwo");
  });
  test("inline html → raw text as-is (entity data is raw)", () => {
    assert.deepEqual(inlineToRichTextV2("a <b> b"), "a <b> b");
  });
  test("HTML entities resolved by md4x", () => {
    assert.deepEqual(inlineToRichTextV2("A &amp; B"), "A & B");
  });
  test("unmatched markers stay literal (no heal)", () => {
    assert.deepEqual(inlineToRichTextV2("*unterminated"), "*unterminated");
    assert.deepEqual(inlineToRichTextV2("**no close"), "**no close");
  });
  test("pathological cross-boundary emphasis terminates, content preserved", () => {
    const out = inlineToRichTextV2("**a * b** * c * d**");
    const json = JSON.stringify(out);
    assert.ok(!json.includes("\u0004") && !json.includes("\u0005"));
    const flat = (rt: TgRichText): string =>
      typeof rt === "string" ? rt : Array.isArray(rt) ? rt.map(flat).join("") : rt.type === "anchor" ? "" : flat(rt.text);
    assert.ok(flat(out).includes("c") && flat(out).includes("d"));
  });
});

describe("mapBlocks (T4)", () => {
  test("headings h1–h6 → heading{size}", () => {
    const bs = mdToBlocksV2("# H1\n## H2\n###### H6");
    assert.deepEqual(bs, [
      { type: "heading", text: "H1", size: 1 },
      { type: "heading", text: "H2", size: 2 },
      { type: "heading", text: "H6", size: 6 },
    ]);
  });
  test("setext headings (3.1 #3: CommonMark-correct, new behavior)", () => {
    const bs = mdToBlocksV2("title\n===\nsub\n---");
    assert.deepEqual(bs, [
      { type: "heading", text: "title", size: 1 },
      { type: "heading", text: "sub", size: 2 },
    ]);
  });
  test("empty heading (half-typed '## ') emits nothing (empty content 400s)", () => {
    assert.deepEqual(mdToBlocksV2("## "), []);
  });
  test("fenced pre strips md4x's trailing newline; language kept", () => {
    const bs = mdToBlocksV2("```js\nlet x = 1;\n```");
    assert.deepEqual(bs, [{ type: "pre", text: "let x = 1;", language: "js" }]);
  });
  test("empty fence emits nothing (empty content 400s)", () => {
    assert.deepEqual(mdToBlocksV2("```\n```"), []);
    assert.deepEqual(mdToBlocksV2("```"), []);
  });
  test("hr → divider", () => {
    assert.deepEqual(mdToBlocksV2("---"), [{ type: "divider" }]);
  });
  test("blockquote with content; empty blockquote emits nothing", () => {
    assert.deepEqual(mdToBlocksV2("> **q**"), [{ type: "blockquote", blocks: [P(B("q"))] }]);
    assert.deepEqual(mdToBlocksV2(">"), []);
  });
  test("frontmatter is suppressed (§4.4 #5)", () => {
    assert.deepEqual(mdToBlocksV2("---\ntitle: Hello\n---\nbody"), [P("body")]);
  });
  test("HTML comment stripped (3.1 #7) — surrounding spaces stay", () => {
    assert.deepEqual(mdToBlocksV2("a <!-- c --> b"), [P("a  b")]);
  });
  test("unknown node fails soft to its text", () => {
    const nodes = parseComark("hi").nodes;
    nodes.push(["totally-unknown-node", {}, "surprise"]);
    const ctx = { fnOcc: new Map<number, number>(), details: () => undefined };
    assert.deepEqual(mapBlocks(nodes, ctx), [P("hi"), P("surprise")]);
  });
});

describe("lists (T4)", () => {
  test("unordered + nested", () => {
    const bs = mdToBlocksV2("- a\n  - b\n- c");
    assert.deepEqual(bs, [{
      type: "list",
      items: [
        { blocks: [P("a"), { type: "list", items: [{ blocks: [P("b")] }] }] },
        { blocks: [P("c")] },
      ],
    }]);
  });
  test("ordered: values from start, type '1'", () => {
    const bs = mdToBlocksV2("5. five\n6. six");
    assert.deepEqual(bs, [{
      type: "list",
      items: [
        { blocks: [P("five")], type: "1", value: 5 },
        { blocks: [P("six")], type: "1", value: 6 },
      ],
    }]);
  });
  test("task list → has_checkbox/is_checked", () => {
    const bs = mdToBlocksV2("- [x] done\n- [ ] todo");
    assert.deepEqual(bs, [{
      type: "list",
      items: [
        { blocks: [P("done")], has_checkbox: true, is_checked: true },
        { blocks: [P("todo")], has_checkbox: true, is_checked: false },
      ],
    }]);
  });
  test("empty item (half-typed '-') is skipped (empty content 400s)", () => {
    const bs = mdToBlocksV2("- \n- real");
    assert.deepEqual(bs, [{ type: "list", items: [{ blocks: [P("real")] }] }]);
  });
});

describe("tables (T4)", () => {
  test("header bold+is_header, body code, mixed wrapped, empty → space (§4.4 refined cell rule)", () => {
    const bs = mdToBlocksV2("| A | **B** |\n| --- | --- |\n| | x **y** |");
    assert.deepEqual(bs, [{
      type: "table",
      is_bordered: true,
      cells: [
        [{ type: "bold", text: "A", is_header: true }, { type: "bold", text: "B", is_header: true }],
        [{ type: "code", text: " " }, { type: "code", text: ["x ", B("y")] }],
      ],
    }]);
  });
});

describe("footnotes → canonical shape (T5)", () => {
  const FN = (n: number, k: number): TgRichText => ({
    type: "superscript",
    text: [
      { type: "anchor", name: `fnref-${n}-${k}` },
      { type: "reference_link", text: String(n), reference_name: `fn-${n}` },
    ],
  });
  test("single ref + def → superscript marker + footer", () => {
    const bs = mdToBlocksV2("word [^1] end\n\n[^1]: the definition");
    assert.deepEqual(bs, [
      P(["word ", FN(1, 1), " end"]),
      { type: "footer", text: [
        "1. ", { type: "reference", text: "the definition", name: "fn-1" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      ] },
    ]);
  });
  test("two refs one def: refId 1,2; single footer entry; backlink → first ref (§4.4 #7)", () => {
    const bs = mdToBlocksV2("[^9] mid [^9]\n\n[^9]: def nine");
    assert.deepEqual(bs, [
      P([FN(1, 1), " mid ", FN(1, 2)]),
      { type: "footer", text: [
        "1. ", { type: "reference", text: "def nine", name: "fn-1" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      ] },
    ]);
  });
  test("multiple defs → numbered entries, '\\n' merged into next prefix (msg 1516)", () => {
    const bs = mdToBlocksV2("[^a] [^b]\n\n[^a]: first\n[^b]: second");
    assert.deepEqual(bs, [
      P([FN(1, 1), " ", FN(2, 1)]),
      { type: "footer", text: [
        "1. ", { type: "reference", text: "first", name: "fn-1" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
        "\n2. ", { type: "reference", text: "second", name: "fn-2" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-2-1" },
      ] },
    ]);
  });
  test("undefined ref → literal, no footer", () => {
    assert.deepEqual(mdToBlocksV2("a [^nope] b"), [P("a [^nope] b")]);
  });
  test("unreferenced def → dropped entirely (no footer, no marker)", () => {
    assert.deepEqual(mdToBlocksV2("plain text\n\n[^1]: never referenced"), [P("plain text")]);
  });
  test("dup def for one id: first wins (§4.4 #7 / 3.1 #8)", () => {
    const bs = mdToBlocksV2("[^1]\n\n[^1]: first\n[^1]: second");
    assert.deepEqual(bs, [
      P(FN(1, 1)),
      { type: "footer", text: [
        "1. ", { type: "reference", text: "first", name: "fn-1" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      ] },
    ]);
  });
  test("def with inline markdown → parsed entities in the reference", () => {
    const bs = mdToBlocksV2("[^1]\n\n[^1]: see **this** and `that`");
    assert.deepEqual(bs, [
      P(FN(1, 1)),
      { type: "footer", text: [
        "1. ", { type: "reference", text: ["see ", B("this"), " and ", C("that")], name: "fn-1" }, " ",
        { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      ] },
    ]);
  });
  test("refs inside table cells are converted too (own occurrence counter — md4x double-counts table refs, refId 2 for the first visible ref)", () => {
    const bs = mdToBlocksV2("| a |\n| --- |\n| b [^1] |\n\n[^1]: def");
    const t = bs[0];
    assert.equal(t?.type, "table");
    if (t?.type !== "table") return;
    // body cell: mixed (string + superscript) → wrapped in code
    assert.deepEqual(t.cells[1]![0], { type: "code", text: ["b ", FN(1, 1)] });
  });
  test("partial def mid-stream ('[^1]:' no text) emits nothing", () => {
    assert.deepEqual(mdToBlocksV2("text\n\n[^1]:"), [P("text")]);
  });
});

describe("math + anchors + details (T6)", () => {
  test("$$..$$ whole line → mathematical_expression", () => {
    assert.deepEqual(mdToBlocksV2("$$E=mc^2$$"), [{ type: "mathematical_expression", expression: "E=mc^2" }]);
  });
  test("$$ opener line → multi-line expression", () => {
    assert.deepEqual(mdToBlocksV2("$$\na + b\n$$"), [{ type: "mathematical_expression", expression: "a + b" }]);
  });
  test("```math fence → mathematical_expression (§4.4 #3: it's pre{language:math} in the AST)", () => {
    assert.deepEqual(mdToBlocksV2("```math\nE=mc^2\n```"), [{ type: "mathematical_expression", expression: "E=mc^2" }]);
  });
  test("empty math emits nothing (empty content 400s)", () => {
    assert.deepEqual(mdToBlocksV2("$$\n$$"), []);
  });
  test("<a name='id'></a> on own line → anchor block", () => {
    assert.deepEqual(mdToBlocksV2('<a name="my-anchor"></a>'), [{ type: "anchor", name: "my-anchor" }]);
  });
  test("anchor at the start of a paragraph (no blank line after — common LLM output) splits", () => {
    // md4x folds the following line into the same p (lazy continuation); the
    // old line parser saw the anchor on its own line. Split at the anchor
    // pair: paragraph-before / anchor / paragraph-after, edges trimmed.
    assert.deepEqual(mdToBlocksV2('<a name="x"></a>\nText after'), [
      { type: "anchor", name: "x" },
      { type: "paragraph", text: "Text after" },
    ]);
    assert.deepEqual(mdToBlocksV2('Intro\n<a name="y"></a>\nMore'), [
      { type: "paragraph", text: "Intro" },
      { type: "anchor", name: "y" },
      { type: "paragraph", text: "More" },
    ]);
  });
  test("anchor in a paragraph keeps its following text tight (blank line still separates)", () => {
    assert.deepEqual(mdToBlocksV2('<a name="z"></a>\n\nSeparate'), [
      { type: "anchor", name: "z" },
      { type: "paragraph", text: "Separate" },
    ]);
  });
  test("details: summary stripped from first line, body blocks, closed", () => {
    const bs = mdToBlocksV2("<details>\n<summary>Why?</summary>\nbody **here**\n</details>");
    assert.deepEqual(bs, [{
      type: "details",
      summary: "Why?",
      blocks: [P(["body ", B("here")])],
    }]);
  });
  test("details: no <summary> tag → first line IS the summary", () => {
    const bs = mdToBlocksV2("<details>\nWhy raw\nbody\n</details>");
    assert.deepEqual(bs, [{ type: "details", summary: "Why raw", blocks: [P("body")] }]);
  });
  test("details: unclosed → is_open: true", () => {
    const bs = mdToBlocksV2("<details>\n<summary>W?</summary>\nbody");
    assert.deepEqual(bs, [{ type: "details", summary: "W?", blocks: [P("body")], is_open: true }]);
  });
  test("details: body with blank lines (md4x splits it across nodes)", () => {
    const bs = mdToBlocksV2("<details>\n<summary>S</summary>\n\npara 1\n\npara 2\n</details>");
    assert.deepEqual(bs, [{
      type: "details",
      summary: "S",
      blocks: [P("para 1"), P("para 2")],
    }]);
  });
});

describe("heal (drafts only)", () => {
  test("half-typed ** → bold WITH heal; literal WITHOUT", () => {
    assert.deepEqual(inlineToRichTextV2("bold **unfin"), "bold **unfin");
    const blocks = mdToBlocksV2("bold **unfin", { heal: true });
    assert.deepEqual(blocks, [P(["bold ", B("unfin")])]);
  });
  test("half-typed inline $$ stays literal (no inline-math entity); a complete $$…$$ line is the math block", () => {
    // Embedded math-display (heal closed the half-typed marker mid-sentence)
    // keeps its source — matches the old parser's literal behavior.
    assert.deepEqual(mdToBlocksV2("math $$E=m"), [P("math $$E=m")]);
    assert.deepEqual(mdToBlocksV2("math $$E=m", { heal: true }), [P("math $$E=m$$")]);
    assert.deepEqual(mdToBlocksV2("$$E=m$$", { heal: true }), [{ type: "mathematical_expression", expression: "E=m" }]);
  });
  test("unclosed fence → pre both ways (CommonMark EOD — §4.4 #6)", () => {
    assert.deepEqual(mdToBlocksV2("```js\nlet x = 1;"), [{ type: "pre", text: "let x = 1;", language: "js" }]);
    assert.deepEqual(mdToBlocksV2("```js\nlet x = 1;", { heal: true }), [{ type: "pre", text: "let x = 1;", language: "js" }]);
  });
});
