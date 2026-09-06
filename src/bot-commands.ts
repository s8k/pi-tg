/** The Telegram bot menu (setMyCommands) — the user-facing projection of the
 *  router's command vocabulary. Order is display order; constraints per the
 *  Bot API: command = 1–32 chars of a-z0-9_, description = 1–257 chars. */
export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: "status", description: "Session info" },
  { command: "new", description: "Start a new session" },
  { command: "sessions", description: "List & switch sessions" },
  { command: "name", description: "[session_name] Rename this session" },
  { command: "models", description: "Pick a model" },
  { command: "thinking", description: "Pick the thinking level" },
  { command: "stop", description: "Abort the current request" },
  { command: "level_mute", description: "Output level: mute — no agent output (commands still work)" },
  { command: "level_minimal", description: "Output level: minimal — visible text only (no tools, no thinking)" },
  { command: "level_full", description: "Output level: full — tool log + final answer (default)" },
  { command: "compact", description: "Compact the history" },
  { command: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { command: "kill", description: "Shut down pi" },
  { command: "help", description: "Show help info" },
];
