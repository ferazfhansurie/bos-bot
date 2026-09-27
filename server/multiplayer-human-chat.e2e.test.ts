import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("invokes an owned bot inside a human group without giving it membership", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const me = (await api("GET", "/api/multiplayer/me")).body;
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api("POST", "/api/auth/pair", { code: pairing.body.code, label: "Fixture teammate" });
    const teammate = "teammate-home:person:owner";
    expect((await api("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.body.session.id, personId: teammate, name: "Teammate" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Ultron", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const botId = `${me.homeId}:bot:${bot.id}`;
    expect((await api("POST", "/api/multiplayer/rooms", { name: "Forged grant", memberIds: [teammate, botId] }, paired.body.token)).status).toBe(400);
    expect((await api("POST", "/api/multiplayer/dm", { targetId: botId }, paired.body.token)).status).toBe(403);
    await api("POST", "/api/bots", { name: "Spare", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    const direct = await api("POST", "/api/multiplayer/dm", { targetId: botId });
    expect(direct.status).toBe(201);
    const directSend = await api("POST", `/api/multiplayer/rooms/${direct.body.room.id}/messages`, { text: "hello", sendId: "direct-only" });
    expect(directSend.body.message.botTargets).toEqual([botId]);
    const created = await api("POST", "/api/multiplayer/rooms", { name: "Humans", memberIds: [me.actorId, teammate] });
    expect(created.status).toBe(201);
    const room = created.body.room;
    expect(room.kind).toBe("group");
    const path = `/api/multiplayer/rooms/${room.id}`;
    expect((await api("GET", `${path}/bots`)).body.bots.map((b: any) => b.id)).toContain(botId);
    expect((await api("GET", `${path}/bots`, undefined, paired.body.token)).body.bots).toEqual([]);
    for (const text of ["hello everyone", "`@Ultron`", "> @Ultron quoted", "@everyone hi"]) {
      const sent = await api("POST", `${path}/messages`, { text, sendId: `human-${Math.random().toString(16).slice(2)}` });
      expect(sent.status).toBe(201);
      expect(sent.body.message.botTargets).toEqual([]);
    }
    expect((await api("GET", `${path}/messages`)).body.messages.every((m: any) => m.actor.kind === "person")).toBe(true);
    const request = { text: "@Ultron say hello", sendId: "invoke-once", botTargets: [botId] };
    const sent = await api("POST", `${path}/messages`, request);
    expect(sent.status).toBe(201);
    expect(sent.body.message.botTargets).toEqual([botId]);
    expect((await api("POST", `${path}/messages`, request)).status).toBe(200);
    await expect.poll(async () => (await api("GET", `${path}/messages`)).body.messages.filter((m: any) => m.actor.kind === "bot" && m.kind !== "activity"), { timeout: 15_000, interval: 100 }).toHaveLength(1);
    expect((await api("GET", "/api/multiplayer/rooms")).body.rooms.find((candidate: any) => candidate.id === room.id).memberIds).toEqual([me.actorId, teammate]);
    expect((await api("POST", `${path}/messages`, { text: "@Ultron help", sendId: "forged", botTargets: [botId] }, paired.body.token)).status).toBe(403);
    const older = await api("GET", `${path}/messages?before=4&limit=2`);
    expect(older.body.messages.map((m: any) => m.sequence)).toEqual([2, 3]);
    expect(older.body.hasMore).toBe(true);
    expect((await api("PATCH", path, { revision: 1, memberIds: [me.actorId, teammate] }, paired.body.token)).status).toBe(403);
  } finally { await fixture.close(); }
}, 30_000);
