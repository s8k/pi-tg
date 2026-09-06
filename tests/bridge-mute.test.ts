import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBridge, helpText } from "../src/session-bridge.ts";
import { FakeOut, FakePi } from "./fake-pi.ts";
import { makeDeps, lastSend } from "./helpers.ts";

test("mute: sets cfg.muted, persists, confirms with 🔇 + /unmute hint", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out);
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "mute", chatId: 7 });
  assert.equal(deps.cfg.level, "mute");
  assert.equal(persisted, 1);
  assert.ok(lastSend(out).includes("🔇"));
  assert.ok(lastSend(out).includes("/unmute"));
});

test("unmute: clears cfg.muted, persists, confirms with 🔊", async () => {
  const out = new FakeOut();
  const deps = makeDeps(new FakePi().build(), out, { level: "mute" });
  let persisted = 0;
  deps.persist = async () => { persisted++; };
  await new SessionBridge(deps).dispatch({ kind: "unmute", chatId: 7 });
  assert.equal(deps.cfg.level, "full");
  assert.equal(persisted, 1);
  assert.ok(lastSend(out).includes("🔊"));
});

test("help lists /mute and /unmute", () => {
  assert.ok(helpText().includes("/mute"));
  assert.ok(helpText().includes("/unmute"));
});

test("status shows muted flag while muted", async () => {
  const pi = new FakePi({ cwd: "/proj", messageCount: 3 });
  const out = new FakeOut();
  await new SessionBridge(makeDeps(pi.build(), out, { level: "mute" })).dispatch({ kind: "status", chatId: 7 });
  assert.ok(lastSend(out).includes("muted"));
});
