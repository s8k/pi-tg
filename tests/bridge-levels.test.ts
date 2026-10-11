import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpBlocks, PI_TG_VERSION } from "../src/session-bridge.ts";
import { BOT_COMMANDS } from "../src/bot-commands.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The bold command names of helpBlocks, in order. */
const helpCmds = (): string[] => {
  const cmds: string[] = [];
  for (const b of helpBlocks()) {
    if (b.type !== "paragraph") continue;
    const parts = Array.isArray(b.text) ? b.text : [b.text];
    for (const p of parts) {
      if (!Array.isArray(p) && typeof p !== "string" && p.type === "bold") cmds.push(String(p.text));
    }
  }
  return cmds.filter((c) => c.startsWith("/"));
};
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

test("level_mute: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_mute", chatId: 7 });
  assert.equal(deps.cfg.level, "mute");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔇 Level: mute — no agent output (commands still work).");
});

test("level_minimal: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_minimal", chatId: 7 });
  assert.equal(deps.cfg.level, "minimal");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔉 Level: minimal — visible text only (no tools, no thinking).");
});

test("level_full: sets cfg.level, persists, exact ack", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out, { level: "mute" });
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "level_full", chatId: 7 });
  assert.equal(deps.cfg.level, "full");
  assert.equal(persisted, 1);
  assert.equal(lastSend(out), "🔊 Level: full — tool log + final answer (default).");
});

test("old /mute /unmute are gone: they land on the unknown-command path", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  await new SessionBridge(deps).dispatch({ kind: "unknown", chatId: 7, text: "/mute" });
  assert.equal(lastSend(out), "Unknown command /mute — see /help");
});

test("help: command order mirrors the bot menu (BOT_COMMANDS) — status, stop up top; name after sessions", () => {
  const cmds = helpCmds();
  assert.deepEqual(cmds, [
    "/status", "/stop", "/new", "/sessions", "/name", "/models", "/thinking",
    "/level_mute", "/level_minimal", "/level_full", "/compact", "/reload", "/kill", "/help",
  ]);
});

test("help card is a projection of BOT_COMMANDS — menu and card can never drift (2026-10-11)", () => {
  // the card's command lines carry the menu's exact descriptions (the /help
  // entry is the one deliberate exception — it carries the picker-button line)
  const lines: string[] = [];
  for (const b of helpBlocks()) {
    if (b.type !== "paragraph") continue;
    const parts = (Array.isArray(b.text) ? b.text : [b.text]) as (string | { type: string; text: unknown })[];
    const cmd = parts.find((p) => typeof p === "object" && !Array.isArray(p) && p.type === "bold") as
      | { type: "bold"; text: unknown }
      | undefined;
    const desc = parts.filter((p): p is string => typeof p === "string").join("");
    if (cmd) lines.push(`${String(cmd.text)}${desc}`);
  }
  for (const { command, description } of BOT_COMMANDS) {
    if (command === "help") {
      assert.ok(lines.some((l) => l.startsWith("/help")), "the /help line exists");
      assert.ok(lines.some((l) => l.includes("browse, search, and run other Pi commands")), "the /help line mentions the picker");
      continue;
    }
    assert.ok(lines.includes(`/${command} — ${description}`), `missing or drifted: /${command} — ${description}`);
  }
});

test("help header carries the version stamp from package.json (npm-update visibility, 2026-10-11)", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  const header = helpBlocks()[0];
  assert.equal(header?.type, "paragraph");
  const parts = (Array.isArray(header?.text) ? header.text : [header?.text]) as (string | { type: string; text: unknown })[];
  const bold = parts.find(
    (p): p is { type: "bold"; text: unknown } => typeof p === "object" && !Array.isArray(p) && p.type === "bold",
  );
  assert.equal(String(bold?.text), "pi-tg", "the header starts with the bold pi-tg entity");
  const desc = parts.filter((p): p is string => typeof p === "string").join("");
  assert.ok(desc.includes(` v${pkg.version}`), `expected ' v${pkg.version}' in: ${desc}`);
  assert.equal(PI_TG_VERSION, pkg.version, "PI_TG_VERSION reads the same package.json");
});

test("help lists the three level commands, not /mute or /unmute", () => {
  const cmds = helpCmds();
  assert.ok(cmds.includes("/level_mute"), cmds.join(","));
  assert.ok(cmds.includes("/level_minimal"), cmds.join(","));
  assert.ok(cmds.includes("/level_full"), cmds.join(","));
  assert.ok(!cmds.includes("/mute"), cmds.join(","));
  assert.ok(!cmds.includes("/unmute"), cmds.join(","));
});

test("status card always shows the level suffix (all three levels)", async () => {
  const header = async (level: "mute" | "minimal" | "full"): Promise<string> => {
    const pi = new FakePi({ cwd: "/proj", messageCount: 3 });
    const out = new FakeOut();
    await new SessionBridge(makeDeps(pi.build(), out, { level })).dispatch({ kind: "status", chatId: 7 });
    return (out.calls.find((c) => c.kind === "sendRich")?.text ?? "").split("\n")[0]!;
  };
  assert.equal(await header("full"), "📌 Untitled session — idle · 🔊 full");
  assert.equal(await header("minimal"), "📌 Untitled session — idle · 🔉 minimal");
  assert.equal(await header("mute"), "📌 Untitled session — idle · 🔇 mute");
});
