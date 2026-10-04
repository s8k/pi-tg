/**
 * rich-blocks.ts — pure blocks-tier (InputRichBlock) types + converters + pipeline.
 *
 * Source of truth: live Bot API docs (core.telegram.org/bots/api) + Task 0
 * spike results (docs/plans/2026-10-03-blocks-mirroring.md, 2026-10-04):
 *  - link entity is { type: "url", text, url } (href 400s; anchor_link is for internal anchors)
 *  - table cells must be RichText entity OBJECTS (bare strings 400); is_bordered for borders
 *  - ordered lists need type: "1" (+value) per item
 *  - 500-block limit is counted top-level by the server (list items are NOT counted per-item);
 *    our blockCount counts items/rows/nesting anyway — conservative, extra-safe
 *
 * No I/O. Everything here is total: any string in, some blocks out.
 */

/** RichText: plain string | sequence | entity. Recursive, per the live docs. */
export type TgRichText =
  | string
  | TgRichText[]
  | { type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "marked" | "code"; text: TgRichText }
  | { type: "url"; text: TgRichText; url: string }
  | { type: "subscript" | "superscript"; text: TgRichText };

/** The InputRichBlock subset we emit. */
export type TgBlock =
  | { type: "paragraph"; text: TgRichText }
  | { type: "heading"; text: TgRichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "pre"; text: string; language?: string }
  | { type: "divider" }
  | { type: "list"; items: TgListItem[] }
  | { type: "blockquote"; blocks: TgBlock[] }
  | { type: "table"; cells: TgRichText[][]; is_bordered?: boolean; caption?: TgRichText }
  | { type: "details"; summary: TgRichText; blocks: TgBlock[]; is_open?: boolean }
  | { type: "thinking"; text: TgRichText }; // draft-only — never in persistent sends

export interface TgListItem {
  blocks: TgBlock[];
  has_checkbox?: boolean;
  is_checked?: boolean;
  /** Ordered lists: continuation number (with `type` set). */
  value?: number;
  /** Ordered label type: "a" | "A" | "i" | "I" | "1". */
  type?: "a" | "A" | "i" | "I" | "1";
}

/** Sum of plain-text char lengths of all string leaves (JS string units, not bytes). */
export function richTextLen(rt: TgRichText): number {
  if (typeof rt === "string") return rt.length;
  if (Array.isArray(rt)) return rt.reduce((n, x) => n + richTextLen(x), 0);
  return richTextLen(rt.text);
}

/** Exact rendered-text length of a block array (the 32768-cap budget input). */
export function blocksLen(blocks: TgBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph":
      case "heading":
      case "thinking":
        n += richTextLen(b.text);
        break;
      case "pre":
        n += b.text.length;
        break;
      case "divider":
        break;
      case "list":
        for (const it of b.items) n += blocksLen(it.blocks);
        break;
      case "blockquote":
        n += blocksLen(b.blocks);
        break;
      case "details":
        n += richTextLen(b.summary) + blocksLen(b.blocks);
        break;
      case "table":
        for (const row of b.cells) for (const cell of row) n += richTextLen(cell);
        if (b.caption) n += richTextLen(b.caption);
        break;
    }
  }
  return n;
}

/**
 * Conservative block count for the 500-block cap: every block counts 1,
 * list items count 1 each, table rows count 1 each, nested content recurses.
 * The live server counts top-level only (spike 2026-10-04) — this is extra-safe.
 */
export function blockCount(blocks: TgBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += 1;
    switch (b.type) {
      case "list":
        for (const it of b.items) n += 1 + blockCount(it.blocks);
        break;
      case "blockquote":
        n += blockCount(b.blocks);
        break;
      case "details":
        n += blockCount(b.blocks);
        break;
      case "table":
        n += b.cells.length; // one per row
        break;
      default:
        break;
    }
  }
  return n;
}
