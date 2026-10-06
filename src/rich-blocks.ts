/**
 * rich-blocks.ts — pure blocks-tier (InputRichBlock) types + converters + pipeline.
 *
 * Source of truth: live Bot API docs (core.telegram.org/bots/api) + Task 0
 * spike results (docs/plans/2026-10-03-blocks-mirroring.md, 2026-10-04):
 *  - link entity is { type: "url", text, url } (href 400s; anchor_link is for internal anchors)
 *  - table cells must be RichText entity OBJECTS (bare strings 400); is_bordered for borders;
 *    header cells add is_header: true (live-verified 2026-10-05: distinct header background)
 *  - ordered lists need type: "1" (+value) per item
 *  - 500-block limit is counted top-level by the server (list items are NOT counted per-item);
 *    our blockCount counts items/rows/nesting anyway — conservative, extra-safe
 *
 * No I/O. Everything here is total: any string in, some blocks out.
 */

import { inlineToRichTextV2, mdToBlocksV2 } from "./md4x-mapper.ts";
import { RICH_CAP } from "./markdown.ts";

/** RichText: plain string | sequence | entity. Recursive, per the live docs. */
export type TgRichText =
  | string
  | TgRichText[]
  | { type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "marked" | "code"; text: TgRichText }
  | { type: "url"; text: TgRichText; url: string }
  | { type: "subscript" | "superscript"; text: TgRichText }
  /** An inline anchor (inside a rich-text sequence — the blocks tier has no
   *    inline anchor, so it only occurs nested, e.g. in footnote markers).
   *    Zero rendered text. */
  | { type: "anchor"; name: string }
  /** A footnote reference (markdown `[^id]`) — INTERMEDIATE form emitted by
   *    inlineToRichText; mdToBlocks rewrites it into the canonical marker
   *    (superscript(anchor + reference_link)) or a literal `[^id]`. */
  | { type: "reference"; text: TgRichText; name: string }
  /** A link TO a footnote definition (canonical body marker, half 2). */
  | { type: "reference_link"; text: TgRichText; reference_name: string }
  /** A link TO an in-message anchor (canonical footer backlink "↩"). */
  | { type: "anchor_link"; text: TgRichText; anchor_name: string };

/**
 * A table cell: a rich-text entity OBJECT (bare strings 400). Header-row cells
 * add `is_header: true` — the client renders header cells with a distinct
 * background (live-verified 2026-10-05: entity + is_header renders better
 * than the full RichBlockTableCell object shape).
 */
export type TgTableCell = TgRichText | (TgRichText & { is_header?: boolean });

/** The InputRichBlock subset we emit. */
export type TgBlock =
  | { type: "paragraph"; text: TgRichText }
  | { type: "heading"; text: TgRichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "pre"; text: string; language?: string }
  | { type: "divider" }
  | { type: "list"; items: TgListItem[] }
  | { type: "blockquote"; blocks: TgBlock[] }
  | { type: "table"; cells: TgTableCell[][]; is_bordered?: boolean; caption?: TgRichText }
  | { type: "details"; summary: TgRichText; blocks: TgBlock[]; is_open?: boolean }
  /** A LaTeX block (markdown `$$…$$` or ```math fence). Zero cost in our
   *    budget until the client renders it — counted as the source length
   *    (conservative; the rendered expression is usually shorter). */
  | { type: "mathematical_expression"; expression: string }
  /** An in-message anchor (markdown `<a name="id"></a>`). Zero content —
   *    exists for in-document links (`anchor_link` references). */
  | { type: "anchor"; name: string }
  /** The footnote DEFINITIONS block (canonical shape, spike 2026-10-06 /
   *    forwarded msg 1516): numbered "N. " + reference(definition text) +
   *    " " + ↩ backlink entries, "\n"-separated in ONE RichText array. */
  | { type: "footer"; text: TgRichText }
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
 * One line/snippet of markdown → inline RichText (blocks tier). md4x-backed
 * (the old regex-pass parser is gone — see src/md4x-mapper.ts). Callers pass
 * short strings (tool why/state text, bottom lines), never multi-paragraph
 * documents; block syntax in such input is joined defensively.
 */
export function inlineToRichText(src: string): TgRichText {
  return inlineToRichTextV2(src);
}

/**
 * Markdown → TgBlock[] for the blocks tier. md4x-backed (src/md4x-mapper.ts):
 * CommonMark+GFM spec-compliant parsing (headings, code fences with language,
 * tables, nested + task lists, quotes, hr), plus our extensions — canonical
 * footnote markers + footer, display math (whole-line $$…$$ / ```math fence),
 * <a name=…> anchors, <details>/<summary>.
 *
 * `heal: true` (drafts only) makes md4x close half-typed emphasis/fence
 * constructs mid-stream; persistent sends never heal — an incomplete
 * construct in FINAL text is kept literal, never "completed" (healing could
 * corrupt complete text).
 *
 * The server 400s on EMPTY block content (RICH_MESSAGE_CONTENT_REQUIRED) —
 * half-typed blocks ("## ", "```", ">") emit nothing; they land on the next
 * tick when content arrives.
 */
export function mdToBlocks(md: string, opts?: { heal?: boolean }): TgBlock[] {
  return mdToBlocksV2(md, opts);
}


/** Sum of plain-text char lengths of all string leaves (JS string units, not bytes). */
export function richTextLen(rt: TgRichText): number {
  if (typeof rt === "string") return rt.length;
  if (Array.isArray(rt)) return rt.reduce((n, x) => n + richTextLen(x), 0);
  if (rt.type === "anchor") return 0; // no text — pure navigation
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
      case "footer":
        n += richTextLen(b.text);
        break;
      case "divider":
      case "anchor":
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
      case "mathematical_expression":
        n += b.expression.length;
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

// ─────────────────────────── Blocks pipeline ───────────────────────────

const ELLIPSIS = "⋯";
const CONTINUED = "(continued)";
const HR_PLAIN = "────────";

/**
 * Fold long `pre` blocks (> foldLines lines) into closed `details`
 * (summary: "code[, lang] (N lines)"). Short fences and non-pre blocks pass
 * through. Structural replacement for the legacy foldLongFences string hack.
 */
export function foldBlocks(blocks: TgBlock[], foldLines = 25): TgBlock[] {
  return blocks.map((b) => {
    if (b.type !== "pre") return b;
    const lines = b.text.split("\n");
    if (lines.length <= foldLines) return b;
    const summary = `code${b.language ? `, ${b.language}` : ""} (${lines.length} lines)`;
    return { type: "details", summary, blocks: [b], is_open: false };
  });
}

/**
 * Draft overflow view: keep the SUFFIX of the block array within BOTH budgets
 * (rendered chars AND block count), prefix a single "⋯" paragraph. The last
 * block (typically `thinking`) is always kept. A single oversized `pre` is
 * hard-cut to its last lines (the draft is a live preview).
 */
export function tailBlocks(blocks: TgBlock[], capChars = RICH_CAP, capBlocks = 480): TgBlock[] {
  if (blocksLen(blocks) <= capChars && blockCount(blocks) <= capBlocks) return blocks.slice();
  const budget = Math.max(1, capChars - ELLIPSIS.length);
  const keep: TgBlock[] = [];
  let len = 0;
  let cnt = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const bl = blocksLen([b]);
    const bc = blockCount([b]);
    if (len + bl <= budget && cnt + bc <= capBlocks - 1) {
      keep.unshift(b);
      len += bl;
      cnt += bc;
    } else {
      break;
    }
  }
  if (keep.length === 0) {
    // Single oversized last block: hard-cut a `pre` to its last lines;
    // anything else (e.g. `thinking`) is kept whole — it is cheap and last.
    const last = blocks[blocks.length - 1];
    if (last && last.type === "pre") {
      const lines = last.text.split("\n");
      const tail: string[] = [];
      let tl = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const add = (tail.length > 0 ? 1 : 0) + lines[i].length;
        if (tl + add > budget) break;
        tail.unshift(lines[i]);
        tl += add;
      }
      keep.push(tail.length > 0
        ? (last.language ? { type: "pre", text: tail.join("\n"), language: last.language } : { type: "pre", text: tail.join("\n") })
        : last);
    } else if (last) {
      keep.push(last);
    }
  }
  return [{ type: "paragraph", text: ELLIPSIS }, ...keep];
}

/**
 * Pack whole blocks into chunks within BOTH budgets (rendered chars AND block
 * count; a fresh chunk starts a fresh count). Chunks ≥ 2 get a leading
 * "(continued)" marker paragraph (its cost is reserved from chunk 2 on).
 * An oversized single block is split structurally by type:
 *  - pre → line boundaries (language re-emitted per piece)
 *  - table → row boundaries (header row repeated per piece)
 *  - list → item boundaries (ordered `value` carries the continuation)
 *  - details → unwrapped (summary becomes a leading paragraph, inner re-packed)
 *  - anything else → hard character cut (last resort)
 */
export function chunkBlocks(blocks: TgBlock[], capChars = RICH_CAP, capBlocks = 480): TgBlock[][] {
  // reserve the (continued) marker budget for splitting too — a structural
  // piece packed to the full cap would leave no room for the marker in
  // chunks 2+ (the marker rides ON TOP of the piece's content).
  const effCap = capChars - CONTINUED.length - 1;
  const expanded = expandBlocks(blocks, effCap, capBlocks);
  const raw: TgBlock[][] = [];
  let cur: TgBlock[] = [];
  let curLen = 0;
  let curCnt = 0;
  for (const b of expanded) {
    const first = raw.length === 0 && cur.length === 0;
    const capC = first ? capChars : capChars - CONTINUED.length - 1;
    const capB = first ? capBlocks : capBlocks - 1;
    const bl = blocksLen([b]);
    const bc = blockCount([b]);
    if (cur.length > 0 && (curLen + bl > capC || curCnt + bc > capB)) {
      raw.push(cur);
      cur = [];
      curLen = 0;
      curCnt = 0;
    }
    cur.push(b);
    curLen += bl;
    curCnt += bc;
  }
  if (cur.length > 0) raw.push(cur);
  return raw.map((c, i) => (i === 0 ? c : [{ type: "paragraph", text: CONTINUED }, ...c]));
}

/** Replace each over-budget block with its structural split (recursively). */
function expandBlocks(blocks: TgBlock[], capChars: number, capBlocks: number): TgBlock[] {
  const out: TgBlock[] = [];
  for (const b of blocks) {
    const oversized = blocksLen([b]) > capChars || blockCount([b]) > capBlocks;
    if (!oversized) { out.push(b); continue; }
    switch (b.type) {
      case "pre":
        out.push(...splitPre(b, capChars));
        break;
      case "table":
        out.push(...splitTable(b, capChars));
        break;
      case "list":
        out.push(...splitList(b, capChars, capBlocks));
        break;
      case "details":
        out.push({ type: "paragraph", text: b.summary });
        out.push(...expandBlocks(b.blocks, capChars, capBlocks));
        break;
      default:
        out.push(...hardSplitBlock(b, capChars));
        break;
    }
  }
  return out;
}

/** Split a pre at line boundaries; each piece re-emits the language. */
function splitPre(b: Extract<TgBlock, { type: "pre" }>, cap: number): TgBlock[] {
  const lines = b.text.split("\n");
  const pieces: TgBlock[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length > 0) {
      pieces.push(b.language ? { type: "pre", text: cur.join("\n"), language: b.language } : { type: "pre", text: cur.join("\n") });
      cur = [];
      len = 0;
    }
  };
  for (const line of lines) {
    if (line.length > cap) {
      flush();
      for (let i = 0; i < line.length; i += cap) {
        const piece = line.slice(i, i + cap);
        pieces.push(b.language ? { type: "pre", text: piece, language: b.language } : { type: "pre", text: piece });
      }
      continue;
    }
    const add = (cur.length > 0 ? 1 : 0) + line.length;
    if (len + add <= cap) { cur.push(line); len += add; }
    else { flush(); cur = [line]; len = line.length; }
  }
  flush();
  return pieces.length > 0 ? pieces : [b];
}

/** Split a table at row boundaries; the header row repeats per piece. */
function splitTable(b: Extract<TgBlock, { type: "table" }>, cap: number): TgBlock[] {
  const header = b.cells[0] ?? [];
  const rows = b.cells.slice(1);
  const headerLen = rows.length === 0 ? 0 : b.cells[0].reduce((n, c) => n + richTextLen(c), 0);
  const pieces: TgBlock[] = [];
  let cur: TgRichText[][] = [];
  let len = 0;
  const flush = () => {
    if (cur.length > 0) {
      pieces.push({ type: "table", is_bordered: b.is_bordered, cells: [header, ...cur] });
      cur = [];
      len = 0;
    }
  };
  for (const row of rows) {
    const rl = row.reduce((n, c) => n + richTextLen(c), 0);
    if (rl + headerLen > cap) {
      // One over-long row: emit as its own piece (cell-splitting is not a
      // block-tier operation; the plain rung is the backstop).
      flush();
      pieces.push({ type: "table", is_bordered: b.is_bordered, cells: [header, row] });
      continue;
    }
    if (len + rl > cap) flush();
    cur.push(row);
    len += rl;
  }
  flush();
  return pieces.length > 0 ? pieces : [b];
}

/** Split a list at item boundaries; ordered `value`s carry the continuation. */
function splitList(b: Extract<TgBlock, { type: "list" }>, cap: number, capB: number): TgBlock[] {
  const pieces: TgBlock[] = [];
  let cur: TgListItem[] = [];
  let len = 0;
  let cnt = 0;
  const flush = () => {
    if (cur.length > 0) {
      pieces.push({ type: "list", items: cur });
      cur = [];
      len = 0;
      cnt = 0;
    }
  };
  for (const it of b.items) {
    const il = blocksLen(it.blocks);
    const ic = blockCount(it.blocks) + 1;
    if (cur.length > 0 && (len + il > cap || cnt + ic > capB)) flush();
    cur.push(it);
    len += il;
    cnt += ic;
  }
  flush();
  return pieces.length > 0 ? pieces : [b];
}

/** Last resort: hard-cut a block's text (paragraph/heading/thinking/footer). */
function hardSplitBlock(b: TgBlock, cap: number): TgBlock[] {
  if (b.type !== "paragraph" && b.type !== "heading" && b.type !== "thinking" && b.type !== "footer") return [b];
  const text = richTextToPlain(b.text);
  const pieces: TgBlock[] = [];
  for (let i = 0; i < text.length; i += cap) {
    const piece = text.slice(i, i + cap);
    if (b.type === "heading") {
      pieces.push(i === 0 ? { type: "heading", text: piece, size: b.size } : { type: "paragraph", text: piece });
    } else {
      pieces.push({ type: b.type, text: piece });
    }
  }
  return pieces.length > 0 ? pieces : [b];
}

/**
 * Blocks → plain text (the terminal fallback rung + blocksToPlainText for the
 * plain demotion). Recursive walk: pre → bare lines, details → summary line +
 * inner, table → pipe rows, list → "- " / "N. " items, links → "text (href)".
 */
export function blocksToPlainText(blocks: TgBlock[]): string {
  const lines: string[] = [];
  const walk = (bs: TgBlock[]): void => {
    for (const b of bs) {
      if (b.type === "anchor") continue; // zero content
      switch (b.type) {
        case "footer":
          lines.push(richTextToPlain(b.text));
          continue;
        case "paragraph":
        case "heading":
        case "thinking":
          lines.push(richTextToPlain(b.text));
          break;
        case "pre":
          lines.push(b.text);
          break;
        case "divider":
          lines.push(HR_PLAIN);
          break;
        case "list":
          for (const it of b.items) {
            const body = blocksToPlainText(it.blocks).replace(/\n/g, " ");
            const box = it.has_checkbox ? `[${it.is_checked ? "x" : " "}] ` : "";
            const num = it.type && it.value !== undefined ? `${it.value}. ` : "- ";
            lines.push(num + box + body);
          }
          break;
        case "blockquote":
          walk(b.blocks);
          break;
        case "details":
          lines.push(richTextToPlain(b.summary));
          walk(b.blocks);
          break;
        case "table":
          for (const row of b.cells) {
            lines.push("| " + row.map((c) => richTextToPlain(c)).join(" | ") + " |");
          }
          break;
        case "mathematical_expression":
          lines.push(b.expression);
          break;
      }
    }
  };
  walk(blocks);
  return lines.join("\n");
}

/** RichText → plain text (links degrade to "text (href)", the legacy behavior). */
export function richTextToPlain(rt: TgRichText): string {
  if (typeof rt === "string") return rt;
  if (Array.isArray(rt)) return rt.map(richTextToPlain).join("");
  if (rt.type === "url") return `${richTextToPlain(rt.text)} (${rt.url})`;
  if (rt.type === "anchor") return ""; // zero content
  if (rt.type === "reference") {
    // canonical footer entry: the definition text; intermediate (un-finalized):
    // the literal marker
    return richTextToPlain(rt.text) !== "" ? richTextToPlain(rt.text) : `[^${rt.name}]`;
  }
  if (rt.type === "reference_link" || rt.type === "anchor_link") return richTextToPlain(rt.text); // the marker digit / ↩
  return richTextToPlain(rt.text);
}
