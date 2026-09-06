import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText } from "../src/session-bridge.ts";
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

test("help lists the three level commands, not /mute or /unmute", () => {
  const h = helpText();
  assert.ok(h.includes("/level_mute"), h);
  assert.ok(h.includes("/level_minimal"), h);
  assert.ok(h.includes("/level_full"), h);
  assert.ok(!h.includes("/mute"), h);
  assert.ok(!h.includes("/unmute"), h);
});

test("status card always shows the level suffix (all three levels)", async () => {
  const header = async (level: "mute" | "minimal" | "full"): Promise<string> => {
    const pi = new FakePi({ cwd: "/proj", messageCount: 3 });
    const out = new FakeOut();
    await new SessionBridge(makeDeps(pi.build(), out, { level })).dispatch({ kind: "status", chatId: 7 });
    return (out.calls.find((c) => c.kind === "send")?.text ?? "").split("\n")[0]!;
  };
  assert.equal(await header("full"), "📌 Untitled session — idle · 🔊 full");
  assert.equal(await header("minimal"), "📌 Untitled session — idle · 🔉 minimal");
  assert.equal(await header("mute"), "📌 Untitled session — idle · 🔇 mute");
});
