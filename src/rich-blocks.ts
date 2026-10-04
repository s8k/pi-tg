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



// ─────────────────────────── Block-level converter ───────────────────────────

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d{1,9})\.\s+(.*)$/;
const BQ_RE = /^\s*>\s?(.*)$/;
const DETAILS_OPEN_RE = /^\s*<details>/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>/i;
const SUMMARY_RE = /^\s*<summary[^>]*>(.*)<\/summary>\s*$/i;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

const isTableRow = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
};
const isTableSep = (line: string): boolean => line.includes("-") && /^[\s|:-]+$/.test(line.trim());

function fenceCloseRe(open: string): RegExp {
  const ch = open[0] === "`" ? "`" : "~";
  return new RegExp("^\\s*" + ch + "{" + open.length + ",}\\s*$");
}

/**
 * Convert a markdown document to the InputRichBlock subset. Total function:
 * any string in, some blocks out (unknown/verbatim lines become plain
 * paragraphs — never a parse failure). An unclosed fence at EOF emits a `pre`
 * as-is (the streaming-tail case; nothing to close).
 */
export function mdToBlocks(md: string): TgBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: TgBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      // GFM: blank lines split paragraphs; soft line breaks within a run stay
      for (const chunk of para.join("\n").split(/\n\s*\n/)) {
        const t = chunk.trim();
        if (t !== "") out.push({ type: "paragraph", text: inlineToRichText(t) });
      }
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[2] || undefined;
      const closeRe = fenceCloseRe(fence[1]);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume close (EOF = still streaming)
      out.push(lang ? { type: "pre", text: body.join("\n"), language: lang } : { type: "pre", text: body.join("\n") });
      continue;
    }
    if (DETAILS_OPEN_RE.test(line)) {
      flushPara();
      i++;
      const inner: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (DETAILS_CLOSE_RE.test(lines[i])) { closed = true; i++; break; }
        inner.push(lines[i]); i++;
      }
      // Summary: first non-empty line; <summary>…</summary> tags stripped if present.
      let summary = "";
      const firstIdx = inner.findIndex((l) => l.trim() !== "");
      if (firstIdx >= 0) {
        const m = SUMMARY_RE.exec(inner[firstIdx]);
        summary = m ? m[1] : inner[firstIdx];
        inner.splice(firstIdx, 1);
      }
      const blocks = mdToBlocks(inner.join("\n"));
      out.push(closed
        ? { type: "details", summary, blocks }
        : { type: "details", summary, blocks, is_open: true });
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      out.push({ type: "heading", text: inlineToRichText(h[2]), size: h[1].length as 1 | 2 | 3 | 4 | 5 | 6 });
      i++; continue;
    }
    if (HR_RE.test(line)) { flushPara(); out.push({ type: "divider" }); i++; continue; }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushPara();
      const items: TgListItem[] = [];
      while (i < lines.length) {
        const ul = UL_RE.exec(lines[i]);
        const ol = OL_RE.exec(lines[i]);
        if (ul) {
          const task = TASK_RE.exec(ul[1]);
          if (task) items.push({ blocks: [paraBlock(task[2])], has_checkbox: true, is_checked: task[1] !== " " });
          else items.push({ blocks: [paraBlock(ul[1])] });
          i++;
          // v1: indented continuation lines attach to the previous item (flat lists)
          while (i < lines.length && /^\s+\S/.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i])) {
            items[items.length - 1].blocks.push({ type: "paragraph", text: lines[i].trim() });
            i++;
          }
          continue;
        }
        if (ol) {
          items.push({ blocks: [paraBlock(ol[2])], type: "1", value: Number(ol[1]) });
          i++;
          continue;
        }
        break;
      }
      out.push({ type: "list", items });
      continue;
    }
    if (BQ_RE.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length) {
        const bq = BQ_RE.exec(lines[i]);
        if (!bq) break;
        buf.push(bq[1]);
        i++;
      }
      out.push({ type: "blockquote", blocks: mdToBlocks(buf.join("\n")) });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const rows: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(lines[i]); i++; }
      out.push(tableBlock(rows));
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

const paraBlock = (text: string): TgBlock => ({ type: "paragraph", text: inlineToRichText(text) });

/**
 * GFM table rows → table block. Header = row 1, row 2 is the separator (dropped).
 * Cells: spike-pinned — the API requires entity OBJECTS (bare strings 400);
 * plain header cells wrap in `bold`, plain body cells in `code`; cells with
 * inline entities pass through (arrays are wrapped, since arrays 400 too).
 */
function tableBlock(rows: string[]): TgBlock {
  const splitRow = (row: string): string[] =>
    row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const wrap = (rt: TgRichText, plainEntity: "bold" | "code"): TgRichText =>
    typeof rt === "string" || Array.isArray(rt) ? { type: plainEntity, text: rt } : rt;
  const header = splitRow(rows[0]).map((c) => wrap(inlineToRichText(c), "bold"));
  const body = rows.slice(2).map((r) => splitRow(r).map((c) => wrap(inlineToRichText(c), "code")));
  return { type: "table", is_bordered: true, cells: [header, ...body] };
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
export function tailBlocks(blocks: TgBlock[], capChars = 32_000, capBlocks = 480): TgBlock[] {
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
export function chunkBlocks(blocks: TgBlock[], capChars = 32_000, capBlocks = 480): TgBlock[][] {
  const expanded = expandBlocks(blocks, capChars, capBlocks);
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

/** Last resort: hard-cut a block's text (paragraph/heading/thinking). */
function hardSplitBlock(b: TgBlock, cap: number): TgBlock[] {
  if (b.type !== "paragraph" && b.type !== "heading" && b.type !== "thinking") return [b];
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
      switch (b.type) {
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
  return richTextToPlain(rt.text);
}
