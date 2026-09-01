// Tool status lines live INSIDE the draft footer (sending separate bot
// messages would kill the draft).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, toolPreview } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const lastDraft = (out: { calls: { kind: string; text?: string }[] }): { text: string } => {
  const d = out.calls.filter((c) => c.kind === "sendDraft").at(-1) as { text: string } | undefined;
  assert.ok(d, "a draft update exists");
  return d;
};

test("tool start → footer line in the draft; NO separate tool message", async () => {
  const { deps, out, advance, cfg } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  advance(cfg.streamEditMs); // past the success cooldown (all draft senders share it)
  await m.onToolStart("c1", "bash", { command: "ls -la" });
  assert.ok(lastDraft(out).text.includes("⚙ bash: ls -la …"));
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0);
});

test("tool end ✔ and error end ✖", async () => {
  const { deps, out, advance, cfg } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const gap = () => advance(cfg.streamEditMs); // keep each event past the success cooldown
  gap();
  await m.onToolStart("c1", "bash", { command: "long build" });
  assert.ok(lastDraft(out).text.includes("⚙ bash: long build …"));
  gap();
  await m.onToolEnd("c1", true);
  assert.ok(lastDraft(out).text.includes("⚙ bash: long build ✖"));
  gap();
  await m.onToolStart("c2", "read", { path: "src/a.ts" });
  gap();
  await m.onToolEnd("c2", false);
  assert.ok(lastDraft(out).text.includes("⚙ read: src/a.ts ✔"));
});

test("footer keeps in-flight lines + only the LAST 3 completions", async () => {
  const { deps, out, advance, cfg } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const specs: [string, string, unknown][] = [
    ["c1", "read", { path: "a.ts" }],
    ["c2", "bash", { command: "b" }],
    ["c3", "write", { path: "c.ts" }],
    ["c4", "edit", { path: "d.ts" }],
    ["c5", "bash", { command: "e" }],
  ];
  for (const [id, tool, args] of specs) {
    advance(cfg.streamEditMs);
    await m.onToolStart(id, tool, args);
    advance(cfg.streamEditMs);
    await m.onToolEnd(id, false);
  }
  const t = lastDraft(out).text;
  assert.ok(t.includes("write: c.ts ✔"));
  assert.ok(t.includes("edit: d.ts ✔"));
  assert.ok(t.includes("bash: e ✔"));
  assert.ok(!t.includes("read: a.ts"), "older completion dropped");
  assert.ok(!t.includes("bash: b ✔"), "older completion dropped");
});

test("in-flight tool line survives a later completion of another tool", async () => {
  const { deps, out, advance, cfg } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  const gap = () => advance(cfg.streamEditMs);
  gap();
  await m.onToolStart("c1", "read", { path: "a.ts" });
  gap();
  await m.onToolEnd("c1", false);
  gap();
  await m.onToolStart("c2", "bash", { command: "npm test" });
  const t = lastDraft(out).text;
  assert.ok(t.includes("read: a.ts ✔"), "recent completion kept");
  assert.ok(t.includes("⚙ bash: npm test …"), "in-flight line kept");
});

test("ui_prompt_start → footer line inside the draft (no separate message)", async () => {
  const { deps, out, advance, cfg } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  advance(cfg.streamEditMs);
  await m.onUiPromptStart("allow bash?");
  assert.ok(lastDraft(out).text.includes("allow bash?"));
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0);
});

test("toolPreview: bash command / file path / truncated JSON", () => {
  assert.equal(toolPreview("bash", { command: "ls -la" }, 30), "ls -la");
  assert.equal(toolPreview("read", { path: "x/y.ts" }, 30), "x/y.ts");
  assert.equal(toolPreview("weird", { a: "b" }, 30), '{"a":"b"}');
  assert.ok(toolPreview("weird", { a: "x".repeat(50) }, 30).length <= 32);
});
