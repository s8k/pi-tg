/**
 * Survivors of the markdown/HTML pipeline after the blocks-tier migration
 * (2026-10-03): plain-text chunking for the plain rung, the shared line
 * regexes + `richUnits` block skeleton (the direct ancestor of
 * `mdToBlocks` in rich-blocks.ts), and the work-log helpers. The rich
 * markdown/HTML tiers (inlineToHtml, toUnits, markdownToHtml, chunkMarkdown,
 * foldLongFences, chunkRich, tailView, renderToolBlock) are RETIRED — the
 * blocks tier renders structured data, never a re-parsed string.
 */

/** Escape HTML text content (not attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// ─────────────────────── Shared block skeleton (mdToBlocks ancestor) ───────────────────────

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

const isTableRow = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
};
const isTableSep = (line: string): boolean => line.includes("-") && /^[\s|:-]+$/.test(line.trim());
const DETAILS_OPEN_RE = /^\s*<details>/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>/i;

/**
 * Internal rich-message cap for PERSISTENT (final) messages. The API limit is
 * 32768 chars, but mobile clients render the whole message at once — using the
 * full budget is the worst case for them (live freeze reports, 2026-10-08),
 * so persistent messages cap at half the limit.
 */
export const RICH_CAP = 16_000;

/**
 * Cap for the DRAFT tail — the message that is re-sent (re-laid-out by the
 * client) on every stream tick. Kept smaller than RICH_CAP for the same
 * mobile-rendering reason; the draft is transient, so losing older tail
 * content to the ⋯ truncation is fine.
 */
export const DRAFT_TAIL_CAP = 8_000;

export type RichUnitType = "fence" | "table" | "heading" | "list" | "blockquote" | "hr" | "details" | "paragraph";

export interface RichUnit {
  type: RichUnitType;
  text: string; // verbatim markdown of the block
}

/**
 * Top-level block parse (verbatim — no rendering). The direct ancestor of
 * `mdToBlocks` in rich-blocks.ts, kept as the shared skeleton (same regexes,
 * same pass order) so the two stay in sync.
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

// ─────────────────────── Work-log tool blocks (two-message mirror) ───────────────────────

/** State stamp for a tool block in the work log. */
export type ToolState = "…" | "✔" | "✖";

export interface ToolBlockSpec {
  name: string;
  argsJson: string;
  why?: string;
  state: ToolState;
  errorText?: string;
}

/** Tool arguments → pretty JSON, capped so the collapsed params block stays small. */
export function toolArgsJson(args: unknown, cap = 2048): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {}, null, 2) ?? "{}";
  } catch {
    s = String(args ?? "");
  }
  return s.length > cap ? s.slice(0, cap) + "\n…" : s;
}

/**
 * The "why" motivating a tool call: the LAST sentence of the thinking stream
 * seen before the call (sentences split on `.!?` boundaries), capped.
 * Redacted/absent thinking yields no input → undefined (no 💭 line).
 */
export function extractWhy(thinking: string[], cap = 200): string | undefined {
  const joined = thinking.join("").trim();
  if (!joined) return undefined;
  const chunks = joined.split(/(?<=[.!?])\s+/);
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i].trim();
    if (c) return c.length > cap ? c.slice(0, cap) + "…" : c;
  }
  return undefined;
}
