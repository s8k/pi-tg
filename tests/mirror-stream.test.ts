import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { TG_MAX_LEN } from "../src/markdown.ts";
import { FakeOut } from "./fake-pi.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

const m = (t: string): MirrorMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });

test("stream: placeholder → throttled edits → end deletes stream msg", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out); // streamEditMs default 1500
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  assert.equal(out.calls[0].text, "…");
  await mirror.onAssistantUpdate(m("ab"));
  assert.equal(out.calls.length, 1); // within 1500ms → no edit
  deps.advance(1600);
  await mirror.onAssistantUpdate(m("abcd"));
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[1].kind, "edit");
  assert.equal(out.calls[1].text, "abcd");
  deps.advance(10);
  await mirror.onAssistantUpdate(m("abcde")); // too soon → throttled
  assert.equal(out.calls.length, 2);
  await mirror.onAssistantEnd(m("abcde"));
  assert.ok(out.calls.some((c) => c.kind === "delete"));
});

test("stream: non-assistant messages ignored", async () => {
  const out = new FakeOut();
  const mirror = new Mirror(makeMirrorDeps(out));
  await mirror.onAssistantStart({ role: "user", content: [] });
  await mirror.onAssistantUpdate({ role: "user", content: [{ type: "text", text: "x" }] });
  await mirror.onAssistantEnd({ role: "user", content: [{ type: "text", text: "x" }] });
  assert.equal(out.calls.length, 0);
});

test("stream: oversize text truncated mid-stream (≤ TG_MAX_LEN, ellipsis)", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  deps.advance(2000);
  await mirror.onAssistantUpdate(m("a".repeat(5000)));
  const edit = out.calls.find((c) => c.kind === "edit");
  assert.ok(edit?.text, "an edit must have happened");
  assert.ok(edit!.text!.length <= TG_MAX_LEN);
  assert.ok(edit!.text!.endsWith("…"));
});

test("multiple assistant messages: each stream msg deleted", async () => {
  const out = new FakeOut();
  const deps = makeMirrorDeps(out);
  const mirror = new Mirror(deps);
  await mirror.onAssistantStart(m(""));
  await mirror.onAssistantEnd(m("first"));
  await mirror.onAssistantStart(m(""));
  deps.advance(2000);
  await mirror.onAssistantUpdate(m("second"));
  await mirror.onAssistantEnd(m("second"));
  assert.equal(out.calls.filter((c) => c.kind === "delete").length, 2);
});
