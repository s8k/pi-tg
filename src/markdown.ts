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
