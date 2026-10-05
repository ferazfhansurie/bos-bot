import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it("repeats invite/join/register through APIs while preserving the guest's home", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const folder = mkdtempSync(join(tmpdir(), "omb-join-api-"));
  const children: ChildProcess[] = [];
  const basePort = await freePortBlock([0, 1, 2, 3, 4, 5]);
  const bases = [0, 1, 2].map(index => `http://127.0.0.1:${basePort + 2 * index}`);
  const origins = [0, 1, 2].map(index => `https://join-${index}.example.org`);
  const transport = join(folder, "owned-fetch.mjs");
  writeFileSync(transport, `const destinations = new Map(${JSON.stringify(origins.map((origin, index) => [origin, bases[index]]))});
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const destination = destinations.get(url.origin);
  if (destination) return originalFetch(new URL(url.pathname + url.search, destination), init);
  if (url.hostname !== '127.0.0.1') throw new Error('unexpected external fixture fetch');
  return originalFetch(input, init);
};
`);
  const api = async (index: number, method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, bases[index]), { method, headers: { "content-type": "application/json", origin: bases[index]! },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    for (let index = 0; index < 3; index++) {
      const data = join(folder, `home-${index}`); mkdirSync(join(data, "tmp"), { recursive: true });
      writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: `Join fixture ${index}` },
        instances: { claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } } }));
      const env = verificationServerEnvironment({}, data, basePort + 2 * index);
      env.OMB_FEDERATION_ORIGIN = origins[index];
      const child = spawn(process.execPath, ["--experimental-strip-types", "--import", transport, join(root, "server/index.ts")],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let stderr = ""; child.stdout!.resume(); child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const deadline = Date.now() + 20000;
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`join fixture ${index} exited: ${stderr}`);
        try { if ((await api(index, "GET", "/api/health")).status === 200) break; } catch {}
        if (Date.now() >= deadline) throw new Error(`join fixture ${index} startup timeout: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const home = (await api(0, "GET", "/api/multiplayer/me")).body;
    const ownBot = await api(0, "POST", "/api/bots", {});
    expect(ownBot.status).toBe(201);
    const originalIds = { actorId: home.actorId, homeId: home.homeId, botId: ownBot.body.bot.id, threadId: ownBot.body.bot.threadId };
    const hosts: Array<{ index: number; homeId: string; roomId: string; privateRoomId: string; botId: string; localBotId: string }> = [];
    for (let index = 1; index < 3; index++) {
      const owner = (await api(index, "GET", "/api/multiplayer/me")).body;
      const pairing = (await api(index, "POST", "/api/auth/pairing", { scopes: ["peer"] })).body;
      const mate = await api(index, "POST", "/api/auth/pair", { code: pairing.code });
      expect(mate.status).toBe(200);
      const mateId = `mate-${index}:person:owner`;
      expect((await api(index, "POST", "/api/multiplayer/actor-bindings", { sessionId: mate.body.session.id, personId: mateId, name: "Fixture mate" })).status).toBe(200);
      const room = await api(index, "POST", "/api/multiplayer/rooms", { name: `Host ${index} invitation room`, memberIds: [owner.actorId, mateId] });
      expect(room.status).toBe(201);
      const bot = await api(index, "POST", "/api/bots", { name: `Join bot ${index}`, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
      expect(bot.status).toBe(201);
      const botId = `${owner.homeId}:bot:${bot.body.bot.id}`;
      const privateRoom = await api(index, "POST", "/api/multiplayer/dm", { targetId: botId });
      expect(privateRoom.status).toBe(201);
      const channel = await api(index, "POST", "/api/groups", { name: "Existing team inbox", memberIds: [bot.body.bot.id] });
      expect(channel.status).toBe(201);
      const invitation = await api(index, "POST", "/api/multiplayer/invites", { role: "client-guest", roomIds: [room.body.room.id, channel.body.group.id] });
      expect(invitation.status, JSON.stringify(invitation.body)).toBe(201);
      expect(new URL(invitation.body.url).origin).toBe(origins[index]);
      const joined = await api(0, "POST", "/api/multiplayer/join", { url: invitation.body.url });
      expect(joined.status, JSON.stringify(joined.body)).toBe(201);
      expect(joined.body).toMatchObject({ homeId: home.homeId, guest: { actorId: home.actorId, role: "client-guest" }, link: { homeId: owner.homeId } });
      const channelAfter = await api(index, "GET", `/api/groups/${channel.body.group.id}`);
      expect(channelAfter.body.group.peopleIds).toContain(home.actorId);
      expect(channelAfter.body.group.memberIds).toEqual([bot.body.bot.id]);
      expect((await api(0, "GET", "/api/multiplayer/primary")).body).toEqual({ actorId: null });
      const currentHome = (await api(0, "GET", "/api/multiplayer/me")).body;
      const currentBot = (await api(0, "GET", "/api/bots")).body.bots.find((value: any) => value.id === originalIds.botId);
      expect({ actorId: currentHome.actorId, homeId: currentHome.homeId, botId: currentBot.id, threadId: currentBot.threadId }).toEqual(originalIds);
      hosts.push({ index, homeId: owner.homeId, roomId: room.body.room.id, privateRoomId: privateRoom.body.room.id, botId, localBotId: bot.body.bot.id });
    }
    const servers = (await api(0, "GET", "/api/multiplayer/servers")).body.servers;
    expect(servers).toHaveLength(3);
    expect(servers.map((server: any) => server.homeId).sort()).toEqual([home.homeId, ...hosts.map(host => host.homeId)].sort());
    for (const host of hosts) {
      const prefix = `/api/multiplayer/servers/${host.homeId}/rooms`;
      const rooms = await api(0, "GET", prefix);
      expect(rooms.status).toBe(200);
      expect(rooms.body.rooms.map((room: any) => room.id)).toEqual([host.roomId]);
      expect((await api(0, "GET", `${prefix}/${host.privateRoomId}/messages`)).status).toBe(404);
      const other = hosts.find(value => value.homeId !== host.homeId)!;
      expect((await api(0, "GET", `${prefix}/${other.roomId}/messages`)).status).toBe(404);
      const rolePath = `/api/multiplayer/members/${encodeURIComponent(home.actorId)}`;
      expect((await api(host.index, "PUT", rolePath, { role: "admin" })).status).toBe(200);
      expect((await api(0, "PUT", `${prefix}/${host.roomId}/bot-grants`, { botIds: [host.botId] })).status).toBe(200);
      expect((await api(host.index, "PUT", rolePath, { role: "client-guest" })).status).toBe(200);
      const messages = `${prefix}/${host.roomId}/messages`;
      expect((await api(0, "POST", messages, { text: "ungranted", sendId: `ungranted-${host.index}`, botTargets: [host.botId] })).status).toBe(403);
      expect((await api(host.index, "PUT", `/api/multiplayer/rooms/${host.roomId}/bot-grants`, { botIds: [host.botId] })).status).toBe(200);
      const sent = await api(0, "POST", messages, { text: `@Join bot ${host.index} hello`, sendId: `granted-${host.index}`, botTargets: [host.botId] });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body.message.actor).toEqual({ homeId: home.homeId, kind: "person", localId: "owner" });
      await expect.poll(async () => (await api(0, "GET", messages)).body.messages.find((message: any) =>
        message.actor.kind === "bot" && message.kind !== "activity" && message.responseTo === sent.body.message.id),
      { timeout: 20000, interval: 250 }).toMatchObject({ actor: { homeId: host.homeId, kind: "bot", localId: host.localBotId }, responseTo: sent.body.message.id });
    }
    expect((await api(0, "GET", "/api/multiplayer/primary")).body).toEqual({ actorId: null });
  } finally {
    await Promise.allSettled(children.map(child => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(folder);
  }
}, 120000);
