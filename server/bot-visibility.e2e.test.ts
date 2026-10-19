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
    // Since workspace roles (decc80669) a newly bound person is a client guest;
    // this fixture covers bot privacy for a full member.
    expect((await request("PUT", `/api/multiplayer/members/${encodeURIComponent("other-home:person:owner")}`, { role: "member" })).status).toBe(200);
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

it("opens a private bot to one listed person's own linked threads only", async () => {
  const fixture = await launchVerificationServer();
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const link = async (personId: string) => {
    const pairing = await request("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await request("POST", "/api/auth/pair", { code: pairing.body.code, label: `link ${personId}` });
    expect((await request("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.body.session.id, personId, name: personId })).status).toBe(200);
    expect((await request("PUT", `/api/multiplayer/members/${encodeURIComponent(personId)}`, { role: "member" })).status).toBe(200);
    return paired.body.token as string;
  };
  const lists = async (token: string, botId: string) => (await request("GET", "/api/bots?messages=0", undefined, token)).body.bots?.some((bot: any) => bot.id === botId) ?? false;
  try {
    const created = await request("POST", "/api/bots", { name: "Private fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    const botId = created.body.bot.id as string;
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "private" })).status).toBe(200);
    const ownerThread = (await request("POST", `/api/bots/${botId}/tasks`, { title: "Owner only" })).body.task.threadId as string;
    const homeId = (await request("GET", "/api/multiplayer/me")).body.homeId as string;
    const listedToken = await link("listed-home:person:owner");
    const otherToken = await link("other-home:person:owner");
    expect(await lists(listedToken, botId)).toBe(false);

    for (const sharedWith of ["listed-home:person:owner", ["listed-home:bot:x"], [`${homeId}:person:owner`], Array.from({ length: 21 }, (_, i) => `h${i}:person:owner`)]) {
      expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith })).status).toBe(400);
    }
    expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith: ["listed-home:person:owner"] }, listedToken)).status).toBe(403);
    expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith: ["listed-home:person:owner", "listed-home:person:owner"] })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId).sharedWith).toEqual(["listed-home:person:owner"]);

    expect(await lists(listedToken, botId)).toBe(true);
    expect(await lists(otherToken, botId)).toBe(false);
    const task = await request("POST", `/api/bots/${botId}/tasks`, { title: "Linked thread" }, listedToken);
    expect(task.status).toBe(201);
    const threadId = task.body.task.threadId as string;
    expect((await request("GET", `/api/threads/${threadId}/messages`, undefined, listedToken)).status).toBe(200);
    const view = (await request("GET", "/api/bots?messages=0", undefined, listedToken)).body.bots.find((bot: any) => bot.id === botId);
    expect(view.tasks.map((t: any) => t.threadId)).toEqual([threadId]);
    expect(view.sharedWith).toBeUndefined();
    expect(view.approvalMode).toBe("ask");
    expect((await request("GET", `/api/threads/${ownerThread}/messages`, undefined, listedToken)).status).not.toBe(200);
    expect((await request("POST", `/api/bots/${botId}/tasks`, {}, otherToken)).status).toBe(404);
    expect((await request("GET", `/api/threads/${threadId}/messages`, undefined, otherToken)).status).not.toBe(200);
    expect((await request("GET", "/api/multiplayer/contacts", undefined, listedToken)).body.contacts?.some((contact: any) => contact.id === `${homeId}:bot:${botId}`) ?? false).toBe(false);

    const read = await request("POST", `/api/bots/${botId}/read`, { threadId }, listedToken);
    expect(read.status).toBe(200);
    expect(read.body.bot.soul).toBeUndefined();
    expect(read.body.bot.tasks.map((t: any) => t.threadId)).toEqual([threadId]);
    const spare = (await request("POST", `/api/bots/${botId}/tasks`, { title: "Spare" }, listedToken)).body.task.threadId as string;
    const deleted = await request("DELETE", `/api/bots/${botId}/tasks/${spare}`, undefined, listedToken);
    expect(deleted.status).toBe(200);
    expect(deleted.body.bot.messages).toEqual([]);
    expect(deleted.body.bot.soul).toBeUndefined();
    expect(deleted.body.bot.sharedWith).toBeUndefined();
    expect(deleted.body.bot.tasks.map((t: any) => t.threadId)).toEqual([threadId]);
    expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith: ["guest-home:person:owner"] })).status).toBe(400);

    expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith: [] })).status).toBe(200);
    expect(await lists(listedToken, botId)).toBe(false);
    expect((await request("GET", `/api/threads/${threadId}/messages`, undefined, listedToken)).status).toBe(404);
    expect((await request("PATCH", `/api/bots/${botId}`, { sharedWith: ["listed-home:person:owner"] })).status).toBe(200);
    expect((await request("PATCH", `/api/bots/${botId}`, { visibility: "shared" })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId).sharedWith).toEqual([]);
  } finally { await fixture.close(); }
}, 45_000);
