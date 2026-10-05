import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mdToBlocks, inlineToRichText, blocksToPlainText, tailBlocks, chunkBlocks } from "../src/rich-blocks.ts";
import type { TgBlock } from "../src/rich-blocks.ts";

const paraText = (b: TgBlock): string =>
  b.type === "paragraph" ? JSON.stringify(b.text) : `!<${b.type}>!`;

describe("footnotes (markdown → RichTextReference + message-level definitions)", () => {
  test("inline: [^id] → reference entity; [^1] numeric too", () => {
    assert.deepEqual(inlineToRichText("Text with a reference[^id1] and another one[^id2]."),
      ["Text with a reference", { type: "reference", text: "", name: "id1" }, " and another one", { type: "reference", text: "", name: "id2" }, "."]);
    assert.deepEqual(inlineToRichText("see [^1]"), ["see ", { type: "reference", text: "", name: "1" }]);
  });

  test("inline: a half-typed [^ stays literal; [^x] is a reference even mid-stream (the marker IS the entity)", () => {
    assert.equal(inlineToRichText("a [^ b"), "a [^ b");
    // "[^x]" without its definition is still a valid reference — the client
    // renders the marker; the definition text simply never existed.
    assert.deepEqual(inlineToRichText("a [^x] b"), ["a ", { type: "reference", text: "", name: "x" }, " b"]);
  });

  test("inline: footnote definition syntax NEVER becomes an entity mid-paragraph", () => {
    const rt = inlineToRichText("[^id1]: Definition of the first footnote.");
    assert.equal(JSON.stringify(rt), JSON.stringify("[^id1]: Definition of the first footnote."));
  });

  test("inline: reference with explicit label text", () => {
    assert.deepEqual(inlineToRichText("a[^note: see below]"),
      ["a", { type: "reference", text: "see below", name: "note" }]);
  });

  test("mdToBlocks: definitions at the start of a line are stripped; refs become entities", () => {
    const blocks = mdToBlocks("Text with a reference[^id1] and another one[^id2].\n\n[^id1]: Definition of the first footnote.\n[^id2]: Definition of the second footnote.");
    assert.equal(blocks.length, 1, "definitions are not separate blocks");
    const b = blocks[0];
    assert.equal(b.type, "paragraph");
    assert.deepEqual(b.text, ["Text with a reference", { type: "reference", text: "", name: "id1" }, " and another one", { type: "reference", text: "", name: "id2" }, "."]);
  });

  test("mdToBlocks: definitions in the middle of a paragraph line are NOT footnotes (stay literal)", () => {
    const blocks = mdToBlocks("line one [^a]: not a def\nmore");
    assert.equal(blocks.length, 1);
    assert.equal(paraText(blocks[0]), JSON.stringify("line one [^a]: not a def\nmore"));
  });

  test("mdToBlocks: definition text is never rendered (no definition block exists in the blocks tier)", () => {
    const blocks = mdToBlocks("See[^x].\n\n[^x]: A secret definition.");
    const plain = blocksToPlainText(blocks);
    assert.ok(plain.includes("See"));
    assert.ok(!plain.includes("secret definition"), `definition text must not leak: ${plain}`);
  });

  test("mdToBlocks: an unclosed/half-typed definition at EOF emits nothing (no empty blocks, no leak)", () => {
    assert.deepEqual(mdToBlocks("para\n\n[^id]:"), [{ type: "paragraph", text: "para" }]);
    assert.deepEqual(mdToBlocks("para\n\n[^id"), [{ type: "paragraph", text: "para" }]);
    assert.deepEqual(mdToBlocks("[^id]: half-typed"), []);
    // NOTE: a bare "[^id]" line (no colon yet, mid-stream) is not a definition
    // — it renders as a paragraph with a reference entity (the marker IS the
    // entity; the client draws it). Only the DEFINITION line is stripped.
    // a single-entity RichText collapses to the entity itself (inlineToRichText contract)
    assert.deepEqual(mdToBlocks("[^id]"), [{ type: "paragraph", text: { type: "reference", text: "", name: "id" } }]);
  });

  test("mdToBlocks: reference inside a list item", () => {
    const blocks = mdToBlocks("- item with a footnote[^note]\n\n[^note]: def text");
    assert.equal(blocks.length, 1);
    const list = blocks[0] as Extract<TgBlock, { type: "list" }>;
    assert.deepEqual((list.items[0].blocks[0] as Extract<TgBlock, { type: "paragraph" }>).text, ["item with a footnote", { type: "reference", text: "", name: "note" }]);
  });

  test("tailBlocks: footnotes do not break the budget view (refs count as zero, defs are gone)", () => {
    const blocks = mdToBlocks("a[^1] b[^2]\n\n[^1]: d1\n[^2]: d2");
    const tail = tailBlocks(blocks, 100, 480);
    assert.ok(blocksToPlainText(tail).includes("a b"));
  });

  test("chunkBlocks: a footnote-heavy paragraph still chunks (refs carry no cost)", () => {
    const blocks = mdToBlocks("word [^n1] ".repeat(2000).trim());
    const chunks = chunkBlocks(blocks, 50, 480);
    assert.ok(chunks.length > 1);
  });

  test("plain rung: a reference degrades to nothing (the marker text was the definition syntax)", () => {
    const rt: TgBlock = { type: "paragraph", text: ["See", { type: "reference", text: "", name: "x" }, "."] };
    assert.equal(blocksToPlainText([rt]), "See.");
  });
});
