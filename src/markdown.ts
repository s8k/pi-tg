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
