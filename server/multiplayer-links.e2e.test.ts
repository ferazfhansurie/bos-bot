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
      expect(target.hostname).toBe("putri-fixture.ts.net");
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
      name: "Firaz and Pixie", memberIds: [actorId, `${added.homeId}:bot:${bot.body.bot.id}`],
    });
    expect(room.status).toBe(201);
    expect((await links.forwardShared("/api/multiplayer/rooms", "GET")).body).toMatchObject({ rooms: [(room.body as any).room] });
  } finally {
    await fixture.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 45_000);
