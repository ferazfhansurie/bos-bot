import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { MultiplayerLinks } from "./multiplayer-links.ts";

it("pairs a chat-only workspace and forwards its shared room", async () => {
  const fixture = await launchVerificationServer();
  const folder = mkdtempSync(join(tmpdir(), "multiplayer-links-test-"));
  const remote = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = await remote("POST", "/api/bots", {
      name: "Pixie fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(bot.status).toBe(201);
    const pairing = await remote("POST", "/api/auth/pairing", { scopes: ["peer"] });
    expect(pairing.status).toBe(200);
    const fetcher: typeof fetch = (input, init) => {
      const target = new URL(String(input));
      expect(["putri-fixture.ts.net", "putri-new.ts.net"]).toContain(target.hostname);
      return fetch(new URL(target.pathname + target.search, fixture.info.url), init);
    };
    const links = new MultiplayerLinks(join(folder, "links.json"), "firaz-fixture", fetcher);
    await expect(links.addVerified("https://putri-fixture.ts.net", `omb_sess_${"x".repeat(43)}`, {
      environmentId: "old-mac", label: "Putri's Mac", version: "0.1.84",
    })).rejects.toThrow("update BOS on Putri's Mac");
    const descriptor = await remote("GET", "/.well-known/openmausbot/environment");
    expect(descriptor.status).toBe(200);
    const added = await links.addFromPairingUrl(`https://putri-fixture.ts.net/pair#code=${pairing.body.code}`);
    expect(added.homeId).toBe(descriptor.body.environmentId);
    expect(links.contacts()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Pixie fixture" })]));
    const replacement = await remote("POST", "/api/auth/pairing", { scopes: ["peer"] });
    expect(replacement.status).toBe(200);
    expect((await links.addFromPairingUrl(`https://putri-fixture.ts.net/pair#code=${replacement.body.code}`)).homeId).toBe(added.homeId);
    expect(links.bridgeLinks()).toHaveLength(1);
    const sessions = await remote("GET", "/api/auth/sessions");
    const bridges = sessions.body.sessions.filter((session: any) => session.label === "BOS multiplayer bridge");
    expect(bridges).toHaveLength(1);
    const actorId = "firaz-fixture:person:owner";
    for (const bridge of bridges) expect((await remote("POST", "/api/multiplayer/actor-bindings", {
      sessionId: bridge.id, personId: actorId, name: "Firaz",
    })).status).toBe(200);
    expect((await links.setPrimary(added.homeId)).actorId).toBe(actorId);
    const forwarded = await links.forwardShared("/api/multiplayer/me", "GET");
    expect(forwarded).toMatchObject({ status: 200, body: { actorId } });
    const room = await links.forwardShared("/api/multiplayer/rooms", "POST", {
      name: "Firaz and Pixie", memberIds: [actorId, `${added.homeId}:person:owner`],
    });
    expect(room.status).toBe(201);
    expect((await links.forwardShared("/api/multiplayer/rooms", "GET")).body).toMatchObject({ rooms: [(room.body as any).room] });
    const roomPath = `/api/multiplayer/rooms/${(room.body as any).room.id}`;
    expect(await links.forwardShared(`${roomPath}/bots`, "GET")).toMatchObject({ status: 200, body: { bots: [] } });
    expect(await links.forwardShared(`${roomPath}/preferences`, "PATCH", { notifications: "muted" })).toMatchObject({ status: 200, body: { notifications: "muted" } });
    const uploaded = await links.forwardShared(`${roomPath}/attachments`, "POST", { name: "brief.txt", mime: "text/plain", data: Buffer.from("shared brief").toString("base64") });
    expect(uploaded.status).toBe(201);
    expect(await links.forwardShared(`${roomPath}/files`, "GET")).toMatchObject({ status: 200, body: { files: [] } });
    const sent = await links.forwardShared(`${roomPath}/messages`, "POST", { text: "Original brief", sendId: "brief", attachments: [(uploaded.body as any).attachment] });
    expect(sent.status).toBe(201);
    const messageId = (sent.body as any).message.id;
    expect(await links.forwardShared(`${roomPath}/files?limit=1`, "GET")).toMatchObject({ status: 200, body: { files: [{ messageId, attachment: { name: "brief.txt" } }], hasMore: false } });
    expect(await links.forwardShared(`${roomPath}/files?before=0`, "GET")).toMatchObject({ status: 400 });
    expect(await links.forwardShared(`${roomPath}/messages/${messageId}`, "PATCH", { text: "Updated brief" })).toMatchObject({ status: 200, body: { message: { text: "Updated brief" } } });
    expect(await links.forwardShared(`${roomPath}/messages/${messageId}`, "DELETE")).toMatchObject({ status: 200 });
    expect(await links.forwardShared(`${roomPath}/files`, "GET")).toMatchObject({ status: 200, body: { files: [] } });
    await expect(links.forwardShared(`${roomPath}/files/extra`, "GET")).rejects.toThrow("invalid shared chat route");
    await expect(links.forwardShared("/api/auth/sessions", "GET")).rejects.toThrow("invalid shared chat route");
    const renamed = await links.forwardShared(`/api/multiplayer/rooms/${(room.body as any).room.id}`, "PATCH", { revision: 1, name: "Renamed team" });
    expect(renamed).toMatchObject({ status: 200, body: { room: { name: "Renamed team", revision: 2 } } });
    expect(await links.forwardShared(`/api/multiplayer/rooms/${(room.body as any).room.id}`, "DELETE", { revision: 2 })).toMatchObject({ status: 200 });
    expect((await links.forwardShared("/api/multiplayer/rooms", "GET")).body).toMatchObject({ rooms: [] });
    expect(await links.forwardShared(`${roomPath}/files`, "GET")).toMatchObject({ status: 404 });
    expect(await links.reannounce(added.homeId, "https://putri-new.ts.net")).toBe(true);
    expect(links.bridgeLinks()[0].origin).toBe("https://putri-new.ts.net");
    await expect(links.reannounce(added.homeId, "https://putri.other.ts.net")).rejects.toThrow("same private tailnet");
    expect(await links.remove(added.homeId)).toBe(true);
    expect(links.bridgeLinks()).toHaveLength(0);
    expect((await remote("GET", "/api/auth/sessions")).body.sessions.filter((session: any) => session.label === "BOS multiplayer bridge")).toHaveLength(0);
  } finally {
    await fixture.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 45_000);
