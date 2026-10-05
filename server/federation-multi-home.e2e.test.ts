import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { MultiplayerLinks } from "./multiplayer-links.ts";

it("joins two generic servers as one guest while retaining home identity and isolated grants", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-multi-home-"));
  const fixtures: VerificationServer[] = [];
  const actorId = "joining-home:person:owner";
  const actor = { homeId: "joining-home", kind: "person", localId: "owner" };
  const origins = ["https://team-one.example.org", "https://team-two.example.org"];
  const request = async (fixture: VerificationServer, method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, fixture.info.url), { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    for (let index = 0; index < 2; index++) fixtures.push(await launchVerificationServer());
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      const index = origins.indexOf(url.origin);
      if (index < 0) throw new Error("unexpected fixture destination");
      return fetch(new URL(url.pathname + url.search, fixtures[index]!.info.url), init);
    };
    const file = join(folder, "links.json");
    const links = new MultiplayerLinks(file, "joining-home", fetcher);
    const joined: Array<{ homeId: string; roomId: string; privateRoomId: string; botId: string; localBotId: string }> = [];
    for (const [index, fixture] of fixtures.entries()) {
      const me = (await request(fixture, "GET", "/api/multiplayer/me")).body;
      const pairing = await request(fixture, "POST", "/api/auth/pairing", { scopes: ["peer"] });
      expect(pairing.status).toBe(200);
      const guest = await request(fixture, "POST", "/api/auth/pair", { code: pairing.body.code });
      expect(guest.status).toBe(200);
      expect((await request(fixture, "POST", "/api/multiplayer/actor-bindings", {
        sessionId: guest.body.session.id, personId: actorId, name: "Joining fixture owner",
      })).status).toBe(200);
      expect((await request(fixture, "PUT", `/api/multiplayer/members/${encodeURIComponent(actorId)}`, { role: "client-guest" })).status).toBe(200);
      const createdBot = await request(fixture, "POST", "/api/bots", { name: `Federation bot ${index}`,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
      expect(createdBot.status).toBe(201);
      const botId = `${me.homeId}:bot:${createdBot.body.bot.id}`;
      const invited = await request(fixture, "POST", "/api/multiplayer/rooms", {
        name: `Invited on server ${index}`, memberIds: [me.actorId, actorId],
      });
      expect(invited.status).toBe(201);
      const privateRoom = await request(fixture, "POST", "/api/multiplayer/dm", { targetId: botId });
      expect(privateRoom.status).toBe(201);
      expect((await request(fixture, "PUT", `/api/multiplayer/rooms/${invited.body.room.id}/bot-grants`, { botIds: [botId] })).status).toBe(200);
      const added = await links.addVerified(origins[index]!, guest.body.token);
      expect(added.homeId).toBe(me.homeId);
      joined.push({ homeId: me.homeId, roomId: invited.body.room.id, privateRoomId: privateRoom.body.room.id,
        botId, localBotId: createdBot.body.bot.id });
      expect(links.primaryActorId()).toBeNull();
    }
    expect(joined[0]!.homeId).not.toBe(joined[1]!.homeId);
    expect(links.bridgeLinks()).toHaveLength(2);
    const restored = new MultiplayerLinks(file, "joining-home", fetcher);
    expect(restored.primaryActorId()).toBeNull();
    expect(restored.bridgeLinks().map(link => link.homeId).sort()).toEqual(joined.map(link => link.homeId).sort());
    for (const [index, server] of joined.entries()) {
      const forward = (path: string, method = "GET", body?: unknown) => restored.forwardServer(server.homeId, path, method, body);
      expect(await forward("/api/multiplayer/me")).toMatchObject({ status: 200, body: { homeId: server.homeId, actorId, role: "client-guest" } });
      const rooms = await forward("/api/multiplayer/rooms");
      expect(rooms.status).toBe(200);
      expect((rooms.body as any).rooms.map((room: any) => room.id)).toEqual([server.roomId]);
      expect(await forward(`/api/multiplayer/rooms/${server.privateRoomId}/messages`)).toMatchObject({ status: 404 });
      expect(await forward(`/api/multiplayer/rooms/${joined[1 - index]!.roomId}/messages`)).toMatchObject({ status: 404 });
      const path = `/api/multiplayer/rooms/${server.roomId}`;
      expect((await forward(`${path}/bots`)).body).toMatchObject({ bots: [{ id: server.botId }] });
      const sent = await forward(`${path}/messages`, "POST", { text: `@Federation bot ${index} hello`, sendId: `guest-call-${index}`, botTargets: [server.botId] });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect((sent.body as any).message.actor).toEqual(actor);
      await expect.poll(async () => {
        const messages = (await forward(`${path}/messages`)).body as any;
        return messages.messages.find((message: any) => message.actor.kind === "bot" && message.kind !== "activity" && message.responseTo === (sent.body as any).message.id);
      }, { timeout: 15000, interval: 250 }).toMatchObject({
        actor: { homeId: server.homeId, kind: "bot", localId: server.localBotId }, responseTo: (sent.body as any).message.id,
      });
      expect((await request(fixtures[index]!, "PUT", `${path}/bot-grants`, { botIds: [] })).status).toBe(200);
      expect((await forward(`${path}/bots`)).body).toMatchObject({ bots: [] });
      expect(await forward(`${path}/messages`, "POST", { text: "again", sendId: `revoked-${index}`, botTargets: [server.botId] })).toMatchObject({ status: 403 });
      for (const forbidden of ["/api/auth/sessions", "/api/bots", "/api/settings", "/api/multiplayer/rooms/%2e%2e/%2e%2e/settings",
        "/api/multiplayer/rooms/room/messages%2f..%2f..%2fauth", "/api/multiplayer/rooms/room/../../auth/sessions", "https://unrelated.example.org/api/multiplayer/me"]) {
        await expect(forward(forbidden)).rejects.toThrow("invalid shared chat route");
      }
      expect(restored.primaryActorId()).toBeNull();
    }
    const finalReload = new MultiplayerLinks(file, "joining-home", fetcher);
    expect(finalReload.primaryActorId()).toBeNull();
    expect(finalReload.bridgeLinks()).toHaveLength(2);
  } finally {
    await Promise.allSettled(fixtures.map(fixture => fixture.close()));
    rmSync(folder, { recursive: true, force: true });
  }
}, 90000);
