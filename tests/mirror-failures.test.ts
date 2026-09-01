// Draft failure handling: coalescing (one in-flight call), failure pacing
// (retry_after honored — no cascade), state-change notifications, and the
// 400 cooldown. Regression for the "thousands of draft update failed"
// flood: sustained 429 + streaming updates must stay bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror } from "../src/mirror.ts";
import { TgError } from "../src/telegram-client.ts";
import { makeMirrorDeps } from "./mirror-helpers.ts";
import type { FakeOut } from "./fake-pi.ts";

interface Notif {
  msg: string;
  level: string;
}

/** Flush microtasks (rejection → catch → finally → coalesced follow-up). */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

/** Draft stub that stays in flight until the test releases it. */
function makeHeldDraft(out: FakeOut): {
  attempts: number;
  maxInflight: number;
  lastContent: string;
  releaseFail(): void;
  releaseOk(): void;
} {
  let inflight = 0;
  let pending: { resolve: (b: boolean) => void; reject: (e: unknown) => void } | undefined;
  const held = {
    attempts: 0,
    maxInflight: 0,
    lastContent: "",
    releaseFail(): void {
      release(false);
    },
    releaseOk(): void {
      release(true);
    },
  };
  function release(ok: boolean): void {
    const p = pending;
    pending = undefined;
    inflight = Math.max(0, inflight - 1);
    if (!p) return;
    if (ok) p.resolve(true);
    else p.reject(new TgError("sendRichMessageDraft", 429, "Too Many Requests", 25));
  }
  out.sendDraft = (_chatId: number, _draftId: number, md: string) =>
    new Promise<boolean>((resolve, reject) => {
      held.attempts++;
      inflight++;
      held.maxInflight = Math.max(held.maxInflight, inflight);
      held.lastContent = String(md);
      pending = { resolve, reject };
    });
  return held;
}

test("cascade regression: sustained 429 + 500 streaming updates → bounded attempts, 1 notification", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  let attempts = 0;
  out.sendDraft = async () => {
    attempts++;
    throw new TgError("sendRichMessageDraft", 429, "Too Many Requests", 25);
  };
  const notifs: Notif[] = [];
  deps.notify = (msg, level) => notifs.push({ msg, level: level ?? "error" });
  const m = new Mirror(deps);
  await m.onAgentStart();
  // 500 deltas over ~150 s (≈3.3 updates/s, realistic LLM streaming rate)
  for (let i = 0; i < 500; i++) {
    advance(300);
    await m.onAssistantUpdate({ role: "assistant", content: "token " + i });
  }
  assert.ok(attempts <= 10, `one attempt per retry_after window (≤10 in 150 s), got ${attempts}`);
  assert.equal(notifs.length, 1, "single 'failing' notification — no per-update spam");
});

test("coalescing: updates while in-flight → one follow-up with latest content; recovery notified once (info)", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  const held = makeHeldDraft(out);
  const notifs: Notif[] = [];
  deps.notify = (msg, level) => notifs.push({ msg, level: level ?? "error" });
  const m = new Mirror(deps);
  await m.onAgentStart(); // attempt 1 in flight (thinking)
  await m.onAssistantUpdate({ role: "assistant", content: "v1" });
  await m.onAssistantUpdate({ role: "assistant", content: "v2" });
  await m.onAssistantUpdate({ role: "assistant", content: "v3" });
  assert.equal(held.attempts, 1, "coalesced: no new call while one is in flight");
  assert.equal(held.maxInflight, 1, "never two concurrent draft calls");
  held.releaseFail();
  await settle();
  assert.equal(held.attempts, 1, "dirty follow-up suppressed during the 25 s retry_after cooldown");
  assert.equal(notifs.length, 1);
  assert.match(notifs[0].msg, /failing/);
  advance(25000);
  await m.onAssistantUpdate({ role: "assistant", content: "v4" });
  assert.equal(held.attempts, 2);
  assert.equal(held.lastContent, "v4", "the follow-up carries the latest content");
  held.releaseOk();
  await settle();
  assert.equal(held.attempts, 2, "no extra follow-up after success");
  assert.equal(notifs.length, 2);
  assert.equal(notifs[1].level, "info");
  assert.match(notifs[1].msg, /recovered/);
});

test("persistent failure (no retry_after): paced at streamEditMs; one 5-min re-notification with streak", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  let attempts = 0;
  out.sendDraft = async () => {
    attempts++;
    throw new Error("network down");
  };
  const notifs: Notif[] = [];
  deps.notify = (msg, level) => notifs.push({ msg, level: level ?? "error" });
  const m = new Mirror(deps);
  await m.onAgentStart(); // fail #1 → first notification
  for (let i = 0; i < 360; i++) {
    advance(1500); // ~9 min of streaming
    await m.onAssistantUpdate({ role: "assistant", content: "t" + i });
  }
  assert.ok(attempts >= 200, "still pacing retries at streamEditMs, got " + attempts);
  assert.equal(notifs.length, 2, "first + exactly one 5-min re-notification");
  assert.match(notifs[1].msg, /still failing/);
  assert.ok(/(\d+)×/.test(notifs[1].msg), "re-notification carries the streak count");
});

test("400: one notification, quiet 60 s cooldown before any re-attempt", async () => {
  const { deps, out, advance } = makeMirrorDeps();
  let attempts = 0;
  out.sendDraft = async () => {
    attempts++;
    throw new TgError("sendRichMessageDraft", 400, "rich markdown parse failed");
  };
  const notifs: Notif[] = [];
  deps.notify = (msg, level) => notifs.push({ msg, level: level ?? "error" });
  const m = new Mirror(deps);
  await m.onAgentStart(); // attempt 1 → 400
  for (let i = 0; i < 100; i++) {
    advance(300);
    await m.onAssistantUpdate({ role: "assistant", content: "x" + i });
  }
  assert.equal(attempts, 1, "no re-attempt of the same failing content within 60 s");
  assert.equal(notifs.length, 1);
  advance(30000); // t = 60000
  await m.onAssistantUpdate({ role: "assistant", content: "y" });
  assert.equal(attempts, 2, "one quiet re-attempt after the 400 cooldown");
  assert.equal(notifs.length, 1, "no second notification");
});
