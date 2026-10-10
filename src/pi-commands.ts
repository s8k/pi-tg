/**
 * The session command table for the inline command picker.
 *
 * pi-free and pure (no pi imports, no I/O): the built-in list is a curated
 * mirror of pi's BUILTIN_SLASH_COMMANDS (pi 1.1.0 — see pi docs
 * `slash-commands.md`; built-ins are not exported from the package root),
 * and the live resource commands (extension commands, prompt templates,
 * skills) arrive from `pi.getCommands()` at query time (see wiring.ts).
 *
 * Execution model (verified in pi's `agent-session.js` `prompt()`):
 * text dispatch via `sendUserMessage("/name args", { expandPromptTemplates })`
 * executes extension commands and expands templates/skills — but NEVER
 * built-ins (those run in the TUI layer). Mapped built-ins therefore route
 * onto pi-tg's existing bridge actions (the same paths /new, /compact,
 * /models… already use); unmapped built-ins are terminal-only.
 */
import type { TgAction } from "./router.ts";

/** Bridge action a mapped built-in dispatches to (see dispatchFor). */
export type MappedAction =
  | "new"
  | "compact"
  | "modelList"
  | "thinkingList"
  | "sessions"
  | "status"
  | "reload"
  | "nameSet"
  | "importSet"
  | "killAsk";

export interface BuiltinPiCommand {
  name: string;
  description: string;
  /** pi-tg bridge action; absent = terminal only (no extension-API equivalent). */
  map?: MappedAction;
}

/** The 24 built-ins of pi 1.1.0, in pi's command-menu order. */
export const BUILTIN_PI_COMMANDS: readonly BuiltinPiCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", map: "modelList" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level", map: "thinkingList" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file", map: "importSet" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name", map: "nameSet" },
  { name: "session", description: "Show session info and stats", map: "status" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session", map: "new" },
  { name: "compact", description: "Manually compact the session context", map: "compact" },
  { name: "resume", description: "Resume a different session", map: "sessions" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files", map: "reload" },
  { name: "quit", description: "Quit pi", map: "killAsk" },
];

/** A resource command as returned by `pi.getCommands()` (structural mirror). */
export interface ResourceCommand {
  name: string; // invocationName — may contain a colon (skill:x, tg:pair)
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface SessionCommand {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  terminalOnly: boolean;
}

/**
 * Built-ins (pi's menu order) + live resource commands. A resource whose
 * name collides with a built-in is dropped — pi itself renames colliding
 * extension commands at runtime (invocationName), so an exact clash means
 * stale data, and the built-in's mapping must win.
 */
export function mergeCommands(resources: ResourceCommand[]): SessionCommand[] {
  const out: SessionCommand[] = BUILTIN_PI_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    source: "builtin" as const,
    terminalOnly: !c.map,
  }));
  const names = new Set(out.map((c) => c.name));
  for (const r of resources) {
    if (names.has(r.name)) continue;
    names.add(r.name);
    out.push({ name: r.name, description: r.description ?? "", source: r.source, terminalOnly: false });
  }
  return out;
}

/**
 * Name = case-insensitive PREFIX (command-menu UX; substring would make
 * "cop" match scOPEd-models), description = substring. Leading slash(es)
 * are stripped (the prefilled input bar produces queries like `/mod`).
 * Empty query → the full list, same reference.
 */
export function filterCommands(list: SessionCommand[], query: string): SessionCommand[] {
  const q = query.replace(/^\/+/, "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) => c.name.toLowerCase().startsWith(q) || c.description.toLowerCase().includes(q),
  );
}

/** What happens when a session command is chosen (tap or typed). */
export type DispatchDecision =
  | { type: "action"; action: MappedAction; rest: string }
  | { type: "dispatch"; name: string; args: string }
  | { type: "terminal"; name: string };

/**
 * The TgAction a dispatch decision executes (shared by the typed-path
 * router fallback in index.ts and the bridge's runSessionCommand — one
 * place for the built-in → TG-action mapping).
 */
export function actionForDecision(d: DispatchDecision, chatId: number): TgAction | undefined {
  switch (d.type) {
    case "terminal":
      return { kind: "cmdTerminal", chatId, name: d.name };
    case "dispatch":
      return { kind: "cmdSend", chatId, name: d.name, args: d.args };
    case "action":
      switch (d.action) {
        case "new":
          return { kind: "new", chatId };
        case "compact":
          return { kind: "compact", chatId, ...(d.rest ? { instructions: d.rest } : {}) };
        case "modelList":
          return { kind: "modelList", chatId };
        case "thinkingList":
          return { kind: "thinkingList", chatId };
        case "sessions":
          return { kind: "sessions", chatId };
        case "status":
          return { kind: "status", chatId };
        case "reload":
          return { kind: "reload", chatId };
        case "nameSet":
          return { kind: "nameSet", chatId, name: d.rest };
        case "importSet":
          return { kind: "importSet", chatId, path: d.rest };
        case "killAsk":
          return { kind: "killAsk", chatId };
      }
  }
}

/**
 * Decide how `/<name> rest` executes. Unknown names → undefined (the caller
 * keeps its existing behavior — NEVER guess: an unknown name typed into the
 * input bar would fall through to the LLM as a prompt).
 */
export function dispatchFor(
  name: string,
  rest: string,
  table: SessionCommand[],
): DispatchDecision | undefined {
  const cmd = table.find((c) => c.name === name);
  if (!cmd) return undefined;
  if (cmd.source !== "builtin") return { type: "dispatch", name, args: rest };
  const map = BUILTIN_PI_COMMANDS.find((b) => b.name === name)?.map;
  if (!cmd.terminalOnly && map) return { type: "action", action: map, rest };
  return { type: "terminal", name };
}

/**
 * The picker entry button for the /help and /status cards. Pressing it
 * inserts `@bot /` into the input field and opens the inline search.
 * (Not supported in channel chats — the client simply hides the button.)
 */
export const PICKER_BUTTON: { inline_keyboard: { text: string; switch_inline_query_current_chat: string }[][] } =
  { inline_keyboard: [[{ text: "⌨️ Pi commands", switch_inline_query_current_chat: "/" }]] };

// Bot API limits for inline query results.
const MAX_RESULTS = 50;
const MAX_TITLE = 64;
const MAX_DESC = 70; // empirical cap on article descriptions
const MAX_TEXT = 4096;

const SOURCE_TAG: Record<Exclude<SessionCommand["source"], "builtin">, string> = {
  extension: "[ext]",
  prompt: "[tpl]",
  skill: "[skill]",
};

export interface InlineArticle {
  type: "article";
  id: string; // `c<nonce>` — the nonce is the pending-runs key (≤61 chars!)
  title: string;
  description?: string;
  input_message_content: { message_text: string }; // required: tap auto-sends this
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/**
/**
 * The auto-sent card text for a chosen command (Flow A) — the exact
 * `message_text` the article carries, so the bridge can stamp it (append ✅)
 * without re-deriving the truncation.
 */
export function cardText(name: string, description: string): string {
  const title = `/${name}`.slice(0, MAX_TITLE);
  return `📋 ${title} — ${description}`.slice(0, MAX_TEXT);
}

/**
 * Render (up to 50) session commands as inline-query articles.
 * TERMINAL-ONLY BUILT-INS ARE NOT LISTED — they are dead ends in the
 * autocomplete (no extension-API equivalent; a tap could only produce the
 * 🖥 explanation). The 50-cap applies AFTER that filter. Every listed
 * result carries the ▶ Run fallback button (the 2-tap path — works
 * without BotFather's inline feedback).
 * `makeNonce(name)` must return a UNIQUE nonce per result, ≤61 chars
 * (id = `c<nonce>` ≤ 64 bytes; callback_data = `cr:<nonce>` ≤ 64 bytes).
 * The auto-sent card (`input_message_content`) is the visible echo of a tap.
 */
export function toInlineResults(
  list: SessionCommand[],
  makeNonce: (name: string) => string,
): InlineArticle[] {
  return list.filter((c) => !c.terminalOnly).slice(0, MAX_RESULTS).map((c) => {
    const nonce = makeNonce(c.name);
    const title = `/${c.name}`.slice(0, MAX_TITLE);
    let desc = c.description;
    if (c.source !== "builtin") desc = `${desc} ${SOURCE_TAG[c.source]}`.trim();
    desc = desc.slice(0, MAX_DESC);
    const r: InlineArticle = {
      type: "article",
      id: `c${nonce}`,
      title,
      input_message_content: { message_text: cardText(c.name, c.description) },
      reply_markup: { inline_keyboard: [[{ text: "▶ Run", callback_data: `cr:${nonce}` }]] },
    };
    if (desc) r.description = desc;
    return r;
  });
}
