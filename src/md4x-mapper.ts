/**
 * md4x AST → TgBlock/TgRichText mapper (parser migration T3–T6,
 * docs/plans/2026-10-07-md4x-parser-migration.md).
 *
 * Replaces the hand-rolled regex-pass parser in rich-blocks.ts (the
 * inlineToRichText passes + parseTagged + the mdToBlocks line loop). md4x
 * (unjs/md4x, C+NAPI, synchronous) parses CommonMark+GFM spec-compliant;
 * this file maps its ComarkTree to our blocks-tier shapes.
 *
 * Invariants carried over from the spike-pinned old parser:
 *  - EMPTY BLOCK CONTENT 400s (RICH_MESSAGE_CONTENT_REQUIRED): empty pre,
 *    math, headings, blockquotes, list items and details are not emitted
 *    (half-typed mid-stream content lands on the next tick — a real
 *    structural shift the draft rule allows).
 *  - Table cells must be RichText entity OBJECTS (bare strings 400):
 *    plain header → bold + is_header, plain body → code, mixed (array) →
 *    wrapped in the plain entity, empty → " " (live-verified 2026-10-05).
 *  - Canonical footnote shape (spike msg 1516): body ref →
 *    superscript(anchor fnref-N-k + reference_link N → fn-N); definitions →
 *    one `footer` block. The per-id occurrence counter is OURS, in document
 *    order — md4x double-counts refs inside table cells (refId 2 for the
 *    first visible ref), which would dangle the ↩ backlink.
 *  - `<details>/<summary>` is our custom extension (not GFM): md4x swallows
 *    a region into one block-`html` node (or splits it at blank lines), so a
 *    placeholder pre-pass extracts the regions and the old line logic
 *    re-parses them (recursively — nested details work).
 *  - Entity data is RAW: html nodes keep their source bytes and are never
 *    escaped or parsed.
 */
// The package's "." types condition points at a TYPES-ONLY declaration file
// (the function lives in lib/napi.d.mts) — so the runtime+typed import is the
// explicit napi entry (which is what Node uses anyway).
import { parseAST } from "md4x/napi";
import type { ComarkElement, ComarkNode, ComarkTree } from "md4x";

import { richTextLen } from "./rich-blocks.ts";
import type { TgBlock, TgListItem, TgRichText, TgTableCell } from "./rich-blocks.ts";

type El = ComarkElement;
const isEl = (n: ComarkNode): n is El => Array.isArray(n);
/** Children of an element (slice loses the tuple's rest typing). */
const kids = (n: El): ComarkNode[] => n.slice(2) as ComarkNode[];

/** Mapping context: footnote occurrence counter (document order) + the
 *  details-region lookup (filled by mdToBlocksV2's pre-pass). */
interface Ctx {
  fnOcc: Map<number, number>;
  details: (k: number) => TgBlock | undefined;
}

// --- the details extension (custom, not GFM) --------------------------------
const DETAILS_OPEN_RE = /^\s*<details>/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>/i;
const SUMMARY_RE = /^\s*<summary[^>]*>(.*)<\/summary>\s*$/i;
const ANCHOR_LINE_RE = /^\s*<a\s+name="([^"]*)"\s*><\/a>\s*$/;
const detToken = (k: number) => `@@PI_TG_DETAILS_${k}@@`;
const DET_TOKEN_RE = /^\s*@@PI_TG_DETAILS_(\d+)@@\s*$/;

/**
 * Pull `<details>…</details>` regions (line-based, same semantics as the old
 * parser) into placeholder lines BEFORE parsing, so md4x can't swallow them
 * as block-html. The region's inner text + closed flag are stashed as JSON
 * (the inner text is raw markdown — no other encoding is needed).
 */
function extractDetails(md: string): { src: string; regions: string[] } {
  const lines = md.split("\n");
  const regions: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (DETAILS_OPEN_RE.test(line)) {
      const inner: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (DETAILS_CLOSE_RE.test(lines[i]!)) { closed = true; i++; break; }
        inner.push(lines[i]!);
        i++;
      }
      regions.push(JSON.stringify({ inner: inner.join("\n"), closed }));
      out.push("", detToken(regions.length - 1), "");
    } else {
      out.push(line);
      i++;
    }
  }
  return { src: out.join("\n"), regions };
}

/** Rebuild one extracted region: summary (first non-empty line, `<summary>`
 *  tags stripped if present) + recursively-mapped body. Empty body → nothing
 *  (empty details 400s; an unclosed half-typed region with no body yet must
 *  emit nothing until the body lands). */
function detailsFromRegion(json: string | undefined, heal: boolean): TgBlock | undefined {
  if (json === undefined) return undefined;
  let parsed: { inner: string; closed: boolean };
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const lines = parsed.inner.split("\n");
  let summary = "";
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx >= 0) {
    const m = SUMMARY_RE.exec(lines[firstIdx]!);
    summary = m ? m[1]! : lines[firstIdx]!;
    lines.splice(firstIdx, 1);
  }
  const blocks = mdToBlocksV2(lines.join("\n"), { heal });
  if (blocks.length === 0) return undefined;
  return parsed.closed
    ? { type: "details", summary, blocks }
    : { type: "details", summary, blocks, is_open: true };
}

// --- small helpers -----------------------------------------------------------

/** Raw descendant text of an element (keeps source bytes for code/html/math
 *  — exactly what the pre/math/html mappings need). */
function rawTextOf(n: El): string {
  let s = "";
  const walk = (x: ComarkNode): void => {
    if (typeof x === "string") { s += x; return; }
    if (isEl(x)) for (const c of kids(x)) walk(c);
  };
  for (const c of kids(n)) walk(c);
  return s;
}

/** Plain text of a mapped RichText (for emptiness checks / literalization). */
function plainOf(rt: TgRichText): string {
  if (typeof rt === "string") return rt;
  if (Array.isArray(rt)) return rt.map(plainOf).join("");
  if (rt.type === "anchor") return "";
  return plainOf(rt.text);
}

// --- inline mapping (T3) ------------------------------------------------------

/** Map inline Comark nodes → TgRichText. Adjacent strings are merged; a
 *  single-element result collapses to the element (a lone entity stays an
 *  entity, not a 1-item array). */
export function mapInline(nodes: ComarkNode[], ctx: Ctx): TgRichText {
  const out: TgRichText[] = [];
  const push = (x: TgRichText): void => {
    const last = out[out.length - 1];
    if (typeof last === "string" && typeof x === "string") out[out.length - 1] = last + x;
    else out.push(x);
  };
  for (const n of nodes) {
    if (!isEl(n)) { push(n); continue; }
    const [tag, props, ...kids] = n;
    if (tag === null) continue; // HTML comment — CommonMark drops it entirely
    const inner = mapInline(kids, ctx);
    switch (tag) {
      case "strong": push({ type: "bold", text: inner }); break;
      case "em": push({ type: "italic", text: inner }); break;
      case "del": push({ type: "strikethrough", text: inner }); break;
      case "mark": push({ type: "marked", text: inner }); break;
      case "code": push({ type: "code", text: inner }); break;
      case "a": {
        const url = typeof props.href === "string" ? props.href : "";
        // An empty/blank href would 400 — keep the source literal instead
        // (the old link regex required a non-empty, non-space url too).
        if (url.trim() === "") { push(`[${plainOf(inner)}](${url})`); break; }
        push({ type: "url", text: inner, url });
        break;
      }
      case "sub": push({ type: "subscript", text: inner }); break;
      case "sup": push({ type: "superscript", text: inner }); break;
      case "br": push("\n"); break; // hard break → line break in the text
      case "footnote-ref": {
        // Canonical marker (§2.5). The occurrence suffix is OUR counter in
        // document order (md4x's refId double-counts table-cell refs).
        const id = Number(props.id);
        const k = (ctx.fnOcc.get(id) ?? 0) + 1;
        ctx.fnOcc.set(id, k);
        push({ type: "superscript", text: [
          { type: "anchor", name: `fnref-${id}-${k}` },
          { type: "reference_link", text: String(id), reference_name: `fn-${id}` },
        ] });
        break;
      }
      case "math": push(`$${plainOf(inner)}$`); break; // no inline-math entity — keep source
      case "math-display": push(`$$${plainOf(inner)}$$`); break; // embedded in text (healed half-typed) — keep source
      case "img": push(`![${String(props.alt ?? "")}](${String(props.src ?? "")})`); break;
      case "html": push(rawTextOf(n)); break; // raw source bytes, verbatim
      default: push(inner); // fail soft: unknown node → its content
    }
  }
  return out.length === 1 ? out[0] : out;
}

// --- list / table / footnote mapping (T4/T5) ---------------------------------

function mapListItems(nodes: ComarkNode[], ordered: boolean, start: number, ctx: Ctx): TgListItem[] {
  const items: TgListItem[] = [];
  let v = start;
  for (const n of nodes) {
    if (!isEl(n) || n[0] !== "li") continue;
    const [, props, ...itemKids] = n;
    const itemBlocks: TgBlock[] = [];
    const inlineKids: ComarkNode[] = [];
    for (const k of itemKids) {
      // GFM: a nested list belongs under this item; everything else is the
      // item's inline content (rendered as ONE paragraph).
      if (isEl(k) && (k[0] === "ul" || k[0] === "ol")) {
        const sub = mapListItems(kids(k), k[0] === "ol", Number((k[1] as Record<string, unknown>).start ?? 1), ctx);
        if (sub.length > 0) itemBlocks.push({ type: "list", items: sub });
      } else {
        inlineKids.push(k);
      }
    }
    const text = mapInline(inlineKids, ctx);
    if (plainOf(text).trim() !== "") itemBlocks.unshift({ type: "paragraph", text });
    if (itemBlocks.length === 0) continue; // empty item → skip (empty content 400s)
    const item: TgListItem = { blocks: itemBlocks };
    if (props.task) {
      item.has_checkbox = true;
      item.is_checked = props.checked === true;
    }
    if (ordered) {
      item.type = "1";
      item.value = v++;
    }
    items.push(item);
  }
  return items;
}

function wrapCell(rt: TgRichText, isHeader: boolean): TgTableCell {
  const plainEntity: "bold" | "code" = isHeader ? "bold" : "code";
  // An empty cell (half-typed mid-stream, or a GFM-padded `td`) would carry
  // an empty entity — 400; a space keeps the column shape.
  const text: TgRichText = typeof rt === "string" ? (rt === "" ? " " : rt) : richTextLen(rt) === 0 ? " " : rt;
  return typeof text === "string" || Array.isArray(text)
    ? { type: plainEntity, text, ...(isHeader ? { is_header: true } : {}) }
    : ({ ...text, ...(isHeader ? { is_header: true } : {}) } as TgTableCell);
}

function mapTable(n: El, ctx: Ctx): TgTableCell[][] {
  const rows: TgTableCell[][] = [];
  for (const sec of kids(n)) {
    if (!isEl(sec) || (sec[0] !== "thead" && sec[0] !== "tbody")) continue;
    for (const tr of kids(sec)) {
      if (!isEl(tr) || tr[0] !== "tr") continue;
      const row: TgTableCell[] = [];
      for (const cell of kids(tr)) {
        if (!isEl(cell) || (cell[0] !== "th" && cell[0] !== "td")) continue;
        row.push(wrapCell(mapInline(kids(cell), ctx), cell[0] === "th"));
      }
      if (row.length > 0) rows.push(row);
    }
  }
  return rows;
}

/** The `footnotes` block → ONE `footer` block, canonical shape (msg 1516):
 *  per definition `${N}. ` + reference(definition, fn-N) + ` ` + ↩ backlink
 *  to the FIRST body occurrence; `"\n"` is merged into the next entry's
 *  prefix string (not a separate array element). */
function mapFootnotes(n: El, ctx: Ctx): TgBlock | undefined {
  const parts: TgRichText[] = [];
  for (const fn of kids(n)) {
    if (!isEl(fn) || fn[0] !== "footnote") continue;
    const id = Number(fn[1].id);
    const def = mapInline(kids(fn), ctx);
    if (plainOf(def).trim() === "") continue; // empty def → skip (empty content 400s)
    parts.push(
      `${parts.length > 0 ? "\n" : ""}${id}. `,
      { type: "reference", text: def, name: `fn-${id}` },
      " ",
      { type: "anchor_link", text: "↩", anchor_name: `fnref-${id}-1` },
    );
  }
  if (parts.length === 0) return undefined;
  return { type: "footer", text: parts };
}

// --- block mapping (T4/T6) ----------------------------------------------------

export function mapBlocks(nodes: ComarkNode[], ctx: Ctx): TgBlock[] {
  const out: TgBlock[] = [];
  for (const n of nodes) {
    if (!isEl(n)) continue; // stray top-level text: md4x doesn't emit it
    const [tag, props, ...kids] = n;
    if (tag === null) continue; // HTML comment block — CommonMark drops it
    switch (tag) {
      case "p": {
        // details placeholder (from the pre-pass)
        const tok = DET_TOKEN_RE.exec(rawTextOf(n));
        if (tok) {
          const d = ctx.details(Number(tok[1]));
          if (d) out.push(d);
          continue;
        }
        // Sole child math-display → the LaTeX block (md4x wraps $$..$$ in p)
        if (kids.length === 1 && isEl(kids[0]!) && kids[0]![0] === "math-display") {
          const expr = rawTextOf(kids[0]!).trim();
          if (expr !== "") out.push({ type: "mathematical_expression", expression: expr });
          continue;
        }
        // `<a name="id"></a>` on its own line → anchor block (md4x renders it
        // as a p of inline html nodes; the text keeps the source bytes)
        if (kids.length > 0 && kids.every((k) => isEl(k) && k[0] === "html")) {
          const m = ANCHOR_LINE_RE.exec(kids.map((k) => rawTextOf(k as El)).join(""));
          if (m) { out.push({ type: "anchor", name: m[1]! }); continue; }
        }
        const text = mapInline(kids, ctx);
        if (plainOf(text).trim() !== "") out.push({ type: "paragraph", text });
        continue;
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const text = mapInline(kids, ctx);
        // A half-typed heading ("## ") has empty text — empty content 400s
        if (plainOf(text).trim() !== "") out.push({ type: "heading", text, size: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6 });
        continue;
      }
      case "pre": {
        const lang = typeof props.language === "string" ? props.language : "";
        const code = rawTextOf(n).replace(/\n+$/, ""); // md4x keeps a trailing \n
        if (/^\s*math\b/i.test(lang)) {
          // ```math fence — md4x emits a plain pre; we render the LaTeX block
          const expr = code.trim();
          if (expr !== "") out.push({ type: "mathematical_expression", expression: expr });
        } else if (code !== "") {
          out.push(lang !== "" ? { type: "pre", text: code, language: lang } : { type: "pre", text: code });
        }
        continue;
      }
      case "ul": case "ol": {
        const items = mapListItems(kids, tag === "ol", Number(props.start ?? 1), ctx);
        if (items.length > 0) out.push({ type: "list", items });
        continue;
      }
      case "blockquote": {
        const blocks = mapBlocks(kids, ctx);
        if (blocks.length > 0) out.push({ type: "blockquote", blocks }); // a bare ">" 400s
        continue;
      }
      case "table": {
        const cells = mapTable(n, ctx);
        if (cells.length > 0) out.push({ type: "table", is_bordered: true, cells });
        continue;
      }
      case "hr": out.push({ type: "divider" }); continue;
      case "footnotes": {
        const footer = mapFootnotes(n, ctx);
        if (footer) out.push(footer);
        continue;
      }
      case "html": {
        // Block-level html (stray tags, unclosed <details> leftovers): the
        // entity tier treats text as raw data — literal paragraph. md4x keeps
        // a trailing newline in the raw html — trim it (old-parser parity).
        const raw = rawTextOf(n).replace(/\n+$/, "");
        if (raw.trim() !== "") out.push({ type: "paragraph", text: raw });
        continue;
      }
      default: {
        // fail soft: unknown node → its text as a paragraph
        const t = rawTextOf(n);
        if (t.trim() !== "") out.push({ type: "paragraph", text: t });
        continue;
      }
    }
  }
  return out;
}

// --- public entry points -------------------------------------------------------

/** The blocks-tier markdown entry point (md4x-backed). `heal: true` for
 *  drafts (incomplete streaming markdown); persistent sends never heal. */
export function mdToBlocksV2(md: string, opts?: { heal?: boolean }): TgBlock[] {
  const heal = opts?.heal ?? false;
  // \r\n normalization (old parser parity) + the md4x backslash-EOL quirk
  // workaround (it emits a literal `\n` for a CommonMark hard break — §4.4 #1)
  const norm = md.replace(/\r\n?/g, "\n").replace(/\\\n/g, "  \n");
  const { src, regions } = extractDetails(norm);
  const tree = parseAST(src, { heal });
  const ctx: Ctx = {
    fnOcc: new Map(),
    details: (k: number) => detailsFromRegion(regions[k], heal),
  };
  return mapBlocks(tree.nodes, ctx);
}

/** One line/snippet of markdown → inline RichText (callers pass short bot
 *  strings: tool why/state text — never multi-paragraph documents). */
export function inlineToRichTextV2(src: string): TgRichText {
  const norm = src.replace(/\r\n?/g, "\n").replace(/\\\n/g, "  \n");
  const tree = parseAST(norm);
  const ctx: Ctx = { fnOcc: new Map(), details: () => undefined };
  const blocks = mapBlocks(tree.nodes, ctx);
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0].type === "paragraph") return blocks[0].text;
  // Defensive: block syntax in a line-sized input — join the renderable
  // pieces (lists/tables/dividers have no inline form; skip them).
  const parts: TgRichText[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "heading") parts.push(b.text);
    else if (b.type === "pre") parts.push(b.text);
    else if (b.type === "mathematical_expression") parts.push(b.expression);
  }
  const flat: TgRichText[] = [];
  parts.forEach((p, i) => {
    if (i > 0) flat.push("\n");
    flat.push(p);
  });
  const merged: TgRichText[] = [];
  for (const x of flat) {
    const last = merged[merged.length - 1];
    if (typeof last === "string" && typeof x === "string") merged[merged.length - 1] = last + x;
    else merged.push(x);
  }
  return merged.length === 1 ? merged[0] : merged;
}

/** Exposed for tests (mapBlocks over a hand-built node list). */
export const parseComark = (md: string, heal = false): ComarkTree => parseAST(md, { heal });
