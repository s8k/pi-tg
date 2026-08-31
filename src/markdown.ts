/** Escape HTML text content (not attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * Convert ONE line of markdown to Telegram HTML.
 * Supports: `code`, [t](url), **bold**, __bold__, *italic*, _italic_, ~~strike~~.
 * Guarantees balanced tags: unmatched markers remain literal (never an unclosed tag).
 * Documented v1 limits: no triple emphasis (`***x***`), no parens in URLs,
 * a `*` pair with text between renders as italic even if the intent was a bullet.
 */
export function inlineToHtml(src: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  // 1) code spans — content verbatim (escaped), no formatting parsed inside
  let s = src.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  // 2) links — URL untouched by later passes; text fully parsed (recursive)
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, text: string, url: string) =>
    keep(`<a href="${escapeAttr(url)}">${inlineToHtml(text)}</a>`),
  );

  // 3) escape the rest
  s = escapeHtml(s);

  // 4) emphasis — bold before italic (bold content admits single stars)
  s = s.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^_\w])__((?:[^_]|\_(?!_))+?)__(?![\w_])/g, "$1<b>$2</b>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");

  // 5) restore stashed code spans / links
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)]);
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const HR_RE = /^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d{1,9})\.\s+(.*)$/;
const BQ_RE = /^\s*>\s?(.*)$/;
const HR_LINE = "────────";

function fenceCloseRe(open: string): RegExp {
  const ch = open[0] === "`" ? "`" : "~";
  return new RegExp("^\\s*" + ch + "{" + open.length + ",}\\s*$");
}

interface Unit {
  html: string;
}

/** Parse markdown into render units; a whole code fence is ONE unit (never split later). */
export function toUnits(md: string): Unit[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const buf: string[] = [];
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence (EOF = still streaming)
      units.push({ html: `<pre>${escapeHtml(buf.join("\n"))}</pre>` });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const h = HEADING_RE.exec(line);
    const hr = HR_RE.exec(line);
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    const bq = BQ_RE.exec(line);
    let html: string;
    if (h) html = `<b>${inlineToHtml(h[1].replace(/\s+#+\s*$/, ""))}</b>`;
    else if (hr) html = HR_LINE;
    else if (ul) html = `• ${inlineToHtml(ul[1])}`;
    else if (ol) html = `${ol[1]}. ${inlineToHtml(ol[2])}`;
    else if (bq) html = `❝ ${inlineToHtml(bq[1])}`;
    else html = inlineToHtml(line);
    units.push({ html });
    i++;
  }
  return units;
}

/** Full document → one HTML string (for single-message sends and tests). */
export function markdownToHtml(md: string): string {
  return toUnits(md).map((u) => u.html).join("\n");
}

export const TG_MAX_LEN = 4096;
const MARKER = "(continued)\n";

function hardCut(text: string, cap: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    out.push(rest.slice(0, cap));
    rest = rest.slice(cap);
  }
  if (rest !== "") out.push(rest);
  return out;
}

/** Split one over-limit unit: <pre> blocks re-wrap at code-line boundaries; anything else hard-cuts. */
function hardSplitUnit(html: string, maxLen: number): string[] {
  const cap = maxLen - MARKER.length;
  const m = /^<pre>([\s\S]*)<\/pre>$/.exec(html);
  if (!m) return hardCut(html, cap);
  const lineCap = cap - "<pre>".length - "</pre>".length;
  const codeLines = m[1].split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (buf.length > 0) {
      out.push(`<pre>${buf.join("\n")}</pre>`);
      buf = [];
      len = 0;
    }
  };
  for (const cl of codeLines) {
    if (cl.length > lineCap) {
      // single code line over the limit: hard-cut (documented last resort)
      flush();
      for (const piece of hardCut(cl, lineCap)) out.push(`<pre>${piece}</pre>`);
      continue;
    }
    const add = (buf.length > 0 ? 1 : 0) + cl.length;
    if (len + add <= lineCap) {
      buf.push(cl);
      len += add;
    } else {
      flush();
      buf.push(cl);
      len = cl.length;
    }
  }
  flush();
  return out;
}

/** Pack rendered units into chunks ≤ maxLen; chunks ≥ 2 get the continuation marker. */
export function chunkMarkdown(md: string, maxLen = TG_MAX_LEN): string[] {
  const raw: string[] = [];
  let cur = "";
  const push = () => {
    if (cur !== "") {
      raw.push(cur);
      cur = "";
    }
  };
  for (const u of toUnits(md)) {
    const piece = u.html;
    if (piece.length > maxLen - MARKER.length) {
      push();
      raw.push(...hardSplitUnit(piece, maxLen));
      continue;
    }
    // Full maxLen only for the very first piece of the very first chunk
    // (the only chunk that never carries the marker); everything else reserves marker space.
    const cap = raw.length === 0 && cur === "" ? maxLen : maxLen - MARKER.length;
    const sep = cur === "" ? 0 : 1;
    if (cur.length + sep + piece.length <= cap) {
      cur = cur === "" ? piece : cur + "\n" + piece;
    } else {
      push();
      cur = piece;
    }
  }
  push();
  return raw.map((r, idx) => (idx === 0 ? r : MARKER + r));
}

/** Same line-boundary packing for plain (fallback) text. */
export function chunkText(plain: string, maxLen = TG_MAX_LEN): string[] {
  const raw: string[] = [];
  let cur = "";
  const push = () => {
    if (cur !== "") {
      raw.push(cur);
      cur = "";
    }
  };
  for (const line of plain.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") continue;
    if (line.length > maxLen - MARKER.length) {
      push();
      raw.push(...hardCut(line, maxLen - MARKER.length));
      continue;
    }
    const cap = raw.length === 0 && cur === "" ? maxLen : maxLen - MARKER.length;
    const sep = cur === "" ? 0 : 1;
    if (cur.length + sep + line.length <= cap) {
      cur = cur === "" ? line : cur + "\n" + line;
    } else {
      push();
      cur = line;
    }
  }
  push();
  return raw.map((r, idx) => (idx === 0 ? r : MARKER + r));
}

function stripInline(s: string): string {
  return s
    .replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, "$1 ($2)")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+__)__|__([^_]+)__/g, (_m, _a, b) => (b ?? _m))
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1$2");
}

/** Strip all markdown syntax → plain text (used when Telegram rejects the HTML). */
export function toPlainText(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      continue;
    }
    if (line.trim() === "") { out.push(""); i++; continue; }
    const h = HEADING_RE.exec(line);
    const hr = HR_RE.exec(line);
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    const bq = BQ_RE.exec(line);
    if (h) out.push(stripInline(h[1].replace(/\s+#+\s*$/, "")));
    else if (hr) out.push(HR_LINE);
    else if (ul) out.push("• " + stripInline(ul[1]));
    else if (ol) out.push(`${ol[1]}. ` + stripInline(ol[2]));
    else if (bq) out.push(stripInline(bq[1]));
    else out.push(stripInline(line));
    i++;
  }
  return out.join("\n");
}

// ─────────────────────────── Rich pipeline (Bot API 10.2+) ───────────────────────────

/** Internal rich-message cap (documented: 32768 UTF-8 chars; margin pending Task 0 spike). */
export const RICH_CAP = 32_000;

export type RichUnitType = "fence" | "table" | "heading" | "list" | "blockquote" | "hr" | "details" | "paragraph";

export interface RichUnit {
  type: RichUnitType;
  text: string; // verbatim markdown of the block
}

const isTableRow = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
};
const isTableSep = (line: string): boolean => line.includes("-") && /^[\s|:-]+$/.test(line.trim());
const DETAILS_OPEN_RE = /^\s*<details>/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>/i;

/**
 * Top-level block parse (verbatim — no rendering). Powers folding, chunking and
 * the tail view. One implementation; the legacy converter is untouched.
 */
export function richUnits(md: string): RichUnit[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const units: RichUnit[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) { units.push({ type: "paragraph", text: para.join("\n") }); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushPara();
      const buf: string[] = [line];
      const closeRe = fenceCloseRe(fence[1]);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; } // consume close (EOF = still streaming)
      units.push({ type: "fence", text: buf.join("\n") });
      continue;
    }
    if (DETAILS_OPEN_RE.test(line)) {
      flushPara();
      const buf: string[] = [line];
      i++;
      while (i < lines.length && !DETAILS_CLOSE_RE.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      units.push({ type: "details", text: buf.join("\n") });
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    if (HEADING_RE.test(line) || HR_RE.test(line)) {
      flushPara();
      units.push({ type: HR_RE.test(line) ? "hr" : "heading", text: line });
      i++;
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && (UL_RE.test(lines[i]) || OL_RE.test(lines[i]))) { buf.push(lines[i]); i++; }
      units.push({ type: "list", text: buf.join("\n") });
      continue;
    }
    if (BQ_RE.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && BQ_RE.test(lines[i])) { buf.push(lines[i]); i++; }
      units.push({ type: "blockquote", text: buf.join("\n") });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const buf: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { buf.push(lines[i]); i++; }
      units.push({ type: "table", text: buf.join("\n") });
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return units;
}

/**
 * Wrap fenced blocks whose body has more than `foldLines` lines in a closed
 * <details> (the markdown tier parses markdown inside details bodies, so the
 * fence still renders as a preformatted block). Short fences pass verbatim.
 */
export function foldLongFences(md: string, foldLines = 25): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (!fence) { out.push(line); i++; continue; }
    const buf: string[] = [line];
    const closeRe = fenceCloseRe(fence[1]);
    i++;
    let closed = false;
    while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
    if (i < lines.length) { buf.push(lines[i]); i++; closed = true; }
    const body = buf.slice(1, closed ? buf.length - 1 : buf.length);
    if (body.length > foldLines) {
      const lang = fence[2] ?? "";
      const summary = `code${lang ? `, ${lang}` : ""} (${body.length} lines)`;
      out.push(`<details><summary>${summary}</summary>`, "", ...buf, "", "</details>");
    } else {
      out.push(...buf);
    }
  }
  return out.join("\n");
}
