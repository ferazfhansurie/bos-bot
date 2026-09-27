import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { MultiplayerLinks } from "./multiplayer-links.ts";
import { RemoteBotBridge } from "./remote-bot-bridge.ts";

it("migrates an old link across three isolated homes and delivers a room bot reply", async () => {
  const a = await launchVerificationServer();
  const b = await launchVerificationServer();
  const c = await launchVerificationServer();
  const folder = mkdtempSync(join(tmpdir(), "bos-three-homes-"));
  const api = async (url: string, method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: {
      origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  let bridge: RemoteBotBridge | null = null;
  try {
    const aHome = (await api(a.info.url, "GET", "/api/multiplayer/me")).body.homeId as string;
    const bHome = (await api(b.info.url, "GET", "/api/multiplayer/me")).body.homeId as string;
    const cHome = (await api(c.info.url, "GET", "/api/multiplayer/me")).body.homeId as string;
    expect(new Set([aHome, bHome, cHome]).size).toBe(3);
    const bot = await api(b.info.url, "POST", "/api/bots", {
      name: "Pixie", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(bot.status).toBe(201);
    const botId = bot.body.bot.id as string;
    const own = await api(b.info.url, "POST", `/api/bots/${botId}/tasks`, { title: "room · legacy team" });
    const privateTask = await api(b.info.url, "POST", `/api/bots/${botId}/tasks`, { title: "private owner conversation" });
    expect(own.status).toBe(201);
    expect(privateTask.status).toBe(201);
    const ownThread = own.body.task.threadId as string;
    const privateThread = privateTask.body.task.threadId as string;
    const pairing = await api(b.info.url, "POST", "/api/auth/pairing", { scopes: ["client"] });
    const redeemed = await api(b.info.url, "POST", "/api/auth/pair", { code: pairing.body.code, label: "BOS multiplayer bridge" });
    expect(redeemed.status).toBe(200);
    const oldToken = redeemed.body.token as string;
    expect((await api(b.info.url, "POST", "/api/multiplayer/actor-bindings", {
      sessionId: redeemed.body.session.id, personId: `${aHome}:person:owner`, name: "A",
    })).status).toBe(200);
    const cPairing = await api(b.info.url, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const cSession = await api(b.info.url, "POST", "/api/auth/pair", { code: cPairing.body.code, label: "C fixture" });
    expect(cSession.status).toBe(200);
    expect((await api(b.info.url, "POST", "/api/multiplayer/actor-bindings", {
      sessionId: cSession.body.session.id, personId: `${cHome}:person:owner`, name: "C",
    })).status).toBe(200);
    // This is the 0.1.84 on-disk shape: broad client token, saved bridge
    // thread map, and no scoped peer grants yet.
    const origin = "https://b-fixture.ts.net";
    writeFileSync(join(folder, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{
      homeId: bHome, origin, name: "B", token: oldToken, bots: [], proxyGroups: {},
    }], primary: null }));
    writeFileSync(join(folder, "remote-bots.json"), JSON.stringify({ version: 1, homes: { [bHome]: {
      threads: { [ownThread]: { botId, createdAt: Date.now(), room: true } }, selected: {}, pinned: {},
      bots: { [botId]: { name: "Pixie", title: "Bot", description: "", color: "blue" } }, attachments: [],
    } } }));
    const fetcher: typeof fetch = (input, init) => {
      const target = new URL(String(input));
      expect(target.hostname).toBe("b-fixture.ts.net");
      return fetch(new URL(target.pathname + target.search, b.info.url), init);
    };
    const links = new MultiplayerLinks(join(folder, "multiplayer-links.json"), aHome, fetcher);
    expect(links.bridgeLinks()).toHaveLength(1);
    let token = oldToken;
    bridge = new RemoteBotBridge({ file: join(folder, "remote-bots.json"), links: () => [{
      homeId: bHome, origin, token, name: "B", ownerName: "B",
    }], replaceLinkToken: (_homeId, next) => { token = next; }, localOwnerName: () => "A",
      attachmentsDir: join(folder, "attachments"), fileMime: () => null, broadcast: () => {}, fetcher,
    });
    bridge.start();
    await expect.poll(() => token !== oldToken, { timeout: 15_000, interval: 100 }).toBe(true);
    expect((await api(b.info.url, "GET", `/api/threads/${ownThread}/messages`, undefined, token)).status).toBe(200);
    expect((await api(b.info.url, "GET", `/api/threads/${privateThread}/messages`, undefined, token)).status).toBe(403);
    expect((await api(b.info.url, "GET", "/api/search", undefined, token)).status).toBe(403);
    const room = await api(b.info.url, "POST", "/api/multiplayer/rooms", {
      name: "Three homes", memberIds: [`${aHome}:person:owner`, `${bHome}:person:owner`, `${cHome}:person:owner`],
    });
    expect(room.status).toBe(201);
    const roomId = room.body.room.id as string;
    expect((await api(b.info.url, "GET", `/api/multiplayer/rooms/${roomId}/messages`, undefined, token)).status).toBe(200);
    expect((await api(b.info.url, "POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "@Pixie help", sendId: "unauthorized-target", botTargets: [`${bHome}:bot:${botId}`] }, token)).status).toBe(403);
    const sent = await api(b.info.url, "POST", `/api/multiplayer/rooms/${roomId}/messages`, {
      text: "@Pixie answer from B", sendId: "three-home-mention",
    });
    expect(sent.status).toBe(201);
    await expect.poll(async () => {
      const read = await api(b.info.url, "GET", `/api/multiplayer/rooms/${roomId}/messages`, undefined, token);
      return read.body.messages.some((message: any) => message.actor.kind === "bot" && message.responseTo === sent.body.message.id && Boolean(message.text));
    }, { timeout: 20_000, interval: 250 }).toBe(true);
    await expect(new MultiplayerLinks(join(folder, "old-protocol.json"), aHome, fetcher).addVerified(origin,
      `omb_sess_${"x".repeat(43)}`, { environmentId: bHome, label: "B", multiplayerProtocol: 0 })).rejects.toThrow("update BOS on B");
  } finally {
    bridge?.stop();
    await Promise.all([a.close(), b.close(), c.close()]);
    rmSync(folder, { recursive: true, force: true });
  }
}, 80_000);
