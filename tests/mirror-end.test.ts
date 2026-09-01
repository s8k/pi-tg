// Finalization: rich → legacy HTML → plain; error/abort/no-text paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { RICH_CAP } from "../src/markdown.ts";
import { TgError } from "../src/telegram-client.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("normal end → single rich message; no status line", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "**bold** answer" }] }]);
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1);
  assert.equal(rich[0].text, "**bold** answer");
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 0, "no ✅ Done / Working… line on the normal path");
});

test("answer over RICH_CAP → chunkRich rich chunks, marker from 2nd", async () => {
  const md = "x".repeat(40_000);
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: md }]);
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 2);
  const t0 = rich[0]?.text;
  const t1 = rich[1]?.text;
  assert.ok(t0 !== undefined && !t0.startsWith("(continued)"));
  assert.ok(t1 !== undefined && t1.startsWith("(continued)\n"));
  for (const c of rich) assert.ok((c.text ?? "").length <= RICH_CAP);
});

test("rich 400 → legacy HTML chunks (parse_mode HTML)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich parse error");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "hello" }]);
  const html = out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === "HTML");
  assert.equal(html.length, 1);
  assert.equal(html[0].text, "hello");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("rich 400 → HTML 400 → plain text (full fallback chain)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 400, "rich");
  out.sendHtmlFailsWith = new TgError("sendMessage", 400, "html");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "text <broken" }]);
  const plain = out.calls.filter((c) => c.kind === "send" && c.opts?.parseMode === null);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "text <broken");
});

test("non-400 error propagates (no silent fallback)", async () => {
  const { deps, out } = makeMirrorDeps();
  out.sendRichFailsWith = new TgError("sendRichMessage", 429, "rate limited");
  const m = new Mirror(deps);
  await m.onAgentStart();
  await assert.rejects(m.onAgentEnd([{ role: "assistant", content: "hi" }]));
});

test("error end → plain ⚠️ line, no rich answer", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "partial", stopReason: "error", errorMessage: "boom" }]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "⚠️ error: boom");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("aborted → '⏹  interrupted' (space after emoji) + rich partial answer", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" }]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "⏹  interrupted");
  const rich = out.calls.filter((c) => c.kind === "sendRich");
  assert.equal(rich.length, 1);
  assert.equal(rich[0].text, "partial");
});

test("aborted with no text → label only", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([{ role: "assistant", content: "", stopReason: "aborted" }]);
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 1);
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});

test("normal end with no reply text → '✅ Done (no reply text)'", async () => {
  const { deps, out } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAgentEnd([]);
  const plain = out.calls.filter((c) => c.kind === "send");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, "✅ Done (no reply text)");
  assert.equal(out.calls.filter((c) => c.kind === "sendRich").length, 0);
});
