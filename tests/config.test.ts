import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, getBotToken, loadConfig, sanitize, saveConfig } from "../src/config.ts";

function tempPath(): { opts: { path: string }; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-tg-cfg-"));
  const path = join(dir, "pi-telegram.json");
  return { opts: { path }, path };
}

test("configPath: default under ~/.pi/agent, override honored", () => {
  assert.equal(configPath(), join(homedir(), ".pi", "agent", "pi-telegram.json"));
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
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGRAM_BOT_TOKEN: "env-token" } }), "env-token");
  assert.equal(getBotToken(cfg, { ...opts, env: {} }), "file-token");
  assert.equal(getBotToken(cfg, { ...opts, env: { PI_TELEGRAM_BOT_TOKEN: "  " } }), "file-token");
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

test("sanitize: mirrorDialogs — default true, explicit false kept, garbage → default", () => {
  assert.equal(sanitize({}).mirrorDialogs, true);
  assert.equal(sanitize({ mirrorDialogs: false }).mirrorDialogs, false);
  assert.equal(sanitize({ mirrorDialogs: "nope" }).mirrorDialogs, true);
  assert.equal(DEFAULTS.mirrorDialogs, true);
});

test("saveConfig/loadConfig round-trip: ownerChatId persists", () => {
  const { opts } = tempPath();
  const cfg = { ...loadConfig(opts), ownerId: 42, ownerChatId: 777 };
  saveConfig(cfg, opts);
  const back = loadConfig(opts);
  assert.equal(back.ownerChatId, 777);
  assert.equal(back.ownerId, 42);
});

test("loadConfig: malformed ownerChatId → undefined", () => {
  const { opts, path } = tempPath();
  writeFileSync(path, JSON.stringify({ ownerChatId: "chat" }), "utf-8");
  assert.equal(loadConfig(opts).ownerChatId, undefined);
});

test("configPath: agentDir override is honored (pi's agent dir, PI_CODING_AGENT_DIR)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tg-cfg-"));
  assert.equal(configPath({ agentDir: dir }), join(dir, "pi-telegram.json"));
  assert.equal(configPath({ path: "/x/y.json", agentDir: dir }), "/x/y.json", "explicit path still wins");
});

// ── one-time migration from the legacy `pi-telega.json` filename ───────────

function withFakeHome(home: string, fn: () => void): void {
  const oldUp = process.env.USERPROFILE;
  const oldHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    fn();
  } finally {
    if (oldUp === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUp;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

test("configPath: migrates a legacy pi-telega.json to pi-telegram.json (content preserved, legacy removed)", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tg-migrate-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const legacy = join(agentDir, "pi-telega.json");
  writeFileSync(legacy, '{"ownerId": 7, "level": "full"}', "utf-8");
  withFakeHome(home, () => {
    const p = configPath();
    assert.equal(p, join(agentDir, "pi-telegram.json"), "default path is the new name");
    assert.ok(existsSync(p), "the fresh file exists after configPath()");
    assert.equal(readFileSync(p, "utf-8"), '{"ownerId": 7, "level": "full"}', "content preserved");
    assert.ok(!existsSync(legacy), "legacy file removed");
  });
});

test("configPath: an existing fresh file is never clobbered by the legacy one", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tg-migrate-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-telegram.json"), '{"ownerId": 99}', "utf-8");
  writeFileSync(join(agentDir, "pi-telega.json"), '{"ownerId": 1}', "utf-8");
  withFakeHome(home, () => {
    const p = configPath();
    assert.equal(readFileSync(p, "utf-8"), '{"ownerId": 99}', "fresh file wins");
    assert.ok(existsSync(join(agentDir, "pi-telega.json")), "legacy left in place when fresh exists");
  });
});

test("configPath: an explicit override path is returned as-is (no migration side effects)", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tg-migrate-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-telega.json"), '{"ownerId": 1}', "utf-8");
  withFakeHome(home, () => {
    assert.equal(configPath({ path: "/x/y.json" }), "/x/y.json");
    assert.ok(existsSync(join(agentDir, "pi-telega.json")), "override does not trigger migration");
  });
});

test("sanitize: seenUpdateIds capped at 200 (newest kept) + deduped + invalid dropped", () => {
  const ids = Array.from({ length: 250 }, (_, i) => i + 1); // 1..250
  const cfg = sanitize({ seenUpdateIds: [...ids, 250, "nope", -5] });
  assert.equal(cfg.seenUpdateIds.length, 200);
  assert.equal(cfg.seenUpdateIds[0], 51);   // oldest 1..50 dropped
  assert.equal(cfg.seenUpdateIds[199], 250); // newest kept
});

test("sanitize: seenUpdateIds default []", () => {
  assert.deepEqual(sanitize({}).seenUpdateIds, []);
});

// ── botToken at-rest encoding (base64) ──────────────────────────────────────

test("saveConfig: botToken is written base64-encoded, never plaintext", () => {
  const { opts, path } = tempPath();
  const cfg = { ...loadConfig(opts), botToken: "123:ABC" };
  saveConfig(cfg, opts);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { botToken: string };
  assert.equal(raw.botToken, Buffer.from("123:ABC", "utf-8").toString("base64"));
  assert.notEqual(raw.botToken, "123:ABC");
  assert.equal(cfg.botToken, "123:ABC", "in-memory cfg is not mutated by saveConfig");
});

test("loadConfig: a base64-encoded botToken on disk is decoded", () => {
  const { opts, path } = tempPath();
  const token = "8852053515:AAESyRGxDVT_qNaMwrANG1fxFhp4MTrSsbk";
  writeFileSync(path, JSON.stringify({ botToken: Buffer.from(token, "utf-8").toString("base64") }), "utf-8");
  assert.equal(loadConfig(opts).botToken, token);
});

test("sanitize: legacy plaintext token (contains ':') is kept as-is (no decode)", () => {
  assert.equal(sanitize({ botToken: "123:ABC" }).botToken, "123:ABC");
});

test("saveConfig/loadConfig round-trip: encoded on disk, decoded in memory", () => {
  const { opts, path } = tempPath();
  const token = "456:XYZ-_/";
  const cfg = { ...loadConfig(opts), botToken: token };
  saveConfig(cfg, opts);
  assert.equal(JSON.parse(readFileSync(path, "utf-8")).botToken, Buffer.from(token, "utf-8").toString("base64"));
  const back = loadConfig(opts);
  assert.equal(back.botToken, token);
  // saving again is idempotent — the already-decoded value re-encodes to the same bytes
  saveConfig(back, opts);
  assert.equal(JSON.parse(readFileSync(path, "utf-8")).botToken, Buffer.from(token, "utf-8").toString("base64"));
  assert.equal(loadConfig(opts).botToken, token);
});
