// Mute = fully silent: no draft, no updates, no final message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";

test("muted at start: zero messages of any kind", async () => {
  const { deps, out } = makeMirrorDeps({ muted: true });
  const m = new Mirror(deps);
  await m.onAgentStart();
  await m.onAssistantUpdate({ role: "assistant", content: "secret work" });
  await m.onToolStart("c1", "bash", { command: "secret" });
  await m.onAgentEnd([{ role: "assistant", content: "secret answer" }]);
  assert.equal(out.calls.length, 0, `calls: ${JSON.stringify(out.calls)}`);
});

test("muted mid-turn: draft updates and heartbeat stop; no final message", async () => {
  const { deps, out, advance, fireTimer } = makeMirrorDeps({ draftHeartbeatMs: 17000 });
  const m = new Mirror(deps);
  await m.onAgentStart();
  out.calls.length = 0;
  deps.cfg.muted = true; // user mutes mid-turn
  advance(17000);
  fireTimer();
  advance(1500);
  await m.onAssistantUpdate({ role: "assistant", content: "late text" });
  await m.onAgentEnd([{ role: "assistant", content: "late text" }]);
  assert.equal(out.calls.length, 0, `calls: ${JSON.stringify(out.calls)}`);
});
