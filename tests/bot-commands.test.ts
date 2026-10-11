import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_COMMANDS } from "../src/bot-commands.ts";

test("BOT_COMMANDS: exact 14-command menu, in display order", () => {
  assert.deepEqual(BOT_COMMANDS, [
    { command: "status", description: "Session info" },
    { command: "stop", description: "Stop the current turn" },
    { command: "new", description: "Start a new session" },
    { command: "sessions", description: "List & switch sessions" },
    { command: "name", description: "[session_name] Rename this session" },
    { command: "models", description: "Pick a model" },
    { command: "thinking", description: "Set the reasoning level (off → high)" },
    { command: "level_mute", description: "Output: mute — no agent output (commands still work)" },
    { command: "level_minimal", description: "Output: minimal — visible text only (no tools, no thinking)" },
    { command: "level_full", description: "Output: full — tool log + final answer (default)" },
    { command: "compact", description: "Compact the context (stoppable via the Stop button)" },
    { command: "reload", description: "Reload extensions & resources (idle only)" },
    { command: "kill", description: "Shut down pi" },
    { command: "help", description: "Shows bot commands + a button to browse, search, and run other Pi commands" },
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
