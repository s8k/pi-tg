// Wiring smoke: boot the real extension entry (index.ts) with a fake pi +
// fake fetch, and drive it with pi events — proving the glue end to end:
//   - drafts go out with can_stop + keep_on_stop,
//   - tool_execution_end's `result` reaches the wire (✖ block + error text),
//   - the clean-end finalization persists m1 (Completed ✔️) then m2 (answer)
//     as real sendRichMessage calls.
// Config is isolated via PI_CODING_AGENT_DIR (a fresh temp agent dir — the
// module snapshots getAgentDir() at load time, so the env must be set before
// importing index.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-telega-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_TELEGA_BOT_TOKEN = "TEST-TOKEN";
// paired config: the mirror only works for the owner's chat, and the chat id
// is learned from the first owner update (below)
writeFileSync(join(agentDir, "pi-telega.json"), JSON.stringify({ botToken: "TEST-TOKEN", ownerId: 123456 }));

const { default: piTelega } = await import("../index.ts");

interface WireCall {
  method: string;
  body: Record<string, unknown>;
  markdown: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await sleep(10);
  }
}

test("index.ts wiring: events → mirror → client wire (full clean run)", async (t) => {
  const calls: WireCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = u.split("/").pop() ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, body, markdown: String((body.rich_message as { markdown?: string } | undefined)?.markdown ?? "") });
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Tg", username: "tgb" } }), { status: 200 });
    if (method === "getUpdates") {
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        // the first poll returns one owner prompt — that teaches the extension
        // the owner's chat id. bridge.dispatch throws against the fake ctx
        // (no pi behind it); pollLoop's onError swallows it (ui → no-op).
        const ownerUpdate = {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 42, type: "private" },
            from: { id: 123456, is_bot: false, first_name: "O" },
            text: "hello",
          },
        };
        return new Response(JSON.stringify({ ok: true, result: [ownerUpdate] }), { status: 200 });
      }
      return new Promise<Response>(() => {}); // long poll: never resolves
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  let getUpdatesCount = 0;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  piTelega({ registerCommand: () => {}, on: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) } as never);
  const fakeCtx = { cwd: "/tmp", ui: { notify: () => {} } };

  // bootstrap (getMe → mirror created); pendingAction is absent (fresh config)
  handlers.get("session_start")!({}, fakeCtx);
  // wait until the first owner update was processed (the 2nd getUpdates went out)
  await waitFor(() => getUpdatesCount >= 2, "owner chat learned");

  // run 1: the work log
  handlers.get("agent_start")!();
  await waitFor(() => calls.some((c) => c.method === "sendRichMessageDraft"), "draft 1 spawn");
  const spawn = calls.filter((c) => c.method === "sendRichMessageDraft")[0]!;
  assert.equal(spawn.body.can_stop, true, "draft 1 is stoppable");
  assert.equal(spawn.body.keep_on_stop, true, "draft 1 survives Stop (the bot persists it)");

  // Realistic gap: the model takes a moment to start. This matters — the
  // spawn's pump must have finished (and armed its drain at the old window
  // edge) before the first message's forced send extends the window. That is
  // exactly the interleaving that used to deadlock the draft pipeline.
  await sleep(50);

  const toolContent = [
    { type: "thinking", thinking: "check it" },
    { type: "text", text: "Let me check." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
  ];
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: toolContent } });
  handlers.get("message_end")!({ message: { role: "assistant", content: toolContent, stopReason: "toolUse" } });
  // the pi event's `result` must reach the wire — this is the glue under test
  handlers.get("tool_execution_end")!({
    toolCallId: "c1",
    toolName: "read",
    isError: true,
    result: { content: [{ type: "text", text: "RangeError: boom" }] },
  });
  await waitFor(
    () => calls.some((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("RangeError: boom")),
    "tool result on the wire",
  );
  const stamped = calls.filter((c) => c.method === "sendRichMessageDraft" && c.markdown.includes("RangeError: boom")).pop()!;
  assert.ok(stamped.markdown.includes("✖"), "the ✖ stamp is on the wire");

  // the answer
  handlers.get("message_start")!({ message: { role: "assistant", content: [] } });
  handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] } });
  handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }], stopReason: "stop" } });

  // clean-end finalization: the flip, then the two persistent rich sends (m1, m2)
  await waitFor(() => calls.some((c) => c.method === "sendRichMessage" && c.markdown.includes("Completed ✔️")), "m1 persist");
  await waitFor(() => calls.some((c) => c.method === "sendRichMessage" && c.markdown.includes("The answer is 42.")), "m2 persist");
  const richSends = calls.filter((c) => c.method === "sendRichMessage");
  const m1 = richSends.find((c) => c.markdown.includes("Completed ✔️"))!;
  const m2 = richSends.find((c) => c.markdown.includes("The answer is 42."))!;
  assert.equal(richSends.length, 2, "exactly m1 + m2");
  assert.ok(m1.markdown.includes("⚙ read a.ts ✖"), "m1 carries the failed tool block");
  assert.equal(m2.markdown, "The answer is 42.");
  assert.ok(
    calls.indexOf(m1) < calls.indexOf(m2),
    "chronology: m1 before m2",
  );
});
