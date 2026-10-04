// Mirror.whenSettled() — the settlement promise the wrapped waitForIdle
// (wiring.wrapWaitForIdle) waits on: it must resolve only AFTER the run's
// finalization has delivered its persistent sends (or immediately when there
// is nothing to deliver), and it must never hang the bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import type { TgBlock } from "../src/rich-blocks.ts";
import { makeMirrorDeps, tick } from "./mirror-helpers.ts";

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

test("whenSettled: no run in flight → resolves immediately", async () => {
  const { deps } = makeMirrorDeps();
  const m = new Mirror(deps);
  await m.whenSettled();
});

test("whenSettled: resolves only after the finalized persistent send has been delivered", async () => {
  const h = makeMirrorDeps();
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("answer text"));
  await m.onAssistantEnd(textMsg("answer text", { stopReason: "stop" }));
  await tick();
  // finalized: the persistent send happened...
  assert.ok(h.out.calls.some((c) => c.kind === "sendRich" && c.text?.includes("answer text")), "finalized send went out");
  // ...and the settlement promise is already resolved
  await m.whenSettled();
});

test("whenSettled: pending while the final send is still in flight — the ordering guarantee", async () => {
  const h = makeMirrorDeps();
  const m = new Mirror(h.deps);
  // Every persistent send sits in flight until the test releases it.
  let released = false;
  const gates: (() => void)[] = [];
  const realSendRich = h.out.sendRich.bind(h.out);
  h.out.sendRich = async (chatId: number, blocks: TgBlock[]) => {
    if (!released) await new Promise<void>((r) => gates.push(r));
    return realSendRich(chatId, blocks);
  };
  const release = (): void => {
    released = true;
    gates.splice(0).forEach((g) => g());
  };
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("answer text"));
  const endP = m.onAssistantEnd(textMsg("answer text", { stopReason: "stop" })); // finalize hangs inside the send
  const settled = m.whenSettled();
  let settledAlready = false;
  void settled.then(() => {
    settledAlready = true;
  });
  await tick();
  assert.equal(settledAlready, false, "still pending while the final send is in flight (a compact draft sent now would NOT be cleared)");
  release();
  await endP;
  await settled;
  assert.equal(settledAlready, true);
});

test("whenSettled: a new run starts while the old settle is pending → the old promise resolves (no hang)", async () => {
  const h = makeMirrorDeps();
  const m = new Mirror(h.deps);
  let released = false;
  const gates: (() => void)[] = [];
  const realSendRich = h.out.sendRich.bind(h.out);
  h.out.sendRich = async (chatId: number, blocks: TgBlock[]) => {
    if (!released) await new Promise<void>((r) => gates.push(r));
    return realSendRich(chatId, blocks);
  };
  const release = (): void => {
    released = true;
    gates.splice(0).forEach((g) => g());
  };
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("first answer"));
  const endP = m.onAssistantEnd(textMsg("first answer", { stopReason: "stop" })); // finalize hangs inside the send
  const firstSettle = m.whenSettled();
  await tick();
  // the user fires the next prompt before the first run's send landed
  m.onAgentStart();
  await firstSettle; // must NOT hang — a waiter (the bridge) is unblocked
  release(); // let the stale sends finish; they must not resolve the NEW run's promise
  await endP;
  await tick();
  let newSettled = false;
  void m.whenSettled().then(() => {
    newSettled = true;
  });
  await tick();
  assert.equal(newSettled, false, "the new run's settlement is still pending until ITS finalization");
});

test("whenSettled: muted run → resolves without any send", async () => {
  const h = makeMirrorDeps({ level: "mute" });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("silent"));
  await m.onAssistantEnd(textMsg("silent", { stopReason: "stop" }));
  await m.whenSettled();
  assert.equal(h.out.calls.length, 0);
});

test("whenSettled: no chat id (unpaired) → resolves without any send", async () => {
  const h = makeMirrorDeps({}, 7);
  (h.deps as { getChatId: () => number | undefined }).getChatId = () => undefined;
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("no chat"));
  await m.onAssistantEnd(textMsg("no chat", { stopReason: "stop" }));
  await m.whenSettled();
  assert.equal(h.out.calls.length, 0);
});

test("whenSettled: error end persists AT agent_settled (not at agent_end) and settles there", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("partial"));
  await m.onAssistantEnd(textMsg("partial", { stopReason: "error", errorMessage: "boom" })); // error endKind
  await m.onAgentEnd([]); // the run ended — but the stream may continue (pi retry): no finalize yet
  await tick();
  let settled = false;
  void m.whenSettled().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "agent_end alone does not settle (pi may retry)");
  await m.onAgentSettled(); // the stream is over (all retries done) — finalize NOW
  await tick();
  assert.equal(settled, true, "settled once agent_settled persisted the error log");
  const t = h.out.calls.find((c) => c.kind === "sendRich")?.text ?? "";
  assert.ok(t.includes("⚠️ error: boom"), "the error is in the persistent message");
  assert.ok(!t.includes("<tg-thinking>"), "no spinner in the persistent message");
});

test("whenSettled: backstop — when agent_settled never arrives, the grace timer persists the error log", async () => {
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 1000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("partial"));
  await m.onAssistantEnd(textMsg("partial", { stopReason: "error", errorMessage: "boom" }));
  await m.onAgentEnd([]);
  await tick();
  h.advance(1000); // no agent_settled ever arrives — the timer is the backstop
  await tick();
  await m.whenSettled();
  assert.ok(h.out.calls.some((c) => c.kind === "sendRich"), "the error log was persisted by the grace timer");
});
