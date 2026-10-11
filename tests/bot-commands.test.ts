import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_COMMANDS } from "../src/bot-commands.ts";

test("BOT_COMMANDS: exact 14-command menu, in display order", () => {
  assert.deepEqual(BOT_COMMANDS, [
    { command: "status", description: "Session info" },
    { command: "new", description: "Start a new session" },
    { command: "sessions", description: "List & switch sessions" },
    { command: "name", description: "[session_name] Rename this session" },
    { command: "models", description: "Pick a model" },
    { command: "thinking", description: "Pick the thinking level" },
    { command: "stop", description: "Stop the current request" },
    { command: "level_mute", description: "Output level: mute — no agent output (commands still work)" },
    { command: "level_minimal", description: "Output level: minimal — visible text only (no tools, no thinking)" },
    { command: "level_full", description: "Output level: full — tool log + final answer (default)" },
    { command: "compact", description: "Compact the history" },
    { command: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
    { command: "kill", description: "Shut down pi" },
    { command: "help", description: "Show help info" },
  ]);
});

test("BOT_COMMANDS: every entry satisfies the Bot API constraints", () => {
  assert.equal(BOT_COMMANDS.length, 14);
  const seen = new Set<string>();
  for (const { command, description } of BOT_COMMANDS) {
    assert.match(command, /^[a-z0-9_]{1,32}$/);
    assert.ok(description.length >= 1 && description.length <= 257, `bad description length for /${command}`);
    assert.ok(!seen.has(command), `duplicate command: ${command}`);
    seen.add(command);
  }
});
