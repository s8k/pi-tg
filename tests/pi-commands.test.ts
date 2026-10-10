import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PI_COMMANDS,
  mergeCommands,
  filterCommands,
  dispatchFor,
  toInlineResults,
} from "../src/pi-commands.ts";
import type { ResourceCommand, SessionCommand } from "../src/pi-commands.ts";

// ── built-in table ──

test("BUILTIN_PI_COMMANDS: the 24 built-ins of pi 1.1.0, in pi's menu order", () => {
  assert.deepEqual(
    BUILTIN_PI_COMMANDS.map((c) => c.name),
    [
      "settings", "model", "tree", "thinking", "scoped-models", "export",
      "import", "share", "bug", "copy", "name", "session", "changelog",
      "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
      "compact", "resume", "reload", "quit",
    ],
  );
  for (const c of BUILTIN_PI_COMMANDS) assert.ok(c.description.length > 0);
});

test("BUILTIN_PI_COMMANDS: exactly these 10 map to pi-tg actions", () => {
  const mapped = Object.fromEntries(
    BUILTIN_PI_COMMANDS.filter((c) => c.map).map((c) => [c.name, c.map]),
  );
  assert.deepEqual(mapped, {
    model: "modelList",
    thinking: "thinkingList",
    session: "status",
    resume: "sessions",
    new: "new",
    compact: "compact",
    name: "nameSet",
    import: "importSet",
    reload: "reload",
    quit: "killAsk",
  });
});

test("BUILTIN_PI_COMMANDS: the other 14 are terminal-only (no map)", () => {
  const terminal = BUILTIN_PI_COMMANDS.filter((c) => !c.map).map((c) => c.name);
  assert.deepEqual(terminal, [
    "settings", "tree", "scoped-models", "export", "share", "bug", "copy",
    "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout",
  ]);
});

// ── merge ──

const resources: ResourceCommand[] = [
  { name: "tg", description: "Show session card", source: "extension" },
  { name: "tg:pair", description: "Show pairing QR", source: "extension" },
  { name: "my-template", description: "Do the thing", source: "prompt" },
  { name: "skill:brainstorming", description: "Brainstorm", source: "skill" },
];

test("mergeCommands: no resources → the 24 built-ins, source builtin", () => {
  const list = mergeCommands([]);
  assert.equal(list.length, 24);
  assert.ok(list.every((c) => c.source === "builtin"));
});

test("mergeCommands: resources appended after built-ins, flags intact", () => {
  const list = mergeCommands(resources);
  assert.equal(list.length, 28);
  const tg = list.find((c) => c.name === "tg");
  assert.deepEqual(tg, { name: "tg", description: "Show session card", source: "extension", terminalOnly: false });
  const skill = list.find((c) => c.name === "skill:brainstorming");
  assert.equal(skill?.source, "skill");
  // built-ins are never terminalOnly=false-without-map confusion: spot-check
  assert.equal(list.find((c) => c.name === "model")?.terminalOnly, false);
  assert.equal(list.find((c) => c.name === "tree")?.terminalOnly, true);
});

test("mergeCommands: a resource whose name collides with a built-in is dropped (pi renames it at runtime)", () => {
  const list = mergeCommands([...resources, { name: "model", description: "x", source: "extension" }]);
  assert.equal(list.length, 28); // the collision did not add an entry
  assert.equal(list.find((c) => c.name === "model")?.source, "builtin");
});

test("mergeCommands: resource without description gets an empty one (never undefined)", () => {
  const list = mergeCommands([{ name: "bare", source: "extension" }]);
  assert.equal(list.find((c) => c.name === "bare")?.description, "");
});

// ── filter ──

test("filterCommands: empty query → full list, unchanged order", () => {
  const list = mergeCommands(resources);
  assert.deepEqual(filterCommands(list, ""), list);
  assert.deepEqual(filterCommands(list, "/"), list);
});

test("filterCommands: leading slash(es) stripped, name match", () => {
  const list = mergeCommands(resources);
  assert.deepEqual(filterCommands(list, "/cop").map((c) => c.name), ["copy"]);
  assert.deepEqual(filterCommands(list, "//skill:").map((c) => c.name), ["skill:brainstorming"]);
  assert.ok(filterCommands(list, "/mod").some((c) => c.name === "model")); // substring: also scoped-models ("models")
});

test("filterCommands: case-insensitive match on name or description", () => {
  const list = mergeCommands(resources);
  assert.ok(filterCommands(list, "PAIR").some((c) => c.name === "tg:pair"));
  assert.ok(filterCommands(list, "session card").some((c) => c.name === "tg"));
  assert.deepEqual(filterCommands(list, "zzz-no-match"), []);
});

// ── dispatch decision ──

const table = mergeCommands(resources);

test("dispatchFor: mapped built-ins → their action, rest carried", () => {
  assert.deepEqual(dispatchFor("model", "", table), { type: "action", action: "modelList", rest: "" });
  assert.deepEqual(dispatchFor("quit", "", table), { type: "action", action: "killAsk", rest: "" });
  assert.deepEqual(dispatchFor("name", "my name", table), { type: "action", action: "nameSet", rest: "my name" });
  assert.deepEqual(dispatchFor("import", "/tmp/s.jsonl", table), { type: "action", action: "importSet", rest: "/tmp/s.jsonl" });
  assert.deepEqual(dispatchFor("compact", "keep tests", table), { type: "action", action: "compact", rest: "keep tests" });
});

test("dispatchFor: terminal-only built-ins → terminal", () => {
  assert.deepEqual(dispatchFor("tree", "", table), { type: "terminal", name: "tree" });
  assert.deepEqual(dispatchFor("login", "", table), { type: "terminal", name: "login" });
});

test("dispatchFor: any resource command → dispatch with args", () => {
  assert.deepEqual(dispatchFor("tg", "", table), { type: "dispatch", name: "tg", args: "" });
  assert.deepEqual(dispatchFor("my-template", "arg1 arg2", table), { type: "dispatch", name: "my-template", args: "arg1 arg2" });
  assert.deepEqual(dispatchFor("skill:brainstorming", "x", table), { type: "dispatch", name: "skill:brainstorming", args: "x" });
});

test("dispatchFor: unknown name → undefined (never dispatch a guess)", () => {
  assert.equal(dispatchFor("definitely-not-a-command", "", table), undefined);
});

// ── inline result payloads ──

test("toInlineResults: capped at 50 results (cap applies AFTER the terminal-only filter)", () => {
  const many: SessionCommand[] = [
    // 5 terminal-only entries that would push a naive slice past the cap
    ...Array.from({ length: 5 }, (_, i) => ({
      name: `term${i}`, description: "d", source: "builtin" as const, terminalOnly: true,
    })),
    ...Array.from({ length: 80 }, (_, i) => ({
      name: `cmd${i}`, description: "d", source: "extension" as const, terminalOnly: false,
    })),
  ];
  const res = toInlineResults(many, (n) => `n${n.length}`);
  assert.equal(res.length, 50);
  assert.ok(!res.some((r) => r.title.startsWith("/term")), "no terminal-only in the results");
});

test("toInlineResults: terminal-only built-ins are NOT listed (dead ends in the autocomplete)", () => {
  const res = toInlineResults(
    [
      { name: "model", description: "Select model", source: "builtin", terminalOnly: false },
      { name: "tree", description: "Navigate session tree", source: "builtin", terminalOnly: true },
      { name: "login", description: "Configure provider auth", source: "builtin", terminalOnly: true },
    ],
    () => "ab12cd",
  );
  assert.deepEqual(res.map((r) => r.title), ["/model"]);
});

test("toInlineResults: article shape — id c<nonce> ≤64 bytes, title /name, required input_message_content", () => {
  const seen: string[] = [];
  const res = toInlineResults(
    [{ name: "compact", description: "Compact the context", source: "builtin", terminalOnly: false }],
    (n) => { seen.push(n); return "ab12cd"; },
  );
  assert.deepEqual(seen, ["compact"]);
  assert.equal(res.length, 1);
  const r = res[0];
  assert.equal(r.type, "article");
  assert.equal(r.id, "cab12cd");
  assert.ok(Buffer.byteLength(r.id) <= 64);
  assert.equal(r.title, "/compact");
  assert.equal(r.input_message_content.message_text, "📋 /compact — Compact the context");
  assert.ok(r.description && r.description.length <= 70);
});

test("toInlineResults: every listed result carries the ▶ Run button (cr:<nonce>)", () => {
  const res = toInlineResults(
    [
      { name: "model", description: "Select model", source: "builtin", terminalOnly: false },
      { name: "tg", description: "Show session card", source: "extension", terminalOnly: false },
    ],
    () => "zz99yy",
  );
  for (const r of res) {
    assert.equal(r.reply_markup?.inline_keyboard[0][0].callback_data, "cr:zz99yy");
    assert.ok(r.reply_markup?.inline_keyboard[0][0].text.includes("Run"));
  }
});

test("toInlineResults: resource description gets a source tag (no 🖥 note — those are not listed)", () => {
  const res = toInlineResults(
    [
      { name: "tg", description: "Show session card", source: "extension", terminalOnly: false },
      { name: "my-tpl", description: "Review code", source: "prompt", terminalOnly: false },
    ],
    () => "q1w2e3",
  );
  assert.ok(res[0].description?.includes("[ext]"));
  assert.ok(res[1].description?.includes("[tpl]"));
  assert.ok(!res.some((r) => r.description?.includes("terminal only")));
});

test("toInlineResults: long names truncate the title to 64 chars, id stays ≤64 bytes", () => {
  const long = "skill:" + "x".repeat(120);
  const res = toInlineResults(
    [{ name: long, description: "", source: "skill", terminalOnly: false }],
    () => "ab12cd",
  );
  assert.ok(res[0].title.length <= 64);
  assert.ok(Buffer.byteLength(res[0].id) <= 64);
  assert.ok(Buffer.byteLength(res[0].input_message_content.message_text) <= 4096);
});

// ── actionForDecision: decision → TgAction (shared by index + bridge) ──

import { actionForDecision, type DispatchDecision } from "../src/pi-commands.ts";

test("actionForDecision: mapped built-ins → their TG actions", () => {
  const table = mergeCommands([]);
  const d = (name: string, rest = ""): DispatchDecision => dispatchFor(name, rest, table)!;
  assert.deepEqual(actionForDecision(d("model"), 9), { kind: "modelList", chatId: 9 });
  assert.deepEqual(actionForDecision(d("name", "My Session"), 9), { kind: "nameSet", chatId: 9, name: "My Session" });
  assert.deepEqual(actionForDecision(d("import", "/tmp/s.jsonl"), 9), { kind: "importSet", chatId: 9, path: "/tmp/s.jsonl" });
  assert.deepEqual(actionForDecision(d("compact", "keep tests"), 9), { kind: "compact", chatId: 9, instructions: "keep tests" });
  assert.deepEqual(actionForDecision(d("compact"), 9), { kind: "compact", chatId: 9 });
  assert.deepEqual(actionForDecision(d("quit"), 9), { kind: "killAsk", chatId: 9 });
  assert.deepEqual(actionForDecision(d("new"), 9), { kind: "new", chatId: 9 });
  assert.deepEqual(actionForDecision(d("thinking"), 9), { kind: "thinkingList", chatId: 9 });
  assert.deepEqual(actionForDecision(d("session"), 9), { kind: "status", chatId: 9 });
  assert.deepEqual(actionForDecision(d("resume"), 9), { kind: "sessions", chatId: 9 });
  assert.deepEqual(actionForDecision(d("reload"), 9), { kind: "reload", chatId: 9 });
});

test("actionForDecision: resource → cmdSend; terminal → cmdTerminal", () => {
  const table = mergeCommands([{ name: "skill:x", description: "d", source: "skill" }]);
  assert.deepEqual(actionForDecision(dispatchFor("skill:x", "go", table)!, 9), { kind: "cmdSend", chatId: 9, name: "skill:x", args: "go" });
  assert.deepEqual(actionForDecision(dispatchFor("tree", "", table)!, 9), { kind: "cmdTerminal", chatId: 9, name: "tree" });
});
