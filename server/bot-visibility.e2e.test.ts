import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("revokes an existing peer thread when its owner makes the bot private, then restores sharing", async () => {
  const fixture = await launchVerificationServer();
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const streamAbort = new AbortController();
  let streamRead: Promise<void> | undefined;
  try {
    const created = await request("POST", "/api/bots", { name: "Privacy fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const botId = created.body.bot.id as string;
    const homeId = (await request("GET", "/api/multiplayer/me")).body.homeId as string;
    const contactId = `${homeId}:bot:${botId}`;
    const peerPairing = await request("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const linkedHome = await request("POST", "/api/auth/pair", { code: peerPairing.body.code, label: "Linked home fixture" });
    expect((await request("POST", "/api/multiplayer/actor-bindings", { sessionId: linkedHome.body.session.id, personId: "other-home:person:owner", name: "Other owner" })).status).toBe(200);
    expect((await request("GET", "/api/multiplayer/contacts", undefined, linkedHome.body.token)).body.contacts.some((contact: any) => contact.id === contactId)).toBe(true);
    const pairing = await request("POST", "/api/auth/pairing", { scopes: ["client"] });
    const phone = await request("POST", "/api/auth/pair", { code: pairing.body.code, label: "BOS multiplayer bridge" });
    expect(phone.status).toBe(200);
    const phoneToken = phone.body.token as string;
    const migrated = await request("POST", "/api/multiplayer/peer-migrate", { threads: [] }, phoneToken);
    expect(migrated.status).toBe(200);
    const peerToken = migrated.body.token as string;
    const task = await request("POST", `/api/bots/${botId}/tasks`, { title: "Existing linked thread" }, peerToken);
    expect(task.status).toBe(201);
    const threadId = task.body.task.threadId as string;
    expect((await request("GET", "/api/bots?messages=0", undefined, peerToken)).body.bots.some((bot: any) => bot.id === botId)).toBe(true);
    expect((await request("GET", `/api/threads/${threadId}/messages`, undefined, peerToken)).status).toBe(200);
    const stream = await fetch(`${fixture.info.url}/api/multiplayer/peer-events`, { headers: { authorization: `Bearer ${peerToken}` }, signal: streamAbort.signal });
    expect(stream.status).toBe(200);
    let events = "";
    streamRead = (async () => { const reader = stream.body!.getReader(); try { for (;;) { const result = await reader.read(); if (result.done) break; events += new TextDecoder().decode(result.value); } } finally { reader.releaseLock(); } })();
    await expect.poll(() => events.includes('"hello"')).toBe(true);
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "invalid" })).status).toBe(400);
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "private" }, peerToken)).status).toBe(403);
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "private" })).status).toBe(200);
    await expect.poll(() => events.includes(`"kind":"bot.deleted","botId":"${botId}"`)).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId).visibility).toBe("private");
    expect((await request("GET", "/api/bots?messages=0", undefined, peerToken)).body.bots.some((bot: any) => bot.id === botId)).toBe(false);
    expect((await request("GET", "/api/multiplayer/contacts", undefined, linkedHome.body.token)).body.contacts.some((contact: any) => contact.id === contactId)).toBe(false);
    for (const [method, path, body] of [
      ["GET", `/api/threads/${threadId}/messages`],
      ["POST", `/api/bots/${botId}/tasks`, {}],
      ["POST", `/api/bots/${botId}/messages`, { threadId, text: "should be refused" }],
      ["GET", `/api/multiplayer/peer-threads/${threadId}/attachments/missing.txt`],
    ] as const) expect((await request(method, path, body, peerToken)).status).toBe(404);
    expect((await request("GET", `/api/threads/${threadId}/messages`)).status).toBe(200);
    const phonePair = await request("POST", "/api/auth/pairing", { scopes: ["client"] });
    const phoneAgain = await request("POST", "/api/auth/pair", { code: phonePair.body.code, label: "Paired phone fixture" });
    expect((await request("GET", "/api/bots?messages=0", undefined, phoneAgain.body.token)).body.bots.some((bot: any) => bot.id === botId)).toBe(true);
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "shared" }, phoneAgain.body.token)).status).toBe(200);
    expect((await request("GET", "/api/bots?messages=0", undefined, peerToken)).body.bots.some((bot: any) => bot.id === botId)).toBe(true);
    expect((await request("GET", "/api/multiplayer/contacts", undefined, linkedHome.body.token)).body.contacts.some((contact: any) => contact.id === contactId)).toBe(true);
    expect((await request("GET", `/api/threads/${threadId}/messages`, undefined, peerToken)).status).toBe(200);
  } finally { streamAbort.abort(); await streamRead?.catch(() => {}); await fixture.close(); }
}, 45_000);
