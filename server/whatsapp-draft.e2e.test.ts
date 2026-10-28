import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { WhatsAppStore } from "./whatsapp-store.ts";

// Draft mode: a bot that prepares client replies may send only from a turn
// the owner started. An unattended run (routine, webhook, the prep turn
// itself) is refused before anything reaches WhatsApp.
it("draft mode refuses WhatsApp sends from unattended turns but not from the owner's own turn", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: "/fixture-never-opened" });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const tokenAfter = async (since: number) => {
    await expect.poll(() => statSync(fixture.fixtureDumpPath, { throwIfNoEntry: false })?.mtimeMs ?? 0, { timeout: 15000 }).toBeGreaterThan(since);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    return (Object.values(dump.mcpConfig.mcpServers).find((s: any) => s.env?.OMB_CONNECTOR_TOKEN) as any).env.OMB_CONNECTOR_TOKEN as string;
  };
  const reply = { account_id: "60111111111@c.us", chat_id: "60222222222@c.us", message_id: "fixture-inbound", text: "hello" };
  const send = { account_id: "60111111111@c.us", chat_id: "60222222222@c.us", send_key: "draft-fixture", text: "hello" };
  try {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const capture = new WhatsAppStore(join(fixture.info.dataDir, "whatsapp", "messages.db"));
    capture.insert({ accountId: "60111111111@c.us", id: "fixture-inbound", chatId: "60222222222@c.us", from: "60222222222@c.us", chatName: "fixture client", author: null, fromMe: false, timestamp: Date.now() / 1000, type: "chat", body: "fixture hello", hasMedia: false });
    capture.close();
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: true })).status).toBe(200);
    expect((await api("PUT", `/api/bots/${bot.id}/whatsapp-replies`, { accountId: "60111111111@c.us", chatIds: ["60222222222@c.us"], autoDispatch: true, outreach: true, draft: true })).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/whatsapp-replies`)).body.policy).toMatchObject({ autoDispatch: true, draft: true });

    // The owner's turn reaches the normal checks (no linked account here).
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "do it", "--url", fixture.info.url]);
    const owner = await tokenAfter(0);
    const attended = await api("POST", "/api/internal/connectors/whatsapp/reply", reply, owner);
    expect(attended.status).toBe(403);
    expect(attended.body.error).not.toContain("draft mode");
    await runControlOmb(["interrupt", "--bot", bot.id, "--task", bot.threadId, "--url", fixture.info.url]);

    // A routine run is unattended: refused for draft mode, reply and send.
    const before = statSync(fixture.fixtureDumpPath).mtimeMs;
    const { body: { routine } } = await api("POST", "/api/routines", { name: "Draft fixture", botId: bot.id, prompt: "Report.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    const unattended = await tokenAfter(before);
    for (const [path, body] of [["reply", reply], ["send", send]] as const) {
      const refused = await api("POST", `/api/internal/connectors/whatsapp/${path}`, body, unattended);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("draft mode");
    }
  } finally { await fixture.close(); }
}, 60000);
