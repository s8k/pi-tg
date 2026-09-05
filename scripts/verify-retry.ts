// Verification demo for the retry-carryover fix (2026-09-04).
//
// Drives the REAL Mirror (src/mirror.ts) + REAL markdown rendering with a fake
// clock (tests/mirror-helpers.ts) and prints, step by step, exactly what the
// Telegram user sees: every draft state, then the final persistent messages.
//
//   node scripts/verify-retry.ts
//
// Scenario A — the literal ask: a successful tool call, then one that fails
// (exit code 1), then a successful one again — the ✖ must APPEND, never wipe.
// Scenario B — the actual bug: a 502 provider error mid-run, pi's auto-retry,
// and the re-executed failing call — the draft must keep the successful calls
// across the retry (before the fix it was wiped).

import { Mirror, type MirrorMessage } from "../src/mirror.ts";
import { makeMirrorDeps, tick } from "../tests/mirror-helpers.ts";

// ── display helpers (render the draft the way a human would read it) ──

/** Compact a draft's markdown for the terminal: collapse <details>, strip tags. */
function display(md: string): string {
  return md
    .replace(/<details><summary>(.*?)<\/summary>[\s\S]*?<\/details>/g, "  $1")
    .replace(/<tg-thinking>(.*?)<\/tg-thinking>/g, "  ⋯ $1 (thinking)")
    .replace(/<tg-thinking\/>/g, "  ⋯ (thinking)")
    .replace(/<\/?pre>/g, "")
    .replace(/<\/?code>/g, "")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

const richOf = (calls: { kind: string; text?: string }[]) =>
  calls.filter((c) => c.kind === "sendRich").map((c) => c.text ?? "");
const lastDraft = (calls: { kind: string; text?: string }[]) => {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].kind === "sendDraft") return calls[i].text ?? "";
  return "<no draft yet>";
};

const textMsg = (text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});
const toolMsg = (id: string, name: string, text: string, args: unknown, extra: Partial<MirrorMessage> = {}): MirrorMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, { type: "toolCall", id, name, arguments: args }],
  ...extra,
});

async function okTool(m: Mirror, h: ReturnType<typeof makeMirrorDeps>, id: string, name: string, text: string, args: unknown): Promise<void> {
  m.onAssistantStart(toolMsg(id, name, text, args));
  await m.onAssistantEnd(toolMsg(id, name, text, args));
  m.onToolEnd(id, false, "ok");
  await tick();
}
async function badTool(m: Mirror, h: ReturnType<typeof makeMirrorDeps>, id: string, name: string, text: string, args: unknown, err: string): Promise<void> {
  m.onAssistantStart(toolMsg(id, name, text, args));
  await m.onAssistantEnd(toolMsg(id, name, text, args));
  m.onToolEnd(id, true, err);
  await tick();
}

function show(title: string, body: string): void {
  console.log(`\n── ${title}`);
  for (const line of display(body).split("\n")) console.log(`   ${line}`);
}

// ─────────────────────────── scenario A ───────────────────────────

async function scenarioA(): Promise<void> {
  console.log("\n════════ A: ✔ → ✖ → ✔ (single run — the literal ask) ════════");
  const h = makeMirrorDeps({ streamEditMs: 0 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();

  await okTool(m, h, "c1", "bash", "Checking the docs.", { command: "curl -s https://core.telegram.org/bots/api -o /tmp/botapi.html" });
  show("draft after ✔ #1 (curl)", lastDraft(h.out.calls));

  await badTool(m, h, "c2", "bash", "Extracting the spec.", { command: "python /tmp/extract.py /tmp/botapi.html" }, "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] /tmp/botapi.html\nexit code 1");
  show("draft after ✖ #2 (exit code 1) — the ✔ #1 block must still be there", lastDraft(h.out.calls));

  await okTool(m, h, "c3", "bash", "Verifying the result.", { command: "ls -la /tmp/spec.md" });
  show("draft after ✔ #3", lastDraft(h.out.calls));

  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Done — the spec is at /tmp/spec.md."));
  await m.onAssistantEnd(textMsg("Done — the spec is at /tmp/spec.md.", { stopReason: "stop" }));
  await tick();

  const rich = richOf(h.out.calls);
  show("message 1 (final work log)", rich[0] ?? "");
  show("message 2 (final answer)", rich[1] ?? "");
  const m1 = rich[0] ?? "";
  const checks: [string, boolean][] = [
    ["✔ #1 (curl) in final m1", m1.includes("⚙ bash ✔") && m1.includes("curl")],
    ["✖ #2 (exit code 1) in final m1", m1.includes("⚙ bash ✖") && m1.includes("FileNotFoundError")],
    ["✔ #3 in final m1", (m1.match(/⚙ bash ✔/g) ?? []).length >= 2],
    ["Completed ✔️ marker", m1.includes("Completed ✔️")],
    ["m2 is the answer", (rich[1] ?? "") === "Done — the spec is at /tmp/spec.md."],
  ];
  report(checks);
}

// ─────────────────────────── scenario B ───────────────────────────

async function scenarioB(): Promise<void> {
  console.log("\n════════ B: ✔ ✔ → 502 → auto-retry → ✖ → ✔ ✔ (the actual bug) ════════");
  const h = makeMirrorDeps({ streamEditMs: 0, errorSettleMs: 5000 });
  const m = new Mirror(h.deps);
  m.onAgentStart();
  await tick();

  await okTool(m, h, "c1", "bash", "Checking the docs.", { command: "curl -s https://core.telegram.org/bots/api -o /tmp/botapi.html" });
  await okTool(m, h, "c2", "grep", "Finding the draft methods.", { pattern: "sendRichMessageDraft", path: "/tmp/botapi.html" });
  show("draft before the 502 (two ✔ blocks)", lastDraft(h.out.calls));

  // the provider 502s mid-run — pi ends the run, schedules an auto-retry
  await m.onAssistantEnd(textMsg("", { stopReason: "error", errorMessage: "502 status code (no body)" }));
  await tick();
  await m.onAgentEnd([]);
  await tick();
  show("draft after the 502 (run over — pi may retry; nothing persisted yet)", lastDraft(h.out.calls));

  await m.onAgentSettled();
  await tick();
  assert(richOf(h.out.calls).length === 0, "nothing persisted at agent_settled (retry window open)");
  console.log("   … agent_settled: still nothing persisted (the retry backoff is in flight)");

  h.advance(2000); // pi's retry backoff (2 s)
  m.onAgentStart(); // the auto-retry starts
  await tick();
  show("draft at the retry's agent_start — BEFORE THE FIX THIS WAS THE WIPE", lastDraft(h.out.calls));
  const atRetry = lastDraft(h.out.calls);
  assert(atRetry.includes("curl") && atRetry.includes("sendRichMessageDraft"), "no wipe: both ✔ blocks survive the retry's agent_start");
  assert(atRetry.includes("⚠️ error: 502 status code (no body)"), "the 502 error block is visible in the draft");

  // the retried run re-executes the in-flight work: the extraction fails again,
  // then the run recovers
  await badTool(m, h, "c3", "bash", "Retrying the extraction.", { command: "python /tmp/extract.py /tmp/botapi.html" }, "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] /tmp/botapi.html\nexit code 1");
  show("draft after the re-executed ✖ — the old ✔ blocks must still be above it", lastDraft(h.out.calls));
  await okTool(m, h, "c4", "bash", "Fetching the spec properly.", { command: "curl -sL https://core.telegram.org/bots/api | python /tmp/extract.py" });
  await okTool(m, h, "c5", "bash", "Verifying.", { command: "ls -la /tmp/spec.md" });

  m.onAssistantStart(textMsg(""));
  m.onAssistantUpdate(textMsg("Done — the spec is at /tmp/spec.md."));
  await m.onAssistantEnd(textMsg("Done — the spec is at /tmp/spec.md.", { stopReason: "stop" }));
  await tick();

  const rich = richOf(h.out.calls);
  show("message 1 (the WHOLE story in one message)", rich[0] ?? "");
  show("message 2 (final answer)", rich[1] ?? "");
  const m1 = rich[0] ?? "";
  const o1 = m1.indexOf("curl");
  const o2 = m1.indexOf("⚠️ error: 502");
  const o3 = m1.indexOf("FileNotFoundError");
  const o4 = m1.indexOf("Completed ✔️");
  const checks: [string, boolean][] = [
    ["exactly 2 persistent messages", rich.length === 2],
    ["✔ curl block survived into m1", o1 !== -1],
    ["✔ grep block survived into m1", m1.includes("sendRichMessageDraft")],
    ["502 error block documents the interruption", o2 !== -1],
    ["re-executed ✖ (exit code 1) is in the same log", o3 !== -1],
    ["✔ #4/#5 are in the same log", (m1.match(/⚙ bash ✔/g) ?? []).length >= 2],
    ["order: ✔✔ → 502 → ✖ → marker", o1 < o2 && o2 < o3 && o3 < o4],
    ["no duplicate error message (grace timer cancelled)", rich.length === 2 && !m1.includes("⚠ incomplete")],
    ["m2 is the answer", (rich[1] ?? "") === "Done — the spec is at /tmp/spec.md."],
  ];
  report(checks);
}

function report(checks: [string, boolean][]): void {
  console.log("\n   checks:");
  let ok = true;
  for (const [name, passed] of checks) {
    console.log(`     ${passed ? "✅" : "❌"} ${name}`);
    ok = ok && passed;
  }
  if (!ok) process.exitCode = 1;
}

function assert(cond: boolean, what: string): void {
  if (!cond) {
    console.error(`\n❌ ASSERTION FAILED: ${what}`);
    process.exit(1);
  }
}

await scenarioA();
await scenarioB();
console.log("\n" + (process.exitCode ? "❌ some checks failed" : "✅ all checks passed"));
