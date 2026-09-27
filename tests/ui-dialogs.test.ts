import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingDialogs, renderDialog, type DialogSpec, type PendingDialogsDeps } from "../src/ui-dialogs.ts";
import { FakeOut } from "./fake-pi.ts";

function deps(over: Partial<{ chatId: number | undefined; enabled: boolean; out: FakeOut; notes: string[] }> = {}): {
  deps: PendingDialogsDeps;
  out: FakeOut;
  notes: string[];
} {
  const out = over.out ?? new FakeOut();
  const notes = over.notes ?? [];
  const d: PendingDialogsDeps = {
    out,
    getChatId: () => ("chatId" in over ? over.chatId : 42), // explicit undefined (unpaired) must stay undefined
    enabled: () => over.enabled ?? true,
    notify: (m) => notes.push(m),
  };
  return { deps: d, out, notes };
}

test("renderDialog select: title + one numbered button row per option + cancel row, index-based callback data", () => {
  const r = renderDialog({ kind: "select", title: "Pick", options: ["a", "b"] }, 7, false);
  assert.ok(r.text.includes("<b>Pick</b>"));
  const rows = r.buttons as { text: string; callback_data: string }[][];
  // one button per row (the repo's list pattern) + a trailing cancel row
  assert.deepEqual(rows.map((row) => row[0].callback_data), ["da:7:0", "da:7:1", "dc:7"]);
  assert.ok(rows[0][0].text.startsWith("1. ") && rows[1][0].text.startsWith("2. "), "options are numbered");
});

test("renderDialog confirm: Yes/No buttons, message escaped, no cancel row, ❓ header", () => {
  const r = renderDialog({ kind: "confirm", title: "Sure?", message: "m & <x>" }, 3, false);
  assert.ok(r.text.startsWith("❓ <b>Sure?</b>"), `header is ❓ (got: ${r.text.split("\n")[0]})`);
  assert.ok(r.text.includes("Sure?") && r.text.includes("m &amp; &lt;x&gt;"));
  const flat = (r.buttons as { callback_data: string }[][]).flat();
  assert.deepEqual(flat.map((b) => b.callback_data), ["da:3:0", "da:3:1"]);
});

test("show: unpaired (no chatId) or disabled → undefined, nothing sent", async () => {
  const { deps: d1, out: out1 } = deps({ chatId: undefined });
  const p1 = new PendingDialogs(d1);
  assert.equal(await p1.show({ kind: "confirm", title: "t", message: "m" }), undefined);
  const { deps: d2, out: out2 } = deps({ enabled: false });
  const p2 = new PendingDialogs(d2);
  assert.equal(await p2.show({ kind: "confirm", title: "t", message: "m" }), undefined);
  assert.equal(out1.calls.length, 0);
  assert.equal(out2.calls.length, 0);
});

test("show + tgAnswer(option): resolves the race, stamps ✔️, releases the dialog", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  const id = await p.show({ kind: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(id, 1);
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  assert.equal(p.tgAnswer(1, { kind: "option", index: 1 }), true);
  assert.deepEqual(await answer, { kind: "option", index: 1 });
  assert.equal(p.isDialogMessage(100), false); // FakeOut's first send id (100) is released
  const lastEdit = out.calls.filter((c) => c.kind === "edit").pop()!;
  assert.ok(String(lastEdit.text).includes("Answered: b"));
});

test("tgAnswer on unknown id → false (stale tap), nothing sent", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  assert.equal(p.tgAnswer(99, { kind: "cancel" }), false);
  assert.equal(out.calls.length, 0);
});

test("tuiAnswered: releases the dialog, stamp says terminal, race resolves 'expired'", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "confirm", title: "Sure?", message: "m" });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tuiAnswered(1, "Yes");
  assert.deepEqual(await answer, { kind: "expired" });
  const lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
  assert.ok(String(lastEdit?.text).includes("terminal"));
});

test("input: reply-based message with cancel button; tgAnswer(text) resolves {kind:'text'}", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  const id = await p.show({ kind: "input", title: "Name", placeholder: "e.g. alpha" });
  assert.equal(id, 1);
  const sent = out.calls.filter((c) => c.kind === "send").pop()!;
  assert.ok(String(sent.text).includes("Reply to this message"));
  assert.ok(String(sent.text).includes("e.g. alpha"));
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  assert.equal(p.tgAnswer(1, { kind: "text", text: "hello" }), true);
  assert.deepEqual(await answer, { kind: "text", text: "hello" });
});

test("numbered select (>20 options): numbered list, numeric reply → option, non-numeric ignored (stays open)", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  const opts = Array.from({ length: 25 }, (_, i) => `opt${i}`);
  const id = await p.show({ kind: "select", title: "Many", options: opts });
  const sent = out.calls.filter((c) => c.kind === "send").pop()!;
  assert.ok(String(sent.text).includes("Reply with the option number"));
  assert.ok(String(sent.text).includes("25. opt24"));
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  assert.equal(p.tgAnswer(1, { kind: "text", text: "not a number" }), false, "ignored — dialog stays open");
  assert.equal(p.size, 1);
  assert.equal(p.tgAnswer(1, { kind: "text", text: " 25 " }), true, "whitespace-padded number accepted");
  assert.deepEqual(await answer, { kind: "option", index: 24 });
});

test("plainAnswerFor: plain messages route to pending text-answer dialogs (no reply-to needed)", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  assert.equal(p.plainAnswerFor("17"), undefined, "nothing pending");
  const id = await p.show({ kind: "select", title: "Many", options: Array.from({ length: 25 }, (_, i) => `opt${i}`) });
  assert.ok(id !== undefined, "chat known → dialog shown");
  // numbered: only a bare in-range number matches
  assert.equal(p.plainAnswerFor("17"), id, "bare number in range → the dialog");
  assert.equal(p.plainAnswerFor(" 17 "), id, "whitespace ok");
  assert.equal(p.plainAnswerFor("0"), undefined, "below range → prompt");
  assert.equal(p.plainAnswerFor("26"), undefined, "above range → prompt");
  assert.equal(p.plainAnswerFor("1.5"), undefined, "not an integer → prompt");
  assert.equal(p.plainAnswerFor("hello"), undefined, "free text never hijacked by a numbered dialog");
  assert.equal(p.plainAnswerFor("/status"), undefined, "commands keep routing as commands");
  // a button select (≤20 options) never takes the text path
  await p.show({ kind: "select", title: "Few", options: ["a", "b"] });
  assert.equal(p.plainAnswerFor("2"), id, "only the NUMBERED dialog matches numbers");
  // input/editor: ANY plain non-command text answers the oldest pending one
  const inId = await p.show({ kind: "input", title: "What's your name?" });
  assert.ok(inId !== undefined);
  assert.equal(p.plainAnswerFor("Mr. Bean"), inId, "free text → the pending input");
  assert.equal(p.plainAnswerFor("26"), inId, "a bare number OUT of range for the numbered dialog → input text");
  assert.equal(p.plainAnswerFor("17"), id, "an in-range number still wins for the numbered dialog");
  // released dialogs stop matching
  const a = new Promise<unknown>((res) => p.answer(inId, res));
  p.tgAnswer(inId, { kind: "text", text: "done" });
  await a;
  assert.equal(p.plainAnswerFor("Mr. Bean"), undefined, "released input no longer matches");
});

test("reply routing: isDialogMessage / dialogIdForMessage track the SENT message id", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  await p.show({ kind: "input", title: "t" }); // FakeOut sends message id 100
  assert.equal(p.isDialogMessage(100), true);
  assert.equal(p.dialogIdForMessage(100), 1);
  assert.equal(p.isDialogMessage(101), false);
  // The real wrapper always attaches the race resolver right after show() —
  // do the same so tuiAnswered's release can deliver (and clear the routing).
  const a = new Promise<unknown>((res) => p.answer(1, res));
  p.tuiAnswered(1, undefined);
  assert.equal(p.isDialogMessage(100), false, "released after TUI-side answer");
  assert.deepEqual(await a, { kind: "expired" });
});

test("cancelAll: stamps every pending and releases with 'expired'", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "confirm", title: "A", message: "m" });
  await p.show({ kind: "input", title: "B" });
  const a1 = new Promise<unknown>((res) => p.answer(1, res));
  const a2 = new Promise<unknown>((res) => p.answer(2, res));
  p.cancelAll();
  assert.deepEqual(await a1, { kind: "expired" });
  assert.deepEqual(await a2, { kind: "expired" });
  assert.equal(p.size, 0);
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 2);
  assert.ok(edits.every((e) => String(e.text).includes("Expired")));
});

test("show: send failure → notify + undefined (TUI-only fallback)", async () => {
  const out = new FakeOut();
  out.sendFailsWith = new Error("network down");
  const notes: string[] = [];
  const d: PendingDialogsDeps = { out, getChatId: () => 42, enabled: () => true, notify: (m) => notes.push(m) };
  const p = new PendingDialogs(d);
  assert.equal(await p.show({ kind: "confirm", title: "t", message: "m" }), undefined);
  assert.equal(p.size, 0);
  assert.ok(notes.some((n) => n.includes("dialog send failed")));
});

// ── in-flight race: a TG/TUI answer can arrive while the dialog's send is
// still in flight (the callback round-trip beat the sendMessage response).
// The stamp must use the real message id (not the -1 placeholder) and the
// answer must not be lost. ──

function slowOut() {
  const out = new FakeOut();
  let rel: () => void = () => {};
  // stable function — `return { release }` would capture the initial ref
  const release = () => rel();
  const realSend = out.send;
  out.send = async (chatId, text, opts) => {
    await new Promise<void>((r) => {
      rel = r;
    });
    return realSend(chatId, text, opts);
  };
  return { out, release };
}

test("in-flight: tgAnswer during the send is deferred — stamp uses the real id, answer reaches a late-attached resolver", async () => {
  const { out, release } = slowOut();
  const { deps: d } = deps({ out });
  const p = new PendingDialogs(d);
  const showP = p.show({ kind: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(p.size, 1);
  await new Promise((r) => setImmediate(r)); // let show() pass the (absent) onShown and enter the slow send (the gate arms there)
  assert.equal(p.tgAnswer(1, { kind: "option", index: 0 }), true, "accepted while in flight");
  release();
  assert.equal(await showP, 1, "show still resolves the id");
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 1, "the stamp went out exactly once");
  assert.equal(edits[0]!.messageId, 100, "the stamp used the real message id (not -1)");
  // The wrapper attaches the race resolver only AFTER show() returns — the
  // deferred answer must survive until then.
  const got: unknown[] = [];
  p.answer(1, (a) => got.push(a));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [{ kind: "option", index: 0 }], "the deferred answer was delivered");
  assert.equal(p.size, 0);
});

test("in-flight: tuiAnswered during the send is deferred — stamp uses the real id, entry cleaned up", async () => {
  const { out, release } = slowOut();
  const { deps: d } = deps({ out });
  const p = new PendingDialogs(d);
  const showP = p.show({ kind: "select", title: "Pick", options: ["a", "b"] });
  await new Promise((r) => setImmediate(r)); // let show() pass the (absent) onShown and enter the slow send (the gate arms there)
  p.tuiAnswered(1, "a"); // the TUI side wins while the send is in flight
  release();
  await showP;
  const edits = out.calls.filter((c) => c.kind === "edit");
  assert.equal(edits.length, 1, "the 💻 stamp went out exactly once");
  assert.equal(edits[0]!.messageId, 100, "the stamp used the real message id (not -1)");
  assert.ok(String(edits[0]!.text).includes("terminal"));
  const got: unknown[] = [];
  p.answer(1, (a) => got.push(a));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.size, 0, "no leaked entry");
});

test("hasActive: true while a dialog with the title is pending, false after resolution", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(p.hasActive("Pick"), true, "a pending dialog with the title is active");
  assert.equal(p.hasActive("Other"), false, "unknown title is not active");
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tuiAnswered(1, "a");
  await answer;
  assert.equal(p.size, 0);
  assert.equal(p.hasActive("Pick"), false, "a resolved dialog is no longer active");
  void out;
});

test("confirm stamps the option NAME (Yes/No), not a bare index", async () => {
  for (const [index, name] of [
    [0, "Yes"],
    [1, "No"],
  ] as const) {
    const made = deps();
    const p = new PendingDialogs(made.deps);
    const out = made.out;
    await p.show({ kind: "confirm", title: "Sure?", message: "m" });
    const answer = new Promise<unknown>((res) => p.answer(1, res));
    p.tgAnswer(1, { kind: "option", index });
    await answer;
    const lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
    assert.ok(
      String(lastEdit?.text).includes(`Answered: ${name}`) && !String(lastEdit?.text).includes("#"),
      `the ${name} tap stamps 'Answered: ${name}' (got: ${lastEdit?.text})`,
    );
  }
});

test("stamp = original question + status line, edited as HTML (bold title kept)", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "confirm", title: "Sure?", message: "m" });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tgAnswer(1, { kind: "option", index: 0 });
  await answer;
  const lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
  assert.equal(lastEdit?.text, "❓ <b>Sure?</b>\nm\n✔️ Answered: Yes");
  assert.equal(lastEdit?.opts?.parseMode, "HTML", "stamp keeps the original HTML formatting");
});

test("stamp: numbered select names the option with its number", async () => {
  const opts = Array.from({ length: 21 }, (_, i) => `o${i}`); // > MAX_BUTTON_OPTIONS → numbered
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "select", title: "Pick", options: opts });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tgAnswer(1, { kind: "text", text: "5" }); // numbered reply → option 4
  await answer;
  const lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
  assert.ok(String(lastEdit?.text).includes("✔️ Answered: #5 — o4"), `got: ${lastEdit?.text}`);
});

test("stamp: input answer text is included, truncated when long", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "input", title: "Name", placeholder: "p" });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tgAnswer(1, { kind: "text", text: "x".repeat(200) });
  await answer;
  const t = String(out.calls.filter((c) => c.kind === "edit").pop()?.text ?? "");
  assert.ok(t.includes("✔️ Answered: ") && t.includes("…"), `truncated with ellipsis, got: ${JSON.stringify(t.slice(-60))}`);
  assert.ok(!t.includes("x".repeat(121)), "the 200-char text is clipped");
});

test("stamp: TUI confirm answer maps the boolean to Yes/No", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "confirm", title: "Sure?", message: "m" });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tuiAnswered(1, false);
  await answer;
  const lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
  assert.equal(lastEdit?.text, "❓ <b>Sure?</b>\nm\n💻 Answered in the terminal: No");
});

test("stamp: TUI cancel and cancelAll read as status lines", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  const out = made.out;
  await p.show({ kind: "confirm", title: "Sure?", message: "m" });
  const answer = new Promise<unknown>((res) => p.answer(1, res));
  p.tuiAnswered(1, undefined);
  await answer;
  let lastEdit = out.calls.filter((c) => c.kind === "edit").pop();
  assert.equal(lastEdit?.text, "❓ <b>Sure?</b>\nm\n💻 Cancelled in the terminal");

  const made2 = deps();
  const p2 = new PendingDialogs(made2.deps);
  await p2.show({ kind: "confirm", title: "Again?", message: "n" });
  p2.cancelAll();
  lastEdit = made2.out.calls.filter((c) => c.kind === "edit").pop();
  assert.equal(lastEdit?.text, "❓ <b>Again?</b>\nn\n⚠️ Expired");
});

test("onShown is awaited BEFORE the dialog message is sent (the mirror's draft segment must land first)", async () => {
  const out = new FakeOut();
  const order: string[] = [];
  const d: PendingDialogsDeps = {
    out,
    getChatId: () => 42,
    enabled: () => true,
    onShown: async () => {
      await new Promise((r) => setTimeout(r, 20)); // simulate the segment's persistent send
      order.push("shown");
    },
  };
  const p = new PendingDialogs(d);
  await p.show({ kind: "confirm", title: "t", message: "m" });
  order.push("sent");
  assert.deepEqual(order, ["shown", "sent"], "onShown completes before the dialog send");
  assert.equal(out.calls.filter((c) => c.kind === "send").length, 1);
});
