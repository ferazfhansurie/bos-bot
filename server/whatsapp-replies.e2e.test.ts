import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { WhatsAppStore } from "./whatsapp-store.ts";

it("owner configures reply access, actual turns mount it, disconnected sends fail closed and revocation stays restricted", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: "/fixture-never-opened" });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const capture = new WhatsAppStore(join(fixture.info.dataDir, "whatsapp", "messages.db"));
    capture.insert({ accountId: "60111111111@c.us", id: "fixture-inbound", chatId: "60222222222@c.us", from: "60222222222@c.us", chatName: "fixture client", author: null, fromMe: false, timestamp: Date.now() / 1000, type: "chat", body: "fixture hello", hasMedia: false });
    capture.close();
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: true })).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/whatsapp-replies`)).body.policy).toBeNull();
    expect((await api("PUT", `/api/bots/${bot.id}/whatsapp-replies`, { accountId: "60111111111@c.us", chatIds: [], autoDispatch: false, outreach: false })).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/whatsapp-replies`)).body.policy.chatIds).toEqual([]);
    expect((await api("PUT", `/api/bots/${bot.id}/whatsapp-replies`, { accountId: "60111111111@c.us", chatIds: null })).status).toBe(200);
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "fixture reply tool setup", "--url", fixture.info.url]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const connector = Object.values(dump.mcpConfig.mcpServers).find((s: any) => s.env?.OMB_CONNECTOR_TOKEN) as any;
    expect(connector.env.OMB_WHATSAPP_REPLIES).toBe("1");
    expect(dump.systemPrompt).toContain("No further approval is needed for these replies");
    expect(dump.systemPrompt).not.toContain("You cannot send, reply to, or mark WhatsApp");
    const token = connector.env.OMB_CONNECTOR_TOKEN;
    const ownerChoices = await api("GET", "/api/whatsapp/permissions");
    expect(ownerChoices.status).toBe(200);
    expect(ownerChoices.body).toEqual({ accountId: null, chats: [] });
    const botChoices = await api("GET", "/api/whatsapp/permissions", undefined, token);
    expect([401, 403]).toContain(botChoices.status);
    const deniedConfig = await api("PUT", `/api/bots/${bot.id}/whatsapp-replies`, { accountId: "60111111111@c.us", chatIds: null }, token);
    expect([401, 403]).toContain(deniedConfig.status);
    expect((await api("POST", "/api/internal/connectors/whatsapp/reply", { account_id: "60111111111@c.us", chat_id: "60222222222@c.us", message_id: "fixture-inbound", text: "hello" }, token)).status).toBe(403);
    const unavailableHistory = await api("POST", "/api/internal/connectors/whatsapp/sync-history", { account_id: "60111111111@c.us", chat_id: "60222222222@c.us" }, token);
    expect(unavailableHistory.status).toBe(409);
    expect(unavailableHistory.body.stage).toBe("not_linked");
    expect((await api("PUT", `/api/bots/${bot.id}/whatsapp-replies`, null)).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/whatsapp-replies`)).body.policy.chatIds).toEqual([]);
    expect((await api("GET", "/api/internal/connectors/whatsapp/messages", undefined, token)).status).toBe(403);
    await runControlOmb(["interrupt", "--bot", bot.id, "--task", bot.threadId, "--url", fixture.info.url]);
  } finally { await fixture.close(); }
}, 60000);
