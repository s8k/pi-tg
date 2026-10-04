import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpBlocks } from "../src/session-bridge.ts";

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

test("help: command order — status, stop, compact up top; name right after sessions", () => {
  const cmds = helpCmds();
  assert.deepEqual(cmds, [
    "/status", "/stop", "/compact", "/new", "/sessions", "/name <text>", "/models", "/thinking",
    "/level_mute", "/level_minimal", "/level_full", "/reload", "/kill", "/help",
  ]);
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
