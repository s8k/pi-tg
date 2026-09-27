// TEMP PROBE (delete after diagnosis): draft vs persistent message vs dialog
// layout. Fully automatic — the user only WATCHES. Phases:
//   A) draft 1 "PROBE-A"          -> sits at the bottom (the working draft)
//   B) persistent rich "PROBE-B"  -> QUESTION 1: does the A draft DISAPPEAR?
//   C) dialog "PROBE-C" + buttons -> QUESTION 2: where does it land (vs B)?
//   E) draft 1 "PROBE-E"          -> QUESTION 3: where does the re-sent draft
//                                     land vs the dialog (above/below)?
const fs = await import("node:fs");
const CFG = JSON.parse(await fs.promises.readFile(process.env.USERPROFILE + "/.pi/agent/pi-telega.json", "utf8"));
const TOKEN = CFG.botToken;
const CHAT = CFG.ownerChatId as number;
const api = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => (await r.json()).ok);

const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

say("PHASE A: draft 1 'PROBE-A WORKING'");
say(`A ok=${await api("sendRichMessageDraft", { chat_id: CHAT, draft_id: 1, rich_message: { markdown: "**PROBE-A** — WORKING draft (ephemeral)" }, can_stop: true, keep_on_stop: true })}`);
await sleep(8000); // let the user register the draft

say("PHASE B: persistent rich message 'PROBE-B work log' — watch: does PROBE-A vanish?");
say(`B ok=${await api("sendRichMessage", { chat_id: CHAT, rich_message: { markdown: "**PROBE-B** — work log (persistent message)" } })}`);
await sleep(6000);

say("PHASE C: dialog 'PROBE-C' with buttons — watch: where does it land? (no tap needed)");
say(`C ok=${await api("sendMessage", {
  chat_id: CHAT,
  text: "❓ <b>PROBE-C</b> — dialog message (no tap needed, just watch where I sit)",
  parse_mode: "HTML",
  reply_markup: { inline_keyboard: [[{ text: "✅ Yes", callback_data: "probe:ignore" }, { text: "❌ No", callback_data: "probe:ignore" }]] },
})}`);
await sleep(18000); // pause so the layout is stable before the re-sent draft

say("PHASE E: re-sending draft 1 'PROBE-E CONTINUING' — watch: above or below PROBE-C?");
say(`E ok=${await api("sendRichMessageDraft", { chat_id: CHAT, draft_id: 1, rich_message: { markdown: "**PROBE-E** — CONTINUING draft (same id 1, re-sent)" }, can_stop: true, keep_on_stop: true })}`);
await sleep(3000);

say("DONE. Report per client: (1) did PROBE-A vanish after B? (2) where did C land? (3) is E above or below C?");
process.exit(0);
