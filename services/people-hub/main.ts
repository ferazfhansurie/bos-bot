/** Process entry for the people hub (pm2 behind a cloudflared tunnel).
 * Env: PEOPLE_HUB_PORT, PEOPLE_HUB_DATA, PEOPLE_HUB_ORIGIN, RESEND_API_KEY
 * (or RESEND_API_KEY_FILE), PEOPLE_HUB_FROM. The Resend key is read here and
 * never logged. */
import { readFileSync } from "node:fs";
import { startHub } from "./hub.ts";

const keyFile = process.env.RESEND_API_KEY_FILE;
const key = (process.env.RESEND_API_KEY ?? (keyFile ? readFileSync(keyFile, "utf8") : "")).trim();
const from = process.env.PEOPLE_HUB_FROM ?? "BOS Bot <noreply@bosbot.my>";
const port = Number(process.env.PEOPLE_HUB_PORT ?? 3375);
const origin = (process.env.PEOPLE_HUB_ORIGIN ?? "https://people.bosbot.my").replace(/\/$/, "");

const sendEmail = key ? async (to: string, subject: string, html: string, text: string) => {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`invite email failed (${response.status})`);
} : undefined;

startHub({ port, dataDir: process.env.PEOPLE_HUB_DATA ?? `${process.env.HOME}/bos-people-hub/data`, publicOrigin: origin, sendEmail });
console.log(`people hub listening on 127.0.0.1:${port} as ${origin} (email ${sendEmail ? "on" : "off"})`);
