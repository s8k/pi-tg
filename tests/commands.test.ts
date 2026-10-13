import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point pi's agent dir at a temp dir BEFORE index.ts's module scope runs —
// index.ts calls getAgentDir() on import to build the config path, and the
// /tg:config handler would otherwise read/write the user's real config.
const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-cmd-"));
const CFG_PATH = join(agentDir, "pi-telegram.json");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: piTelegram } = await import("../index.ts");

// ── minimal structural fakes (no pi import in tests — see boundary.test.ts) ──

interface Notice {
  text: string;
  level?: "info" | "warning" | "error";
}

interface Ctx {
  cwd: string;
  mode: string;
  hasUI: boolean;
  ui: {
    notify(text: string, level?: Notice["level"]): void;
    setWidget(name: string, lines: unknown): void;
  };
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

interface CommandOpts {
  description?: string;
  getArgumentCompletions?: (prefix: string) => CompletionItem[] | null;
  handler: (args: string, ctx: Ctx) => Promise<void> | void;
}

interface FakeCap {
  commands: Map<string, CommandOpts>;
  events: Map<string, Array<(event: unknown, ctx: Ctx) => Promise<void> | void>>;
  sent: string[];
}

function makeFakePi() {
  const cap: FakeCap = { commands: new Map(), events: new Map(), sent: [] };
  const pi = {
    registerCommand: (name: string, opts: CommandOpts) => {
      cap.commands.set(name, opts);
    },
    on: (event: string, handler: (event: unknown, ctx: Ctx) => Promise<void> | void) => {
      const arr = cap.events.get(event) ?? [];
      arr.push(handler);
      cap.events.set(event, arr);
    },
    sendUserMessage: (text: string) => {
      cap.sent.push(text);
    },
  };
  return { pi: pi as unknown as Parameters<typeof piTelegram>[0], cap };
}

function makeCtx() {
  const notices: Notice[] = [];
  const widgets: Record<string, unknown> = {};
  const ctx: Ctx = {
    cwd: "/proj",
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text, level) => notices.push({ text, level }),
      setWidget: (name, lines) => {
        widgets[name] = lines;
      },
    },
  };
  return { ctx, notices, widgets };
}

// ── registration ──

test("registers exactly the commands: tg, tg:config, tg:pair, tg:unpair", () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  assert.deepEqual([...cap.commands.keys()].sort(), ["tg", "tg:config", "tg:pair", "tg:unpair"]);
});

test("command descriptions follow pi's `<args> — Description` format", () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  // pi renders the completion line as `/<name>  <description>`; built-ins such
  // as /thinking combine their arg hint and description as
  // `<level> — Set thinking level`. Extension commands expose only `description`,
  // so commands that take args must carry the hint up front: `<args> — Description`.
  assert.equal(
    cap.commands.get("tg")!.description,
    "Reserved for pi-tg internal dispatch. Use /tg:* commands instead",
  );
  assert.equal(
    cap.commands.get("tg:config")!.description,
    "<bot_token> — Save Telegram bot token, restart poller",
  );
  assert.equal(cap.commands.get("tg:pair")!.description, "Show pairing QR (only while unpaired)");
  assert.equal(cap.commands.get("tg:unpair")!.description, "Unpair the phone (bot silent until a new /start)");
  // no-arg commands must not carry an arg hint
  assert.ok(!/<[a-z_]+>/i.test(cap.commands.get("tg")!.description ?? ""));
  assert.ok(!/<[a-z_]+>/i.test(cap.commands.get("tg:pair")!.description ?? ""));
  assert.ok(!/<[a-z_]+>/i.test(cap.commands.get("tg:unpair")!.description ?? ""));
});

// ── /tg (reserved: machine dispatch is the poller's path) ──

test("/tg typed by hand → reserved-command notice, no card", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices, widgets } = makeCtx();
  await cap.commands.get("tg")!.handler("", ctx);
  assert.match(notices.at(-1)!.text, /reserved internal command/);
  assert.equal(notices.at(-1)!.level, "info");
  assert.equal(Object.keys(widgets).length, 0, "no session-card widget is shown");
});

test("/tg with an unrecognized payload → reserved-command notice", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg")!.handler("internal bogus 42", ctx);
  assert.match(notices.at(-1)!.text, /reserved internal command/);
  assert.equal(notices.at(-1)!.level, "info");
});

test("/tg with a valid action but no bridge (pre-session_start) → reserved notice, no crash", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg")!.handler("internal start 42", ctx);
  assert.match(notices.at(-1)!.text, /reserved internal command/);
  assert.equal(notices.at(-1)!.level, "info");
});

// ── /tg:config ──

test("/tg:config with an invalid token → error notice, nothing persisted", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:config")!.handler("not-a-token", ctx);
  const last = notices.at(-1)!;
  assert.match(last.text, /invalid token/);
  assert.equal(last.level, "error");
  assert.ok(!existsSync(CFG_PATH));
});

test("/tg:config with no args → invalid token error", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:config")!.handler("", ctx);
  assert.match(notices.at(-1)!.text, /invalid token/);
  assert.equal(notices.at(-1)!.level, "error");
  assert.ok(!existsSync(CFG_PATH));
});

// ── /tg:pair ──

test("/tg:pair unpaired, no token → points at /tg:config (new copy)", async () => {
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:pair")!.handler("", ctx);
  const last = notices.at(-1)!;
  assert.match(last.text, /no token yet — run \/tg:config <bot_token>/);
  assert.equal(last.level, "warning");
});

test("/tg:pair already paired → guard message, no QR attempt", async () => {
  // Seed a paired config, then fire session_start so the handler re-reads cfg.
  writeFileSync(CFG_PATH, JSON.stringify({ ownerId: 42 }), "utf-8");
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const session = makeCtx();
  await cap.events.get("session_start")![0]!({ reason: "startup" }, session.ctx);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:pair")!.handler("", ctx);
  const last = notices.at(-1)!;
  assert.match(last.text, /already paired with owner 42/);
  assert.match(last.text, /Run \/tg:unpair to unpair/);
});

// ── /tg:unpair ──

test("/tg:unpair paired → clears ownerId, persists, confirms", async () => {
  writeFileSync(CFG_PATH, JSON.stringify({ ownerId: 42 }), "utf-8");
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const session = makeCtx();
  await cap.events.get("session_start")![0]!({ reason: "startup" }, session.ctx);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:unpair")!.handler("", ctx);
  const last = notices.at(-1)!;
  assert.match(last.text, /unpaired/);
  assert.equal(last.level, "info");
  const back = JSON.parse(readFileSync(CFG_PATH, "utf-8"));
  assert.equal(back.ownerId, undefined);
});

test("/tg:unpair unpaired → notice, no crash", async () => {
  writeFileSync(CFG_PATH, JSON.stringify({}), "utf-8");
  const { pi, cap } = makeFakePi();
  piTelegram(pi);
  const session = makeCtx();
  await cap.events.get("session_start")![0]!({ reason: "startup" }, session.ctx);
  const { ctx, notices } = makeCtx();
  await cap.commands.get("tg:unpair")!.handler("", ctx);
  assert.match(notices.at(-1)!.text, /not paired/);
});
