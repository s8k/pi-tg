import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.pi/agent/pi-telegram.json", "utf8"));
const api = (m, b) => fetch(`https://api.telegram.org/bot${cfg.botToken}/${m}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const p = (t) => ({ type: "paragraph", text: t });
const item = (text, nested) => ({ blocks: [p(text), ...(nested ? [nested] : [])] });
// 0: flat list via sendRichMessage (regression — our current wire method)
const t0 = await api("sendRichMessage", { chat_id: cfg.ownerChatId, rich_message: { blocks: [{ type: "list", items: [{ blocks: [p("flat one")] }, { blocks: [p("flat two")] }] }] } });
console.log("0 flat:", t0.status, t0.body.ok ? "OK" : t0.body.description, t0.body.result?.message_id);
// A: nested ul (user's example shape)
const a = await api("sendRichMessage", { chat_id: cfg.ownerChatId, rich_message: { blocks: [{ type: "list", items: [
  item("Major Project Deliverables", { type: "list", items: [item("Phase 1: Planning & Setup"), item("Phase 2: Build")] }),
] }] } });
console.log("A nested-ul:", a.status, a.body.ok ? "OK" : a.body.description, a.body.result?.message_id);
// B: 3 levels deep
const b = await api("sendRichMessage", { chat_id: cfg.ownerChatId, rich_message: { blocks: [{ type: "list", items: [
  item("L1", { type: "list", items: [item("L2", { type: "list", items: [item("L3")] })] }),
] }] } });
console.log("B 3-deep:", b.status, b.body.ok ? "OK" : b.body.description);
// C: nested ordered inside unordered
const c = await api("sendRichMessage", { chat_id: cfg.ownerChatId, rich_message: { blocks: [{ type: "list", items: [
  item("parent", { type: "list", items: [{ blocks: [p("1.1")], type: "1", value: 1 }, { blocks: [p("1.2")], type: "1", value: 2 }] }),
  item("sibling"),
] }] } });
console.log("C nested-ol:", c.status, c.body.ok ? "OK" : c.body.description);
// D: echo of A if it landed
if (a.body.result?.message_id) {
  const g = await api("getMessage", { message_id: a.body.result.message_id });
  console.log("A echo:", JSON.stringify(g.body.result?.rich_message?.blocks ?? null).slice(0, 500));
}
// E: echo shape
const g = await api("getMessage", { message_id: 1418 });
console.log("E echo keys:", Object.keys(g.body.result ?? {}));
console.log("E echo:", JSON.stringify(g.body.result?.rich_message ?? g.body.result?.blocks ?? null).slice(0, 700));
// F: nested list item with a checkbox in the nested list? skip. F: sibling split — two top lists under one parent item?
const f = await api("sendRichMessage", { chat_id: cfg.ownerChatId, rich_message: { blocks: [{ type: "list", items: [
  item("parent", { type: "list", items: [item("child-a"), item("child-b")] }),
  item("parent2", { type: "list", items: [item("child2")] }),
] }] } });
console.log("F two nested under siblings:", f.status, f.body.ok ? "OK" : f.body.description);
