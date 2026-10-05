/**
 * T10 live verification for the md4x parser migration (docs/plans/
 * 2026-10-07-md4x-parser-migration.md §4.2). Sends the owner a numbered
 * sequence of messages exercising every mapped construct through the NEW
 * md4x pipeline (mdToBlocks — no heal, exactly what persistent sends use).
 *
 *   node --experimental-strip-types scripts/t10-live-check.ts
 * (reads TG_BOT_TOKEN / TG_CHAT_ID, like the other probes)
 *
 * The owner checks each message element-by-element in Telegram, then:
 *   - forwards the FOOTNOTE message (4) back to the bot (round-trip shape)
 *   - runs a real multi-tool task (streaming draft heal check)
 */
import { TelegramClient } from "../src/telegram-client.ts";
import { mdToBlocks } from "../src/rich-blocks.ts";

const token = process.env.TG_BOT_TOKEN;
const chatId = Number(process.env.TG_CHAT_ID);
if (!token || !chatId) {
  console.error("usage: TG_BOT_TOKEN=… TG_CHAT_ID=… node --experimental-strip-types scripts/t10-live-check.ts");
  process.exit(2);
}

const M1 = [
  "# T10-1 — inline + headings + divider",
  "",
  "**bold** __dunder-bold__ *italic* _underscore-italic_ ~~strike~~ ==mark== `code` [link](https://core.telegram.org/bots/api)",
  "",
  "Subscripts H~2~O and superscripts X^2^ in one line.",
  "",
  "Hard break with two trailing spaces:  ",
  "second line of the same paragraph",
  "",
  "## Heading level two with **bold inside**",
  "",
  "---",
  "",
  "After the divider.",
].join("\n");

const M2 = [
  "## T10-2 — lists (nested, task, ordered)",
  "",
  "- alpha",
  "  - alpha-1",
  "    - alpha-1-1 (three deep)",
  "  - alpha-2",
  "- beta with **bold**",
  "- [ ] unchecked task",
  "- [x] checked task",
  "",
  "1. one",
  "2. two",
  "",
  "5. starts at five",
  "6. six",
].join("\n");

const M3 = [
  "## T10-3 — table, quote, code",
  "",
  "| Name | Role |",
  "| --- | --- |",
  "| Ada | **engineer** |",
  "| Grace | `admiral` |",
  "",
  "> Quoted first line",
  "> Second line with **bold**",
  "",
  "```ts",
  "const x: number = 42;",
  "console.log(`value: ${x}`);",
  "```",
].join("\n");

const M4 = [
  "## T10-4 — footnotes (FORWARD THIS MESSAGE BACK)",
  "",
  "Defined[^a] and again[^a] and second[^b]; undefined[^zzz] stays literal.",
  "",
  "[^a]: First definition with **bold**.",
  "[^b]: Second definition.",
].join("\n");

const M5 = [
  "## T10-5 — math + anchors",
  "",
  "$$E = mc^2$$",
  "",
  "```math",
  "\\frac{a}{b} + c",
  "```",
  "",
  '<a name="sec-1"></a>',
  "Anchor block above this line.",
].join("\n");

const MESSAGES: [string, string][] = [
  ["1/5 inline", M1],
  ["2/5 lists", M2],
  ["3/5 table+quote+code", M3],
  ["4/5 footnotes", M4],
  ["5/5 math+anchors", M5],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  const client = new TelegramClient(token);
  for (const [label, md] of MESSAGES) {
    const blocks = mdToBlocks(md);
    try {
      const sent = await client.sendRichMessage(chatId, { blocks });
      console.log(`${label}: sent (message_id=${sent.message_id}, blocks=${blocks.length})`);
    } catch (err) {
      console.error(`${label}: FAILED`, err);
    }
    await sleep(400); // stay under the per-chat rate limit
  }
  console.log("done — streaming-draft check: run a real multi-tool task");
};

main();
