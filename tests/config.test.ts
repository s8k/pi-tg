import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, getBotToken, loadConfig, sanitize, saveConfig } from "../src/config.ts";

function tempPath(): { opts: { path: string }; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "telega-cfg-"));
  const path = join(dir, "pi-telega.json");
  return { opts: { path }, path };
}

test("configPath: default under ~/.pi/agent, override honored", () => {
  assert.equal(configPath(), join(homedir(), ".pi", "agent", "pi-telega.json"));
  assert.equal(configPath({ path: "/x/y.json" }), "/x/y.json");
});

test("loadConfig: missing file → defaults", () => {
  const { opts } = tempPath();
  const cfg = loadConfig(opts);
  assert.equal(cfg.botToken, undefined);
  assert.equal(cfg.ownerId, undefined);
  assert.equal(cfg.streamEditMs, DEFAULTS.streamEditMs);
  assert.equal(cfg.askClearOnSwitch, true);
  assert.equal(cfg.maxSessionList, 20);
  assert.deepEqual(cfg.sentMessageIds, []);
  assert.equal(cfg.level, "full");
});

test("saveConfig/loadConfig round-trip", () => {
  const { opts } = tempPath();
  const cfg = { ...loadConfig(opts), botToken: "123:ABC", ownerId: 42, lastOffset: 999, sentMessageIds: [1, 2, 3] };
  saveConfig(cfg, opts);
  const back = loadConfig(opts);
  assert.equal(back.botToken, "123:ABC");
  assert.equal(back.ownerId, 42);
  assert.equal(back.lastOffset, 999);
  assert.deepEqual(back.sentMessageIds, [1, 2, 3]);
});

test("getBotToken: env override wins, blank env falls through", () => {
  const { opts } = tempPath();
  const cfg = { ...loadConfig(opts), botToken: "file-token" };
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGA_BOT_TOKEN: "env-token" } }), "env-token");
  assert.equal(getBotToken(cfg, { ...opts, env: {} }), "file-token");
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGA_BOT_TOKEN: "  " } }), "file-token");
});

test("loadConfig: corrupt JSON → defaults, no throw", () => {
  const { opts, path } = tempPath();
  writeFileSync(path, "{not json", "utf-8");
  assert.deepEqual(loadConfig(opts).sentMessageIds, []);
});

test("sanitize: sentMessageIds capped at 500 (newest kept) + deduped + invalid dropped", () => {
  const ids = Array.from({ length: 600 }, (_, i) => i + 1); // 1..600
  const cfg = sanitize({ sentMessageIds: [...ids, 600, "nope", -5] });
  assert.equal(cfg.sentMessageIds.length, 500);
  assert.equal(cfg.sentMessageIds[0], 101);   // oldest 1..100 dropped
  assert.equal(cfg.sentMessageIds[499], 600);  // newest kept
});

test("sanitize: level — valid value passthrough, default full", () => {
  assert.equal(sanitize({}).level, "full");
  assert.equal(sanitize({ level: "mute" }).level, "mute");
  assert.equal(sanitize({ level: "minimal" }).level, "minimal");
  assert.equal(sanitize({ level: "full" }).level, "full");
  assert.equal(DEFAULTS.level, "full");
});

test("sanitize: level — corrupt value falls back to legacy muted, then default (migration)", () => {
  assert.equal(sanitize({ level: "loud" }).level, "full");
  assert.equal(sanitize({ level: "loud", muted: true }).level, "mute");
  assert.equal(sanitize({ level: "loud", muted: false }).level, "full");
  assert.equal(sanitize({ level: "mute", muted: true }).level, "mute"); // valid level wins over legacy
  assert.equal(sanitize({ level: "minimal", muted: true }).level, "minimal");
  assert.equal(sanitize({ muted: true }).level, "mute");
  assert.equal(sanitize({ muted: false }).level, "full");
  assert.equal(sanitize({ muted: "yes" }).level, "full"); // legacy must be a strict boolean
});

test("sanitize: pendingAction.new keeps a valid ackMsgId, drops invalid ones (A7)", () => {
  assert.deepEqual(sanitize({ pendingAction: { type: "new", chatId: 7, ackMsgId: 42 } }).pendingAction, {
    type: "new",
    chatId: 7,
    ackMsgId: 42,
  });
  assert.deepEqual(sanitize({ pendingAction: { type: "new", chatId: 7, ackMsgId: "nope" } }).pendingAction, { type: "new", chatId: 7 });
  assert.deepEqual(sanitize({ pendingAction: { type: "new", chatId: 7, ackMsgId: -3 } }).pendingAction, { type: "new", chatId: 7 });
  assert.deepEqual(sanitize({ pendingAction: { type: "new", chatId: 7, ackMsgId: 2.5 } }).pendingAction, { type: "new", chatId: 7 });
});

test("sanitize: clamps and drops invalid fields", () => {
  const cfg = sanitize({
    streamEditMs: 10,        // below min → default
    maxSessionList: 999,     // above max → default
    askClearOnSwitch: "yes", // not a boolean → default
    ownerId: "42",           // not a number → undefined
    botToken: "",            // empty → undefined
    pendingAction: { type: "activate", chatId: 7 }, // missing path → undefined
  });
  assert.equal(cfg.streamEditMs, DEFAULTS.streamEditMs);
  assert.equal(cfg.maxSessionList, DEFAULTS.maxSessionList);
  assert.equal(cfg.askClearOnSwitch, DEFAULTS.askClearOnSwitch);
  assert.equal(cfg.ownerId, undefined);
  assert.equal(cfg.botToken, undefined);
  assert.equal(cfg.pendingAction, undefined);
  const ok = sanitize({ pendingAction: { type: "activate", chatId: 7, path: "C:/x/s.jsonl" } });
  assert.deepEqual(ok.pendingAction, { type: "activate", chatId: 7, path: "C:/x/s.jsonl" });
  const rl = sanitize({ pendingAction: { type: "reload", chatId: 7 } });
  assert.deepEqual(rl.pendingAction, { type: "reload", chatId: 7 });
  assert.equal(sanitize({ pendingAction: { type: "bogus", chatId: 7 } }).pendingAction, undefined);
});

test("sanitize: draftHeartbeatMs default 17000, valid 5000..25000 kept, out-of-range → default", () => {
  assert.equal(sanitize({}).draftHeartbeatMs, 17000);
  assert.equal(sanitize({ draftHeartbeatMs: 6000 }).draftHeartbeatMs, 6000);
  assert.equal(sanitize({ draftHeartbeatMs: 1000 }).draftHeartbeatMs, 17000); // below min → default
  assert.equal(sanitize({ draftHeartbeatMs: 99_999 }).draftHeartbeatMs, 17000); // above max → default
});

test("sanitize: codeFoldLines default 25, valid 5..500 kept, out-of-range → default", () => {
  assert.equal(sanitize({}).codeFoldLines, 25);
  assert.equal(sanitize({ codeFoldLines: 40 }).codeFoldLines, 40);
  assert.equal(sanitize({ codeFoldLines: 2 }).codeFoldLines, 25); // below min → default
  assert.equal(sanitize({ codeFoldLines: "x" }).codeFoldLines, 25); // not a number → default
});
