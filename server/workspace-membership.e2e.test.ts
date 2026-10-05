import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("grants a guest one room's bots without exposing another room or home chats", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const home = (await api("GET", "/api/multiplayer/me")).body;
    const deviceCode = (await api("POST", "/api/auth/pairing", { scopes: ["client"] })).body.code;
    const device = (await api("POST", "/api/auth/pair", { code: deviceCode })).body;
    expect((await api("GET", "/api/multiplayer/servers", undefined, device.token)).body.servers[0]).toMatchObject({ actorId: home.actorId, role: "owner" });
    expect((await api("GET", "/api/multiplayer/me", undefined, device.token)).body.actorId).toBe(home.actorId);
    const opened = (await api("POST", "/api/auth/pairing", { scopes: ["peer"] })).body;
    const guest = (await api("POST", "/api/auth/pair", { code: opened.code })).body;
    const actorId = "guest-server:person:owner";
    expect((await api("POST", "/api/multiplayer/actor-bindings", { sessionId: guest.session.id, personId: actorId, name: "Fixture guest" })).status).toBe(200);
    expect((await api("PUT", `/api/multiplayer/members/${encodeURIComponent(actorId)}`, { role: "client-guest" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Grant fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const botId = `${home.homeId}:bot:${bot.id}`;
    const path = "/api/multiplayer/rooms";
    const allowed = (await api("POST", path, { name: "Invited", memberIds: [home.actorId, actorId] })).body.room;
    const privateRoom = (await api("POST", "/api/multiplayer/dm", { targetId: botId })).body.room;
    const roomPath = `${path}/${allowed.id}`;
    expect((await api("GET", `${roomPath}/bots`, undefined, guest.token)).body.bots).toEqual([]);
    expect((await api("PUT", `${roomPath}/bot-grants`, { botIds: [botId] }, guest.token)).status).toBe(403);
    expect((await api("PUT", `/api/multiplayer/members/${encodeURIComponent(actorId)}`, { role: "admin" }, guest.token)).status).toBe(403);
    expect((await api("PUT", `${roomPath}/bot-grants`, { botIds: [botId] })).status).toBe(200);
    expect((await api("GET", `${roomPath}/bots`, undefined, guest.token)).body.bots.map((item: any) => item.id)).toEqual([botId]);
    expect((await api("GET", path, undefined, guest.token)).body.rooms.map((room: any) => room.id)).toEqual([allowed.id]);
    expect((await api("GET", `${path}/${privateRoom.id}/messages`, undefined, guest.token)).status).toBe(404);
    expect((await api("GET", `/api/threads/${bot.threadId}/messages`, undefined, guest.token)).status).toBe(403);
    expect((await api("POST", path, { name: "Forged", memberIds: [home.actorId, actorId] }, guest.token)).status).toBe(403);
    const sent = await api("POST", `${roomPath}/messages`, { text: "@Grant fixture hello", sendId: "guest-request", botTargets: [botId] }, guest.token);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.message.actor).toEqual({ homeId: "guest-server", kind: "person", localId: "owner" });
    await expect.poll(async () => (await api("GET", `${roomPath}/messages`, undefined, guest.token)).body.messages.some((message: any) => message.actor.kind === "bot" && message.responseTo === sent.body.message.id && message.kind !== "activity"), { timeout: 15000 }).toBe(true);
    expect((await api("PUT", `${roomPath}/bot-grants`, { botIds: [] })).status).toBe(200);
    expect((await api("GET", `${roomPath}/bots`, undefined, guest.token)).body.bots).toEqual([]);
    expect((await api("POST", `${roomPath}/messages`, { text: "@Grant fixture again", sendId: "after-revoke", botTargets: [botId] }, guest.token)).status).toBe(403);
    const ownServers = (await api("GET", "/api/multiplayer/servers")).body.servers;
    expect(ownServers).toEqual([expect.objectContaining({ homeId: home.homeId, actorId: home.actorId, role: "owner", home: true })]);
    expect((await api("GET", `/api/multiplayer/servers/${home.homeId}/me`)).body.homeId).toBe(home.homeId);
    expect((await api("GET", "/api/multiplayer/servers", undefined, guest.token)).status).toBe(403);
    expect((await api("PUT", `/api/multiplayer/members/${encodeURIComponent(actorId)}`, { role: "admin" })).status).toBe(200);
    expect((await api("PUT", `${roomPath}/bot-grants`, { botIds: [botId] }, guest.token)).status).toBe(200);
    expect((await api("GET", `${roomPath}/members`, undefined, guest.token)).body.members.find((member: any) => member.actorId === actorId).role).toBe("admin");
  } finally { await fixture.close(); }
}, 40000);
