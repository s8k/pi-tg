import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { blocksLen, blockCount, richTextLen } from "../src/rich-blocks.ts";
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
