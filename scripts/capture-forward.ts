/**
 * One-off T10 capture: poll getUpdates for ~90 s and dump every raw update
 * JSON (looking for a forwarded rich_message). Run ONLY while the bot is
 * stopped (two pollers on one token conflict).
 *
 *   node --experimental-strip-types scripts/capture-forward.ts
 */
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(process.env.USERPROFILE! + "/.pi/agent/pi-telegram.json", "utf8"));
const BASE = `https://api.telegram.org/bot${cfg.botToken}`;

const deadline = Date.now() + 90_000;
let offset = 0;
while (Date.now() < deadline) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 10, allowed_updates: ["message", "edited_message"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { ok: boolean; result?: { update_id: number; message?: unknown }[] };
    if (!data.ok) { console.error("API error:", JSON.stringify(data)); break; }
    for (const u of data.result ?? []) {
      offset = u.update_id + 1;
      const msg = u.message as { from?: { is_bot?: boolean }; text?: string; forward_from_message_id?: number } | undefined;
      if (msg?.from?.is_bot) continue; // our own echoes
      console.log(`\n=== update ${u.update_id} ===`);
      console.log(JSON.stringify(u, null, 1));
    }
  } catch (err) {
    console.error("poll error:", String(err));
  }
}
console.log("\ncapture window over");
