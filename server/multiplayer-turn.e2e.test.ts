import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("delivers a shared room message to a local bot and returns its answer", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await api("POST", "/api/bots", {
      name: "Shared reply bot",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const me = await api("GET", "/api/multiplayer/me");
    const dm = await api("POST", "/api/multiplayer/dm", { targetId: `${me.body.homeId}:bot:${bot.id}` });
    expect(dm.status).toBe(201);
    const roomId = dm.body.room.id;
    const sent = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "say hello", sendId: "shared-bot-send-1" });
    expect(sent.status).toBe(201);
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
      return read.body.messages.find((message: any) => message.actor.kind === "bot");
    }, { timeout: 20_000, interval: 250 }).toMatchObject({
      actor: { homeId: me.body.homeId, kind: "bot", localId: bot.id },
      responseTo: sent.body.message.id,
    });
  } finally {
    await fixture.close();
  }
}, 40_000);
