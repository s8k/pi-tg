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

test("renderDialog confirm: Yes/No buttons, message escaped, no cancel row", () => {
  const r = renderDialog({ kind: "confirm", title: "Sure?", message: "m & <x>" }, 3, false);
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
  assert.ok(String(lastEdit.text).includes("answered: b"));
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

test("reply routing: isDialogMessage / dialogIdForMessage track the SENT message id", async () => {
  const made = deps();
  const p = new PendingDialogs(made.deps);
  await p.show({ kind: "input", title: "t" }); // FakeOut sends message id 100
  assert.equal(p.isDialogMessage(100), true);
  assert.equal(p.dialogIdForMessage(100), 1);
  assert.equal(p.isDialogMessage(101), false);
  p.tuiAnswered(1, undefined);
  assert.equal(p.isDialogMessage(100), false, "released after TUI-side answer");
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
  assert.ok(edits.every((e) => String(e.text).includes("expired")));
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
