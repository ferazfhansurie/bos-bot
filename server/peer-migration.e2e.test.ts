import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("migrates a 0.1.84 bridge thread without granting private conversations", async () => {
  const fixture = await launchVerificationServer();
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = await request("POST", "/api/bots", {
      name: "Bridge fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(bot.status).toBe(201);
    const botId = bot.body.bot.id as string;
    const own = await request("POST", `/api/bots/${botId}/tasks`, { title: "room · team fixture" });
    const privateTask = await request("POST", `/api/bots/${botId}/tasks`, { title: "private owner conversation" });
    expect(own.status).toBe(201);
    expect(privateTask.status).toBe(201);
    const ownThread = own.body.task.threadId as string;
    const privateThread = privateTask.body.task.threadId as string;
    const pairing = await request("POST", "/api/auth/pairing", { scopes: ["client"] });
    const redeemed = await request("POST", "/api/auth/pair", { code: pairing.body.code, label: "BOS multiplayer bridge" });
    expect(redeemed.status).toBe(200);
    const oldToken = redeemed.body.token as string;
    expect((await request("GET", "/api/bots", undefined, oldToken)).status).toBe(403);
    const migrated = await request("POST", "/api/multiplayer/peer-migrate", {
      threads: [{ botId, threadId: ownThread }],
    }, oldToken);
    expect(migrated.status).toBe(200);
    // The first reply can be lost in transit. The restricted legacy token
    // remains retryable until a new token makes its first request.
    expect((await request("GET", "/api/bots", undefined, oldToken)).status).toBe(403);
    const retried = await request("POST", "/api/multiplayer/peer-migrate", {
      threads: [{ botId, threadId: ownThread }],
    }, oldToken);
    expect(retried.status).toBe(200);
    expect((await request("GET", "/api/bots", undefined, migrated.body.token)).status).toBe(401);
    const peerToken = retried.body.token as string;
    const listing = await request("GET", "/api/bots?messages=0", undefined, peerToken);
    expect(listing.status).toBe(200);
    expect((await request("GET", "/api/bots", undefined, oldToken)).status).toBe(401);
    expect(listing.body.bots[0].tasks.map((task: any) => task.threadId)).toEqual([ownThread]);
    expect((await request("GET", `/api/threads/${ownThread}/messages`, undefined, peerToken)).status).toBe(200);
    expect((await request("GET", `/api/threads/${privateThread}/messages`, undefined, peerToken)).status).toBe(403);
    for (const [method, path, body] of [
      ["POST", `/api/bots/${botId}/messages`, { threadId: privateThread, text: "hi" }],
      ["POST", `/api/bots/${botId}/interrupt`, { threadId: privateThread }],
      ["PATCH", `/api/bots/${botId}/tasks/${ownThread}`, { approvalMode: "auto" }],
      ["GET", "/api/events", undefined],
      ["GET", "/api/search", undefined],
      ["GET", "/api/config", undefined],
      ["GET", "/api/routines", undefined],
      ["GET", "/api/workspace-backup/export", undefined],
      ["POST", "/api/multiplayer/peer-announce", { homeId: "other-mac", origin: "https://other.ts.net" }],
    ] as const) expect((await request(method, path, body, peerToken)).status, `${method} ${path}`).toBe(403);
  } finally {
    await fixture.close();
  }
}, 45_000);
