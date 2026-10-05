import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mdToBlocks, inlineToRichText, blocksToPlainText, blocksLen, blockCount, tailBlocks, chunkBlocks } from "../src/rich-blocks.ts";
import type { TgBlock, TgRichText } from "../src/rich-blocks.ts";

/** The canonical body marker (spike 2026-10-06, forwarded msg 1516):
 *  superscript(anchor "fnref-<N>-<k>", reference_link "<N>" → "fn-<N>").
 *  md4x numbers footnotes by first-reference order — the id IS the number
 *  (the source id string is not part of the canonical shape). */
const marker = (num: number, occ = 1): TgRichText => ({
  type: "superscript",
  text: [
    { type: "anchor", name: `fnref-${num}-${occ}` },
    { type: "reference_link", text: String(num), reference_name: `fn-${num}` },
  ],
});

describe("footnotes (markdown → canonical reference entities + footer block)", () => {
  test("inline: [^id] without a definition stays literal (md4x: undefined refs are literal, GFM)", () => {
    assert.equal(inlineToRichText("Text with a reference[^id1] and another one[^id2]."),
      "Text with a reference[^id1] and another one[^id2].");
    assert.equal(inlineToRichText("see [^1]"), "see [^1]");
  });

  test("inline: a half-typed [^ and an undefined [^x] both stay literal", () => {
    assert.equal(inlineToRichText("a [^ b"), "a [^ b");
    assert.equal(inlineToRichText("a [^x] b"), "a [^x] b");
  });

  test("inline: a line-initial footnote definition is block-level — no body text", () => {
    // md4x parses `[^id]: text` as a definition (the block tier renders it in
    // the footer); a line-sized string with ONLY a definition has no body.
    assert.equal(inlineToRichText("[^id1]: Definition of the first footnote."), "");
  });

  test("inline: [^id: label] (pandoc extension) stays literal (md4x has no label syntax)", () => {
    assert.equal(inlineToRichText("a[^note: see below]"), "a[^note: see below]");
  });

  test("mdToBlocks: refs → canonical superscript markers; definitions → footer block", () => {
    const blocks = mdToBlocks("Text with a reference[^id1] and another one[^id2].\n\n[^id1]: Definition of the first footnote.\n[^id2]: Definition of the second footnote.");
    assert.equal(blocks.length, 2, "body paragraph + footer");
    const body = blocks[0] as Extract<TgBlock, { type: "paragraph" }>;
    assert.deepEqual(body.text, ["Text with a reference", marker(1), " and another one", marker(2), "."]);
    const footer = blocks[1] as Extract<TgBlock, { type: "footer" }>;
    assert.equal(footer.type, "footer");
    // the footer text is ONE rich-text array: "N. " + reference(definition) + " " + ↩ backlink, "\n"-separated
    assert.deepEqual(footer.text, [
      "1. ", { type: "reference", text: "Definition of the first footnote.", name: "fn-1" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      "\n2. ", { type: "reference", text: "Definition of the second footnote.", name: "fn-2" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-2-1" },
    ]);
  });

  test("mdToBlocks: definitions in the middle of a paragraph line are NOT footnotes (stay literal)", () => {
    const blocks = mdToBlocks("line one [^a]: not a def\nmore");
    assert.equal(blocks.length, 1);
    assert.equal((blocks[0] as Extract<TgBlock, { type: "paragraph" }>).text, "line one [^a]: not a def\nmore");
  });

  test("mdToBlocks: a half-typed definition at EOF — incomplete defs are dropped (md4x), a bare [^id stays literal", () => {
    assert.deepEqual(mdToBlocks("para\n\n[^id]:"), [{ type: "paragraph", text: "para" }]);
    // md4x only recognizes `[^id` (no colon yet) as plain text — the draft
    // shows it literally for a tick; it disappears once the definition completes
    assert.deepEqual(mdToBlocks("para\n\n[^id"), [{ type: "paragraph", text: "para" }, { type: "paragraph", text: "[^id" }]);
    assert.deepEqual(mdToBlocks("[^id]: half-typed"), []);
    // a bare "[^id]" line (no colon yet, mid-stream) is not a definition —
    // with no definition anywhere it stays literal (GFM: undefined ref)
    assert.deepEqual(mdToBlocks("[^id]"), [{ type: "paragraph", text: "[^id]" }]);
  });

  test("mdToBlocks: reference inside a list item gets the canonical marker", () => {
    const blocks = mdToBlocks("- item with a footnote[^note]\n\n[^note]: def text");
    assert.equal(blocks.length, 2);
    const list = blocks[0] as Extract<TgBlock, { type: "list" }>;
    assert.deepEqual((list.items[0].blocks[0] as Extract<TgBlock, { type: "paragraph" }>).text, ["item with a footnote", marker(1)]);
    assert.equal((blocks[1] as Extract<TgBlock, { type: "footer" }>).type, "footer");
  });

  test("mdToBlocks: multiple references to the same id — same number, per-occurrence anchors, one footer entry", () => {
    const blocks = mdToBlocks("One[^a] and two[^a] and three[^b].\n\n[^a]: shared definition.\n[^b]: other.");
    const body = blocks[0] as Extract<TgBlock, { type: "paragraph" }>;
    assert.deepEqual(body.text, ["One", marker(1, 1), " and two", marker(1, 2), " and three", marker(2), "."]);
    const footer = blocks[1] as Extract<TgBlock, { type: "footer" }>;
    assert.deepEqual(footer.text, [
      "1. ", { type: "reference", text: "shared definition.", name: "fn-1" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      "\n2. ", { type: "reference", text: "other.", name: "fn-2" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-2-1" },
    ]);
  });

  test("mdToBlocks: numbering follows FIRST REFERENCE order, not definition order; unreferenced definitions are dropped", () => {
    const blocks = mdToBlocks("See[^b] first, then[^a].\n\n[^a]: alpha def.\n[^b]: beta def.\n[^c]: never referenced.");
    const body = blocks[0] as Extract<TgBlock, { type: "paragraph" }>;
    // md4x numbers by first-reference order: [^b] is 1, [^a] is 2 — the
    // canonical names carry the NUMBER, not the source id
    assert.deepEqual(body.text, ["See", marker(1), " first, then", marker(2), "."]);
    const footer = blocks[1] as Extract<TgBlock, { type: "footer" }>;
    assert.deepEqual(footer.text, [
      "1. ", { type: "reference", text: "beta def.", name: "fn-1" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
      "\n2. ", { type: "reference", text: "alpha def.", name: "fn-2" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-2-1" },
    ]);
  });

  test("mdToBlocks: a reference with no definition stays literal (GFM) — no marker, no footer", () => {
    const blocks = mdToBlocks("Undefined[^zzz] reference.");
    assert.equal(blocks.length, 1);
    assert.equal((blocks[0] as Extract<TgBlock, { type: "paragraph" }>).text, "Undefined[^zzz] reference.");
  });

  test("mdToBlocks: multi-line definition (indented continuation) folds into one text", () => {
    const blocks = mdToBlocks("Ref[^m].\n\n[^m]: first line\n    continued line.");
    const footer = blocks[1] as Extract<TgBlock, { type: "footer" }>;
    // md4x keeps the continuation's newline (the old line-folding joined with a space)
    assert.deepEqual(footer.text, [
      "1. ", { type: "reference", text: "first line\ncontinued line.", name: "fn-1" }, " ", { type: "anchor_link", text: "↩", anchor_name: "fnref-1-1" },
    ]);
  });

  test("cost model: the footer counts like a paragraph; the marker counts its digit", () => {
    const blocks = mdToBlocks("a[^1]\n\n[^1]: twelve characters");
    // body: 1 ("a") + 1 (marker "1"); footer: "1. " (3) + 16 + " " (1) + "↩" (2 code units) = 22
    assert.equal(blocksLen(blocks), 2 + 22);
    assert.equal(blockCount(blocks), 2);
  });

  test("tailBlocks/chunkBlocks: footnotes flow through the budget views (footer is a normal block)", () => {
    const blocks = mdToBlocks("a[^1] b[^2]\n\n[^1]: d1\n[^2]: d2");
    const tail = tailBlocks(blocks, 1000, 480);
    assert.equal(tail[tail.length - 1].type, "footer", "the footer stays at the end");
    const big = mdToBlocks("word [^n1] ".repeat(2000).trim() + "\n\n[^n1]: d");
    const chunks = chunkBlocks(big, 50, 480);
    assert.ok(chunks.length > 1);
    assert.equal(chunks[chunks.length - 1][chunks[chunks.length - 1].length - 1].type, "footer", "the footer lands in the last chunk");
  });

  test("plain rung: body shows the marker number; the footer shows numbered definitions", () => {
    const blocks = mdToBlocks("See[^x].\n\n[^x]: A secret definition.");
    const plain = blocksToPlainText(blocks);
    assert.ok(plain.includes("See1."));
    assert.ok(plain.includes("1. A secret definition. ↩"), plain);
  });

  test("plain rung: an intermediate reference without a definition degrades to the literal marker", () => {
    const rt: TgBlock = { type: "paragraph", text: ["See", { type: "reference", text: "", name: "x" }, "."] };
    assert.equal(blocksToPlainText([rt]), "See[^x].");
  });
});
