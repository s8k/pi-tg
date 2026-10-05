/**
 * Live probe: do the server + PC client accept the new block/entity shapes?
 *   node --experimental-strip-types scripts/probe-footnotes.ts
 * Sends ONE rich message containing:
 *   - a paragraph with two [^id] footnote references (RichTextReference)
 *   - a $$…$$ mathematical expression block
 *   - a ```math fence block
 *   - an anchor block (zero content)
 * Exits after send (or prints the 400 description).
 */
import { TelegramClient } from "../src/telegram-client.ts";
import { mdToBlocks, blocksToPlainText } from "../src/rich-blocks.ts";

const token = process.env.TG_BOT_TOKEN;
const chatId = Number(process.env.TG_CHAT_ID);
if (!token || !chatId) {
  console.error("usage: TG_BOT_TOKEN=… TG_CHAT_ID=… node --experimental-strip-types scripts/probe-footnotes.ts");
  process.exit(2);
}

const doc = [
  "Footnote probe 2026-10-06:",
  "",
  "Text with a reference[^id1] and another one[^id2].",
  "",
  "Inline math: $$E = mc^2$$ on its own line.",
  "",
  "```math",
  "\\frac{a}{b} + c",
  "```",
  "",
  "<a name=\"probe-anchor\"></a>",
  "",
  "[^id1]: Definition of the first footnote.",
  "[^id2]: Definition of the second footnote.",
].join("\n");

const blocks = mdToBlocks(doc);
console.log("== blocks ==");
console.log(JSON.stringify(blocks, null, 1));
console.log("== plain rung ==");
console.log(blocksToPlainText(blocks));

const client = new TelegramClient(token, {});
try {
  const msg = await client.sendRichMessage(chatId, { blocks });
  console.log("SENT ok — message_id", msg.message_id);
  console.log("Check the PC client: reference markers, rendered math (or raw LaTeX), no anchor trace.");
} catch (err) {
  console.error("SEND FAILED:", String(err));
  process.exitCode = 1;
}
