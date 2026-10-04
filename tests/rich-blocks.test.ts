import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { blocksLen, blockCount, inlineToRichText, richTextLen } from "../src/rich-blocks.ts";
import type { TgBlock, TgRichText } from "../src/rich-blocks.ts";

describe("richTextLen", () => {
  test("bare string: char length", () => {
    assert.equal(richTextLen("hello"), 5);
    assert.equal(richTextLen(""), 0);
  });
  test("sequence: sum of leaves", () => {
    assert.equal(richTextLen(["ab", "cd"]), 4);
    assert.equal(richTextLen([]), 0);
  });
  test("entity: length of inner text", () => {
    assert.equal(richTextLen({ type: "bold", text: "hi" }), 2);
    assert.equal(richTextLen({ type: "url", text: "t", url: "https://x.y" }), 1); // href not counted
  });
  test("deep nesting: recursive", () => {
    const rt: TgRichText = { type: "bold", text: ["a", { type: "italic", text: "bc" }] };
    assert.equal(richTextLen(rt), 3);
  });
  test("multibyte: JS string units (not bytes)", () => {
    assert.equal(richTextLen("абв"), 3);
    assert.equal(richTextLen("😀😀"), 4); // emoji = surrogate pair = 2 units each
  });
});

describe("blocksLen", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("paragraph: text length", () => {
    assert.equal(blocksLen([P("hello")]), 5);
  });
  test("heading: text length", () => {
    assert.equal(blocksLen([{ type: "heading", text: "abc", size: 2 }]), 3);
  });
  test("pre: string length", () => {
    assert.equal(blocksLen([{ type: "pre", text: "a\nb", language: "js" }]), 3);
  });
  test("divider: zero", () => {
    assert.equal(blocksLen([{ type: "divider" }]), 0);
  });
  test("list: sum of item blocks", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [P("ab")] },
        { blocks: [P("c"), P("de")] },
      ] },
    ];
    assert.equal(blocksLen(b), 5);
  });
  test("blockquote: inner blocks", () => {
    const b: TgBlock[] = [{ type: "blockquote", blocks: [P("abc")] }];
    assert.equal(blocksLen(b), 3);
  });
  test("details: summary + inner", () => {
    const b: TgBlock[] = [
      { type: "details", summary: "sum", blocks: [P("abc"), { type: "pre", text: "xy" }] },
    ];
    assert.equal(blocksLen(b), 3 + 3 + 2);
  });
  test("table: all cells", () => {
    const b: TgBlock[] = [
      {
        type: "table", is_bordered: true,
        cells: [
          [{ type: "bold", text: "h1" }, "h2"],
          ["a", { type: "italic", text: "bc" }],
        ],
      },
    ];
    assert.equal(blocksLen(b), 2 + 2 + 1 + 2);
  });
  test("thinking: text length", () => {
    assert.equal(blocksLen([{ type: "thinking", text: "Working…" }]), 8);
  });
  test("mixed array: additive", () => {
    assert.equal(blocksLen([P("ab"), { type: "divider" }, P("c")]), 3);
  });
});

describe("blockCount", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("top-level blocks count 1 each", () => {
    assert.equal(blockCount([P("a"), { type: "divider" }, P("c")]), 3);
  });
  test("list: block + one per item + item nesting", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [P("x")] },
        { blocks: [P("y"), P("z")] },
      ] },
    ];
    // 1 (list) + 2 (items) + 3 (item inner blocks)
    assert.equal(blockCount(b), 6);
  });
  test("blockquote: block + inner blocks", () => {
    const b: TgBlock[] = [{ type: "blockquote", blocks: [P("a"), P("b")] }];
    assert.equal(blockCount(b), 3);
  });
  test("details: block + inner blocks (docs: details content is counted)", () => {
    const b: TgBlock[] = [{ type: "details", summary: "s", blocks: [P("a")] }];
    assert.equal(blockCount(b), 2);
  });
  test("table: block + one per row", () => {
    const b: TgBlock[] = [{ type: "table", cells: [["a"], ["b"], ["c"]] }];
    assert.equal(blockCount(b), 4);
  });
  test("nested: details inside list item", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [{ type: "details", summary: "s", blocks: [P("x")] }] },
      ] },
    ];
    // 1 (list) + 1 (item) + 1 (details) + 1 (paragraph)
    assert.equal(blockCount(b), 4);
  });
});

const B = (t: TgRichText): TgRichText => ({ type: "bold", text: t });
const I = (t: TgRichText): TgRichText => ({ type: "italic", text: t });
const S = (t: TgRichText): TgRichText => ({ type: "strikethrough", text: t });
const M = (t: TgRichText): TgRichText => ({ type: "marked", text: t });
const SP = (t: TgRichText): TgRichText => ({ type: "spoiler", text: t });
const C = (t: TgRichText): TgRichText => ({ type: "code", text: t });
const U = (t: TgRichText, url: string): TgRichText => ({ type: "url", text: t, url });

describe("inlineToRichText", () => {
  test("plain string: bare string", () => {
    assert.deepEqual(inlineToRichText("hello"), "hello");
  });
  test("code span: content verbatim, no formatting inside", () => {
    assert.deepEqual(inlineToRichText("`a<b> & **x**`"), C("a<b> & **x**"));
    assert.deepEqual(inlineToRichText("x `a` y"), ["x ", C("a"), " y"]);
  });
  test("bold ** and __", () => {
    assert.deepEqual(inlineToRichText("**hi**"), B("hi"));
    assert.deepEqual(inlineToRichText("__hi__"), B("hi"));
  });
  test("italic * and _", () => {
    assert.deepEqual(inlineToRichText("*hi*"), I("hi"));
    assert.deepEqual(inlineToRichText("_hi_"), I("hi"));
  });
  test("strikethrough ~~", () => {
    assert.deepEqual(inlineToRichText("~~old~~"), S("old"));
  });
  test("==marked== and ||spoiler||", () => {
    assert.deepEqual(inlineToRichText("==new=="), M("new"));
    assert.deepEqual(inlineToRichText("||secret||"), SP("secret"));
  });
  test("link: [t](url) → {type:url, text, url}; text parsed recursively", () => {
    assert.deepEqual(inlineToRichText("[t](http://x/?a=1&b=2)"), U("t", "http://x/?a=1&b=2"));
    assert.deepEqual(inlineToRichText("[**b**](u)"), U(B("b"), "u"));
  });
  test("nested emphasis, both directions", () => {
    assert.deepEqual(inlineToRichText("**bold *ital* bold**"), B(["bold ", I("ital"), " bold"]));
    assert.deepEqual(inlineToRichText("*ital **bold** ital*"), I(["ital ", B("bold"), " ital"]));
  });
  test("intraword underscores stay literal (identifiers)", () => {
    assert.deepEqual(inlineToRichText("snake_case_name"), "snake_case_name");
    assert.deepEqual(inlineToRichText("foo__bar__"), "foo__bar__");
  });
  test("unmatched markers stay literal", () => {
    assert.deepEqual(inlineToRichText("*unterminated"), "*unterminated");
    assert.deepEqual(inlineToRichText("**no close"), "**no close");
  });
  test("samples: no entity ever left unbalanced (every open has a close by construction)", () => {
    const samples = ["a * b ** c ` d", "**bold *x", "100% * 2 ~ 3 _ v1.2_", "[broken](", "`unclosed", "==x", "||y"];
    const check = (rt: TgRichText): void => {
      if (typeof rt === "string") return;
      if (Array.isArray(rt)) { rt.forEach(check); return; }
      check(rt.text);
    };
    for (const s of samples) {
      const out = inlineToRichText(s);
      check(out); // never throws; structure always well-formed
      // and rendered text length <= source (nothing added)
      assert.ok(richTextLen(out) <= s.length, s);
    }
  });
  test("& < > are plain text, never structure", () => {
    assert.deepEqual(inlineToRichText("a < b & c > d"), "a < b & c > d");
  });
  test("code span with unmatched emphasis inside stays verbatim", () => {
    assert.deepEqual(inlineToRichText("`a * b`"), C("a * b"));
  });
  test("adjacent constructs sequence", () => {
    assert.deepEqual(inlineToRichText("**b** *i* `c`"), [B("b"), " ", I("i"), " ", C("c")]);
  });
});
