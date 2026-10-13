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
  /** The direct bot command this built-in duplicates — such built-ins are
   * NOT listed in the inline picker (the user has it one keystroke away in
   * chat). Still dispatchable: the typed-path router and the run-as-typed
   * window keep the FULL table. */
  duplicateOf?: string;
}

/** The 24 built-ins of pi 1.1.0, in pi's command-menu order.
 *
 * Picker exclusion (approved 2026-10-09):
 * - List A — the 10 mapped built-ins (duplicateOf) + the tg* bridge
 *   commands: available directly in chat → not listed (PICKER_DUPLICATES).
 * - List B — TUI-only, make no sense via chatbot: settings, tree,
 *   scoped-models, hotkeys, copy, trust, bug, changelog, login, logout.
 * - List C — bridgeable later (pi's RPC supports them, no bridge action
 *   yet): fork, clone, export, share.
 * B and C are the 14 terminalOnly built-ins — hidden from the picker.
 */
export const BUILTIN_PI_COMMANDS: readonly BuiltinPiCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", map: "modelList", duplicateOf: "/models" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level", map: "thinkingList", duplicateOf: "/thinking" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file", map: "importSet", duplicateOf: "/import" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name", map: "nameSet", duplicateOf: "/name" },
  { name: "session", description: "Show session info and stats", map: "status", duplicateOf: "/status" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session", map: "new", duplicateOf: "/new" },
  { name: "compact", description: "Manually compact the session context", map: "compact", duplicateOf: "/compact" },
  { name: "resume", description: "Resume a different session", map: "sessions", duplicateOf: "/sessions" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files", map: "reload", duplicateOf: "/reload" },
  { name: "quit", description: "Quit Pi", map: "killAsk", duplicateOf: "/kill" },
];

/** pi-tg's own bridge commands (registered in index.ts — keep in sync with
 * the registerCommand calls). They are directly typeable in chat (the router
 * fallback dispatches them) and documented in /help, so the picker omits them. */
export const TG_BRIDGE_COMMANDS: readonly string[] = ["tg", "tg:config", "tg:pair", "tg:unpair"];

/** Every command the inline picker must NOT list (List A, approved): the
 * built-ins that duplicate a direct bot command + the tg* bridge commands.
 * The picker's run-as-typed window is NOT filtered by this — the table there
 * stays full, so typing a duplicate with args still executes. */
export const PICKER_DUPLICATES: ReadonlySet<string> = new Set([
  ...TG_BRIDGE_COMMANDS,
  ...BUILTIN_PI_COMMANDS.filter((b) => b.duplicateOf).map((b) => b.name),
]);

/** Whether a command may appear in the picker LIST (terminal-only built-ins
 * and List-A duplicates are excluded). Exported so the caller can pre-filter
 * its table — the rendered results stay 1:1 aligned with the pre-filtered
 * list (the nonce→name registration depends on that alignment). */
export function isListable(c: SessionCommand): boolean {
  return !c.terminalOnly && !PICKER_DUPLICATES.has(c.name);
}

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
  // case-insensitive: the command menu is case-insensitive, so "Model"/
  // "MODEL" are the same command as "model" — never list a name twice
  const names = new Set(out.map((c) => c.name.toLowerCase()));
  for (const r of resources) {
    if (names.has(r.name.toLowerCase())) continue;
    names.add(r.name.toLowerCase());
    out.push({ name: r.name, description: r.description ?? "", source: r.source, terminalOnly: false });
  }
  return out;
}

/**
 * The query is the COMMAND being typed after the bot name: "@bot /m" must
 * return the "/m*" commands — case-insensitive name PREFIX only (no
 * description matching: "m" is a letter inside dozens of descriptions, and
 * substring names would make "cop" match scOPEd-models). Leading slash(es)
 * are stripped (the prefilled input bar produces queries like `/mod`).
 * A query containing a space is NOT a name search — `customCommandMatch`
 * owns that mode ("<command> <args>"). Empty query → the full list.
 */
export function filterCommands(list: SessionCommand[], query: string): SessionCommand[] {
  const q = query.replace(/^\/+/, "").trim().toLowerCase();
  if (!q) return list;
  if (q.includes(" ")) return [];
  return list.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * The "run as typed" match (requirement: type a command, keep typing its
 * arguments, and the FULL text shows up as a single result to send): the
 * query contains a space and the part before the first space EXACTLY matches
 * a command name (case-insensitive). `text` is the complete command with
 * arguments, as typed (leading slash normalized to one) — it becomes the
 * article's auto-sent `message_text`, so tapping posts it to the chat and
 * the router executes it exactly like a typed message.
 * Null when: no space, or unknown command. (No length check — the client's
 * input window caps the typed text at 255 chars, and toCustomResult carries
 * the at-limit warning.)
 */
export function customCommandMatch(
  table: SessionCommand[],
  query: string,
): { entry: SessionCommand; text: string } | null {
  // trimStart only: the TRAILING space is the signal that the user started
  // typing arguments ("/mcp " → the single run-as-typed entry for /mcp)
  const q = query.replace(/^\/+/, "").trimStart();
  const sp = q.indexOf(" ");
  if (sp < 0) return null;
  const name = q.slice(0, sp).toLowerCase();
  const entry = table.find((c) => c.name.toLowerCase() === name);
  if (!entry) return null;
  // NOTE: no length check here — over-limit text is rendered with a warning
  // (toCustomResult); the item is never dropped while the user is typing.
  return { entry, text: `/${q}`.trimEnd() };
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
 * The picker entry button for the /help card (removed from /status
 * 2026-10-11 — the help card is its only home). Pressing it inserts `@bot /`
 * into the input field and opens the inline search. (Not supported in
 * channel chats — the client simply hides the button.)
 */
export const PICKER_BUTTON: { inline_keyboard: { text: string; switch_inline_query_current_chat: string }[][] } =
  { inline_keyboard: [[{ text: "⌨️ Other Pi commands", switch_inline_query_current_chat: "/" }]] };

// Bot API limits for inline query results.
const MAX_RESULTS = 50;
const MAX_TITLE = 64;
const MAX_DESC = 70; // empirical cap on article descriptions

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
}

/**
/**
 * The auto-sent card text for a chosen command (Flow A): the bare
 * executable command (`/name`) — no emoji, no description. This is what
 * Telegram auto-sends on a tap, so the chat history reads exactly as if the
 * command had been typed. The bridge stamps it (appends ✅) via this same
 * function, so the stamp never re-derives the truncation.
 */
export function cardText(name: string): string {
  return `/${name}`.slice(0, MAX_TITLE);
}

/**
 * Render (up to 50) session commands as inline-query articles.
 * TERMINAL-ONLY BUILT-INS ARE NOT LISTED — they are dead ends in the
 * autocomplete (no extension-API equivalent; a tap could only produce the
 * 🖥 explanation). The 50-cap applies AFTER that filter.
 * `makeNonce(name)` must return a UNIQUE nonce per result, ≤61 chars
 * (id = `c<nonce>` ≤ 64 bytes).
 * The auto-sent card (`input_message_content`) is the visible echo of a tap.
 *
 * `query` (the raw inline query): when it EXACTLY matches a result's name
 * (case-insensitive) that item's description is replaced by the keep-typing
 * hint — clients strip the trailing space, so "command+space" arrives as the
 * bare name, and that exact match is the moment the user has finished
 * typing the command and can start its arguments.
 */
export function toInlineResults(
  list: SessionCommand[],
  makeNonce: (name: string) => string,
  query?: string,
): InlineArticle[] {
  const q = query ? query.replace(/^\/+/, "").trim().toLowerCase() : "";
  // terminal-only built-ins (List B/C) and direct-bot-command duplicates
  // (List A) are dead ends in the autocomplete — never listed.
  return list.filter(isListable).slice(0, MAX_RESULTS).map((c) => {
    const nonce = makeNonce(c.name);
    const title = `/${c.name}`.slice(0, MAX_TITLE);
    let desc: string;
    if (q && c.name.toLowerCase() === q) {
      desc = RUNAS_HINT;
    } else {
      desc = c.description;
      if (c.source !== "builtin") desc = `${desc} ${SOURCE_TAG[c.source]}`.trim();
    }
    desc = desc.slice(0, MAX_DESC);
    const r: InlineArticle = {
      type: "article",
      id: `c${nonce}`,
      title,
      input_message_content: { message_text: cardText(c.name) },
    };
    if (desc) r.description = desc;
    return r;
  });
}

/** Observed client-side title cap for the run-as-typed item (255 chars —
 * the live docs state no API cap for article titles; beyond this the client
 * shows nothing new, so we ellipsize). */
const RUNAS_TITLE_LIMIT = 255;
/** Hint shown while the user is still typing (the command part matches
 * exactly — they can keep typing arguments/prompt to this command). Tap is
 * the only reliable send: clients don't consistently send on Enter while an
 * inline result is highlighted. */
/** Hint shown while the user is still typing (the command part matches
 * exactly — they can keep typing arguments/prompt to this command). Tap is
 * the only reliable send: clients don't consistently send on Enter while an
 * inline result is highlighted. */
const RUNAS_HINT = "Keep typing arguments or a prompt, then tap to send";
/** The client's inline-mode input window caps the typed text at 255 chars —
 * message_text can never exceed this through the picker, so this is the
 * practical (and only reachable) length limit for the run-as-typed item. */
const RUNAS_INPUT_LIMIT = 255;
/** Shown instead of the hint once the typed text REACHES the 255-char
 * input cap — the user physically cannot type more, so tell them the
 * command is cut off by the input window. */
const RUNAS_AT_LIMIT = "⚠️ 255-char input limit reached — shorten before sending";

/**
 * Render the single "run as typed" result (customCommandMatch). Unlike the
 * list results: the id is `t<nonce>` — the router's chosen_inline_result
 * handler only maps `c<nonce>`, so the tap's chosen update is IGNORED and
 * execution happens exactly once, via the auto-sent `message_text` (the full
 * command with arguments), which the router handles like a typed message.
 * No ▶ Run button: the tap itself is the execution.
 *
 * message_text: ALWAYS the full typed text — the input window caps it at
 * RUNAS_INPUT_LIMIT (255), so it is never truncated here. description: the
 * keep-typing hint, replaced by the at-limit warning once the text reaches
 * 255 chars (nothing more can be typed). title: the typed text, ellipsized
 * at RUNAS_TITLE_LIMIT — the ellipsis REPLACES the last characters (kept as
 * a guard; unreachable while the input cap holds).
 */
export function toCustomResult(
  match: { entry: SessionCommand; text: string },
  makeNonce: () => string,
): InlineArticle {
  const { text } = match;
  const atLimit = text.length >= RUNAS_INPUT_LIMIT;
  const title =
    text.length > RUNAS_TITLE_LIMIT ? text.slice(0, RUNAS_TITLE_LIMIT - 1) + "…" : text;
  const description = (atLimit ? RUNAS_AT_LIMIT : RUNAS_HINT).slice(0, MAX_DESC);
  return {
    type: "article",
    id: `t${makeNonce()}`,
    title,
    description,
    input_message_content: { message_text: text },
  };
}
