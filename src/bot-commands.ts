/** The Telegram bot menu (setMyCommands) — the user-facing projection of the
 *  router's command vocabulary. Order is display order; constraints per the
 *  Bot API: command = 1–32 chars of a-z0-9_, description = 1–257 chars. */
export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
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
];
