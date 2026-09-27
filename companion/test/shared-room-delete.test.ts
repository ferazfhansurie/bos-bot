import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { createProxyHandler } from "../src/proxy.ts";

it("lets a paired phone delete a shared room while retaining auth and revision checks", async () => {
  const fixture = await launchVerificationServer();
  const token = "disposable-phone-token";
  const sidecar = createServer(createProxyHandler({
    harnessPort: Number(new URL(fixture.info.url).port),
    authenticate: value => value === token ? { id: "fixture-phone", cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "pairing disabled in fixture" }),
    serverName: () => "Fixture Mac",
  }));
  try {
    await new Promise<void>((resolve, reject) => {
      sidecar.once("error", reject);
      sidecar.listen(0, "127.0.0.1", resolve);
    });
    const address = sidecar.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    const phoneUrl = `http://127.0.0.1:${address.port}`;
    const direct = async (method: string, path: string, body?: unknown) => fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const me = await (await direct("GET", "/api/multiplayer/me")).json() as { actorId: string; homeId: string };
    const botResponse = await direct("POST", "/api/bots", {
      name: "Disposable group bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(botResponse.status).toBe(201);
    const { bot } = await botResponse.json() as { bot: { id: string } };
    const created = await direct("POST", "/api/multiplayer/dm", { targetId: `${me.homeId}:bot:${bot.id}` });
    expect(created.status).toBe(201);
    const { room } = await created.json() as { room: { id: string; revision: number } };
    const remove = (revision: number, authenticated = true) => fetch(`${phoneUrl}/api/multiplayer/rooms/${room.id}`, {
      method: "DELETE", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ revision }),
    });
    expect((await remove(room.revision, false)).status).toBe(401);
    expect((await remove(0)).status).toBe(400);
    expect((await remove(room.revision + 1)).status).toBe(409);
    expect((await remove(room.revision)).status).toBe(200);
    const remaining = await (await fetch(`${phoneUrl}/api/multiplayer/rooms`, { headers: { authorization: `Bearer ${token}` } })).json() as { rooms: unknown[] };
    expect(remaining.rooms).toEqual([]);
  } finally {
    await new Promise<void>(resolve => sidecar.close(() => resolve()));
    await fixture.close();
  }
}, 30_000);
