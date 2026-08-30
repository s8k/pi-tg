import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, assistantText, toolPreview, type MirrorMessage } from "../src/mirror.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("toolPreview: known args, unknown JSON, whitespace, truncation", () => {
  assert.equal(toolPreview("bash", { command: "ls -la" }), "ls -la");
  assert.equal(toolPreview("read", { path: "C:/x/y.ts" }), "C:/x/y.ts");
  assert.equal(toolPreview("mystery", { a: 1 }), '{"a":1}');
  assert.equal(toolPreview("bash", "  echo   hi  "), "echo hi");
  assert.equal(toolPreview("bash", { command: "x".repeat(200) }), "x".repeat(80) + "…");
  assert.equal(toolPreview("bash", { command: "x".repeat(200) }, 10), "x".repeat(10) + "…");
});

test("assistantText: joins text parts, ignores non-text", () => {
  const m: MirrorMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Hello " }, { type: "image" }, { type: "text", text: "world" }],
  };
  assert.equal(assistantText(m), "Hello world");
});

test("onAgentStart: posts working message with Stop button + tracks id", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAgentStart();
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].text, "🤖 Working…");
  const kb = out.calls[0].opts!.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.equal(kb.inline_keyboard[0][0].callback_data, "stop");
  assert.equal(deps.state.getWorking(), 100);
});

test("onToolStart/onToolEnd: status line then ✔; unknown toolCall ignored", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onToolStart("tc1", "bash", { command: "npm test" });
  assert.equal(out.calls[0].text, "⚙ bash: npm test …");
  assert.equal(deps.state.getToolMsg("tc1"), 100);
  await mirror.onToolEnd("tc1", false);
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚙ bash: npm test … ✔");
  await mirror.onToolEnd("tc2", false);
  assert.equal(out.calls.filter((c) => c.kind === "edit").length, 1);
});

test("onToolEnd: isError marks ✖", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onToolStart("tc1", "read", { path: "/nope" });
  await mirror.onToolEnd("tc1", true);
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.equal(edit?.text, "⚙ read: /nope … ✖");
});

test("no chatId yet → every event is a silent no-op", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out, {}, null));
  await mirror.onAgentStart();
  await mirror.onToolStart("t", "bash", "x");
  await mirror.onToolEnd("t", false);
  assert.equal(out.calls.length, 0);
});
