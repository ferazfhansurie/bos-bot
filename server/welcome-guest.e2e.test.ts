import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("welcomes a stranger into one room with one granted bot and nothing else", async () => {
  const fixture = await launchVerificationServer();
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  const api = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const me = (await api("GET", "/api/multiplayer/me")).body;
    const bot = (await api("POST", "/api/bots", { name: "Welcome helper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { soul: "PRIVATE_OWNER_SOUL_SENTINEL" })).status).toBe(200);
    const other = (await api("POST", "/api/bots", { name: "Other helper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const ownerRoom = (await api("POST", "/api/groups", { name: "Owner only", memberIds: [other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body.group;

    // Only the owner's admin session may open a welcome room.
    const clientPairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const client = (await api("POST", "/api/auth/pair", { code: clientPairing.body.code, label: "client fixture" })).body.token;
    expect((await api("POST", "/api/multiplayer/welcome-guest", { name: "Ana", installId: "install-12345678", botId: bot.id }, client)).status).toBe(403);
    expect((await api("POST", "/api/multiplayer/welcome-guest", { name: "", installId: "install-12345678", botId: bot.id })).status).toBe(400);
    expect((await api("POST", "/api/multiplayer/welcome-guest", { name: "Ana", installId: "short", botId: bot.id })).status).toBe(400);
    expect((await api("POST", "/api/multiplayer/welcome-guest", { name: "Ana", installId: "install-12345678", botId: "missing" })).status).toBe(400);

    const opened = await api("POST", "/api/multiplayer/welcome-guest", { name: " Ana\u0007 ", installId: "install-12345678", botId: bot.id });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const code = new URL(opened.body.url).hash.replace(/^#code=/, "");
    expect(code.length).toBeGreaterThan(12);
    // A retry from the same install reuses the room and issues a fresh link.
    const again = await api("POST", "/api/multiplayer/welcome-guest", { name: "Ana", installId: "install-12345678", botId: bot.id });
    expect(again.body.roomId).toBe(opened.body.roomId);
    expect(again.body.url).not.toBe(opened.body.url);

    const ownerView = (await api("GET", `/api/groups/${opened.body.roomId}`)).body.group;
    expect(ownerView.name).toBe("hi Ana");
    expect(ownerView.memberIds).toEqual([bot.id]);

    // The stranger arrives through a tunnel: forwarded headers, never loopback.
    const paired = await api("POST", "/api/auth/pair", { code, label: "welcome browser" }, undefined, { "x-forwarded-for": "203.0.113.9" });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    expect(paired.body.session.scopes).toEqual(["client"]);
    expect((await api("POST", "/api/auth/pair", { code, label: "replay" })).status).toBe(401);
    const guest = paired.body.token;
    const guestMe = (await api("GET", "/api/multiplayer/me", undefined, guest)).body;
    expect(guestMe.actorId).not.toBe(me.actorId);

    const listed = (await api("GET", "/api/groups", undefined, guest)).body.groups;
    expect(listed.map((g: any) => g.id)).toEqual([opened.body.roomId]);
    expect((await api("GET", `/api/groups/${ownerRoom.id}`, undefined, guest)).status).toBe(404);
    expect((await api("GET", `/api/threads/${ownerRoom.threadId}/messages`, undefined, guest)).status).toBe(404);
    const bots = (await api("GET", "/api/bots", undefined, guest)).body.bots;
    expect(bots.map((b: any) => b.id)).toEqual([bot.id]);
    for (const path of [`/api/bots/${other.id}`, `/api/bots/${bot.id}/tasks`, "/api/search?q=a", "/api/team-map", "/api/inbox"]) {
      expect((await api("GET", path, undefined, guest)).status, path).toBeGreaterThanOrEqual(403);
    }
    // The client view of config is the existing redacted one every client gets.
    const config = (await api("GET", "/api/config", undefined, guest)).body;
    expect(config.signIn).toEqual({ admins: [], members: [] });
    expect(config.profile.email).toBe("");
    for (const [method, path, body] of [["PATCH", "/api/config", { profile: { name: "x" } }], ["POST", "/api/bots", { name: "x" }], ["POST", "/api/groups", { name: "x", memberIds: [bot.id] }], ["POST", "/api/multiplayer/welcome-guest", { name: "Mallory", installId: "install-87654321", botId: bot.id }], ["POST", "/api/auth/pairing", { scopes: ["admin"] }]] as const) {
      expect((await api(method, path, body, guest)).status, `${method} ${path}`).toBeGreaterThanOrEqual(403);
    }

    const sent = await api("POST", `/api/groups/${opened.body.roomId}/messages`, { text: "hi, just installed", sendId: "welcome-first-1234567890" }, guest);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.message.sender).toEqual({ id: guestMe.actorId, name: "Ana" });
    await expect.poll(async () => (await api("GET", `/api/threads/${ownerView.threadId}/messages`, undefined, guest)).body.messages.some((m: any) => m.role === "bot" && m.kind === "text"), { timeout: 20_000, interval: 200 }).toBe(true);
    const capture = JSON.parse(readFileSync(dump, "utf8"));
    expect(capture.systemPrompt).not.toContain("PRIVATE_OWNER_SOUL_SENTINEL");
    expect(capture.argv[capture.argv.indexOf("--tools") + 1]).toBe("");
    expect(capture.argv).toContain("--restricted");
  } finally {
    await fixture.close();
  }
}, 60_000);
