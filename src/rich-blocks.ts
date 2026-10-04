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

/**
 * Convert ONE line of markdown to structured RichText.
 * Supports: `code`, [t](url), **bold**, __bold__, *italic*, _italic_, ~~strike~~,
 * ==marked==, ||spoiler||.
 * Guarantees: balanced output (unmatched markers stay literal), code-span content
 * verbatim (no formatting parsed inside), links' text parsed recursively.
 */
export function inlineToRichText(src: string): TgRichText {
  // 1) code spans — stashed, verbatim, no formatting inside
  const codeStash: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeStash.push(code);
    return `\u0001${codeStash.length - 1}\u0001`;
  });
  // 2) links — stashed; URL untouched by later passes, text parsed recursively at the end
  const linkStash: { text: string; url: string }[] = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, text: string, url: string) => {
    linkStash.push({ text, url });
    return `\u0002${linkStash.length - 1}\u0002`;
  });
  // 3) emphasis — same regexes and pass order as the legacy inlineToHtml,
  //    wrapping matches in open/close tags (tags contain no markers → no interference)
  const open = (t: string) => `\u0004${t}\u0004`;
  const close = (t: string) => `\u0005${t}\u0005`;
  s = s.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, (_m, c: string) => open("B") + c + close("B"));
  s = s.replace(/(^|[^_\w])__((?:[^_]|\_(?!_))+?)__(?![\w_])/g, (_m, pre: string, c: string) => pre + open("B") + c + close("B"));
  s = s.replace(/~~(.+?)~~/g, (_m, c: string) => open("S") + c + close("S"));
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, c: string) => pre + open("I") + c + close("I"));
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, (_m, pre: string, c: string) => pre + open("I") + c + close("I"));
  s = s.replace(/==(.+?)==/g, (_m, c: string) => open("M") + c + close("M"));
  s = s.replace(/\|\|(.+?)\|\|/g, (_m, c: string) => open("P") + c + close("P"));
  // 4) tag string → tree (stashes resolved here)
  const out = parseTagged(s, codeStash, linkStash);
  if (out.length === 0) return "";
  if (out.length === 1) return out[0];
  return out;
}

const EMPH_TYPE: Record<string, "bold" | "italic" | "strikethrough" | "marked" | "spoiler"> = {
  B: "bold", I: "italic", S: "strikethrough", M: "marked", P: "spoiler",
};

/** Parse the tagged string into RichText nodes (recursive on emphasis tags). */
function parseTagged(s: string, codeStash: string[], linkStash: { text: string; url: string }[]): TgRichText[] {
  const out: TgRichText[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") { out.push(buf); buf = ""; }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === "\u0001" || ch === "\u0002") {
      const end = s.indexOf(ch, i + 1);
      const idx = Number(s.slice(i + 1, end));
      flush();
      if (ch === "\u0001") out.push({ type: "code", text: codeStash[idx] });
      else {
        const l = linkStash[idx];
        out.push({ type: "url", text: inlineToRichText(l.text), url: l.url });
      }
      i = end + 1;
      continue;
    }
    if (ch === "\u0004" && s.charAt(i + 2) === "\u0004") {
      const t = s.charAt(i + 1);
      const closeTag = `\u0005${t}\u0005`;
      const end = s.indexOf(closeTag, i + 3);
      flush();
      const inner = parseTagged(s.slice(i + 3, end), codeStash, linkStash);
      out.push({ type: EMPH_TYPE[t], text: inner.length === 1 ? inner[0] : inner });
      i = end + closeTag.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
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
