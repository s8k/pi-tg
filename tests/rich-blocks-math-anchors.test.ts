import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mdToBlocks, blocksToPlainText, blocksLen, blockCount } from "../src/rich-blocks.ts";
import type { TgBlock } from "../src/rich-blocks.ts";

describe("mathematical expressions + anchors (markdown → blocks)", () => {
  test("$$…$$ display math (single line) → mathematical_expression block", () => {
    const blocks = mdToBlocks("Before\n\n$$E = mc^2$$\n\nAfter");
    assert.deepEqual(blocks, [
      { type: "paragraph", text: "Before" },
      { type: "mathematical_expression", expression: "E = mc^2" },
      { type: "paragraph", text: "After" },
    ]);
  });

  test("a line whose ONLY content is inline $$…$$ (surrounding spaces) → math block", () => {
    // The LLM writes display math as a whole line; incidental surrounding
    // whitespace must not demote it to a literal paragraph.
    assert.deepEqual(mdToBlocks("  $$E = mc^2$$  "), [{ type: "mathematical_expression", expression: "E = mc^2" }]);
    // But math EMBEDDED in a text line stays a paragraph (the blocks tier has
    // no inline math entity — only the block form).
    assert.deepEqual(mdToBlocks("Inline math: $$x^2$$ here"), [{ type: "paragraph", text: "Inline math: $$x^2$$ here" }]);
  });

  test("```math fence → mathematical_expression block (multi-line expression kept)", () => {
    const blocks = mdToBlocks("```math\n\\frac{a}{b} + c\n```");
    assert.deepEqual(blocks, [{ type: "mathematical_expression", expression: "\\frac{a}{b} + c" }]);
  });

  test("an unclosed $$ opener mid-stream: literal WITHOUT heal (final text kept verbatim), a math block WITH heal (draft)", () => {
    assert.deepEqual(mdToBlocks("para\n\n$$E = mc"), [{ type: "paragraph", text: "para" }, { type: "paragraph", text: "$$E = mc" }]);
    assert.deepEqual(mdToBlocks("$$E = mc", { heal: true }), [{ type: "mathematical_expression", expression: "E = mc" }]);
  });

  test("a closed empty math block emits nothing (empty content 400s)", () => {
    assert.deepEqual(mdToBlocks("$$\n$$"), []);
    assert.deepEqual(mdToBlocks("```math\n```"), []);
  });

  test("math inside a blockquote works (recursive)", () => {
    const blocks = mdToBlocks("> $$x^2 + y^2$$");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "blockquote");
    const inner = (blocks[0] as Extract<TgBlock, { type: "blockquote" }>).blocks;
    assert.deepEqual(inner, [{ type: "mathematical_expression", expression: "x^2 + y^2" }]);
  });

  test("plain rung: the expression degrades to its LaTeX source", () => {
    const blocks = mdToBlocks("$$E = mc^2$$");
    assert.equal(blocksToPlainText(blocks), "E = mc^2");
  });

  test("cost model: expression length counts; anchors count nothing", () => {
    const m = mdToBlocks("$$ab$$");
    assert.equal(blocksLen(m), 2);
    assert.equal(blockCount(m), 1);
    const a: TgBlock[] = [{ type: "anchor", name: "top" }];
    assert.equal(blocksLen(a), 0);
    assert.equal(blockCount(a), 1);
  });

  test("anchors: <a name=\"id\"></a> on its own line → anchor block (zero content)", () => {
    const blocks = mdToBlocks("<a name=\"chapter-1\"></a>\n\nText");
    assert.deepEqual(blocks, [
      { type: "anchor", name: "chapter-1" },
      { type: "paragraph", text: "Text" },
    ]);
  });

  test("anchor with a trailing </a> on the next line stays literal (GFM: lazy continuation of the html line)", () => {
    // md4x folds the stray </a> into the first line's paragraph (a lazy
    // continuation), so the all-html anchor pattern no longer matches — the
    // old parser's line-based consumption is gone (a mid-stream transient;
    // the next tick re-parses the corrected text)
    const blocks = mdToBlocks("<a name=\"c1\"></a>\n</a>\n\nText");
    assert.deepEqual(blocks, [
      { type: "paragraph", text: "<a name=\"c1\"></a>\n</a>" },
      { type: "paragraph", text: "Text" },
    ]);
  });

  test("anchor inside an inline line is NOT an anchor block (stays literal text)", () => {
    const blocks = mdToBlocks("see <a name=\"c1\"></a> here");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "paragraph");
  });

  test("plain rung: anchors emit nothing", () => {
    assert.equal(blocksToPlainText([{ type: "anchor", name: "x" }]), "");
  });
});
