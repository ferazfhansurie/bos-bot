import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

// Two real isolated homes: B owns a shared bot, A hosts a room that lists
// that bot as a remote member (`rb-<homeKey>-<botId>`) through the bridge.
const REPLY = "REMOTE-ROOM-REPLY-7731";
const SECRET = "SECRET-OWNER-ONLY-5519";
const UNAVAILABLE = "not available for a bot on another Mac";
const LINK_ORIGIN = "https://delegated-fixture.example.ts.net:8443";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

test("a room on A can list B's shared bot, route mentions through the bridge, and fail fast when B is gone", async () => {
  const b = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(Array(40).fill(REPLY)), FAKE_CLAUDE_TOOL_CALLS: "[]" });
  let a: Fixture | undefined;
  let bClosed = false;
  const api = async (fixture: Fixture, method: string, path: string, body?: unknown, token?: string, expected?: number) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as any;
    if (expected !== undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return { status: response.status, body: result };
  };
  let events: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    const bHome = (await api(b, "GET", "/.well-known/openmausbot/environment")).body.environmentId as string;
    const aHome = randomUUID();
    const template = (await api(b, "GET", "/api/bots")).body.bots[0];
    const pixie = (await api(b, "POST", "/api/bots", { name: "Pixie", title: "Fixture", modelSelection: template.modelSelection }, undefined, 201)).body.bot;
    // The owner's own conversation with Pixie on B: never part of A's room.
    const privateTask = (await api(b, "POST", `/api/bots/${pixie.id}/tasks`, { title: "private owner conversation" }, undefined, 201)).body.task;
    await api(b, "POST", `/api/bots/${pixie.id}/messages`, { text: `owner note ${SECRET}`, threadId: privateTask.threadId, sendId: randomUUID() }, undefined, 202);
    await expect.poll(async () => (await api(b, "GET", `/api/threads/${privateTask.threadId}/messages`)).body.messages
      .some((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes(REPLY)), { timeout: 20_000, interval: 250 }).toBe(true);

    // A plain peer session (no person binding): a bound client-guest would
    // only see bots granted to a room it reads, and Pixie is not in one on B.
    const pairing = await api(b, "POST", "/api/auth/pairing", { scopes: ["peer"] }, undefined, 200);
    const paired = await api(b, "POST", "/api/auth/pair", { code: pairing.body.code, label: "BOS peer bridge" }, undefined, 200);
    a = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, {
      origin: b.info.url, prepare: dataDir => {
        writeFileSync(join(dataDir, "environment-id"), aHome);
        writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{
          homeId: bHome, name: "B", origin: LINK_ORIGIN, token: paired.body.token, bots: [], proxyGroups: {},
        }] }));
      },
    });
    const A = a;
    events = await openSse(`${A.info.url}/api/events`, { origin: A.info.url });

    // The bridge relays Pixie onto A as rb-<homeKey>-<pixie.id>.
    let rbId = "";
    await expect.poll(async () => {
      rbId = (await api(A, "GET", "/api/bots")).body.bots.find((bot: any) => bot.id.startsWith("rb-") && bot.id.endsWith(`-${pixie.id}`))?.id ?? "";
      return rbId;
    }, { timeout: 30_000, interval: 250 }).not.toBe("");
    const local = (await api(A, "GET", "/api/bots")).body.bots.find((bot: any) => !bot.id.startsWith("rb-"));

    // 1. membership
    const refused = await api(A, "POST", "/api/groups", { name: "Remote only", memberIds: [rbId], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("at least one bot from this Mac");
    const room = (await api(A, "POST", "/api/groups", { name: "Mixed homes", memberIds: [local.id, rbId], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } }, undefined, 201)).body.group;
    const listed = (await api(A, "GET", "/api/groups", undefined, undefined, 200)).body.groups.find((g: any) => g.id === room.id);
    expect(listed.memberIds).toEqual(expect.arrayContaining([local.id, rbId]));
    const card = listed.memberBots.find((m: any) => m.id === rbId);
    expect(card).toMatchObject({ name: "Pixie", remote: { homeId: bHome, homeName: "B" } });
    expect(listed.memberBots.find((m: any) => m.id === local.id)?.remote).toBeUndefined();

    // 2+3. mention → bridge-created B thread → reply in A's room
    let roomThread = room.threadId as string;
    const roomMessages = async () => (await api(A, "GET", `/api/threads/${roomThread}/messages?limit=200`, undefined, undefined, 200)).body.messages as any[];
    const pixieTasks = async () => (await api(b, "GET", "/api/bots")).body.bots.find((bot: any) => bot.id === pixie.id).tasks as any[];
    const tasksBefore = (await pixieTasks()).length;
    roomThread = (await api(A, "POST", `/api/groups/${room.id}/messages`, { text: "@Pixie first question FIRST-PROMPT-MARK" }, undefined, 202)).body.threadId;
    expect(roomThread).toBe(room.threadId);
    await expect.poll(async () => (await roomMessages()).filter(m => m.kind === "text" && m.from?.botId === rbId && m.text?.includes(REPLY)).length,
      { timeout: 45_000, interval: 250 }).toBe(1);
    const bridged = (await pixieTasks()).filter(task => task.title?.startsWith("room · "));
    expect(bridged).toHaveLength(1);
    expect((await pixieTasks()).length).toBe(tasksBefore + 1);
    const bThread = bridged[0].threadId as string;
    const bTranscript = (await api(b, "GET", `/api/threads/${bThread}/messages?limit=200`, undefined, undefined, 200)).body.messages as any[];
    expect(bTranscript.some(m => m.role === "user" && m.text?.includes("FIRST-PROMPT-MARK") && m.text?.includes("Mixed homes"))).toBe(true);
    expect(JSON.parse(readFileSync(join(A.info.dataDir, "room-remote-threads.json"), "utf8"))).toEqual({ [`${room.id}:${rbId}`]: bThread });
    const runtime = await events.until(frame => frame.kind === "runtime" && frame.event?.roomBotId === rbId, 10_000);
    expect(runtime.event.threadId).toBe(roomThread);

    // second mention reuses the same B thread
    await api(A, "POST", `/api/groups/${room.id}/messages`, { text: "@Pixie second question SECOND-PROMPT-MARK" }, undefined, 202);
    await expect.poll(async () => (await roomMessages()).filter(m => m.kind === "text" && m.from?.botId === rbId && m.text?.includes(REPLY)).length,
      { timeout: 45_000, interval: 250 }).toBe(2);
    expect((await pixieTasks()).filter(task => task.title?.startsWith("room · ")).map(task => task.threadId)).toEqual([bThread]);
    expect((await api(b, "GET", `/api/threads/${bThread}/messages?limit=200`, undefined, undefined, 200)).body.messages
      .some((m: any) => m.role === "user" && m.text?.includes("SECOND-PROMPT-MARK"))).toBe(true);
    expect(JSON.parse(readFileSync(join(A.info.dataDir, "room-remote-threads.json"), "utf8"))).toEqual({ [`${room.id}:${rbId}`]: bThread });

    // 4. privacy: B's private owner thread never reaches A's room or events
    expect(JSON.stringify(await roomMessages())).not.toContain(SECRET);
    expect(JSON.stringify(events.frames)).not.toContain(SECRET);
    expect(JSON.stringify((await api(A, "GET", "/api/bots")).body)).not.toContain(SECRET);

    // 5. link down → bounded unavailable note instead of hanging
    await b.close(); bClosed = true;
    const started = Date.now();
    await api(A, "POST", `/api/groups/${room.id}/messages`, { text: "@Pixie are you there THIRD-PROMPT-MARK" }, undefined, 202);
    await expect.poll(async () => (await roomMessages()).some(m => m.kind === "activity" && m.from?.botId === rbId && m.tool?.name?.includes(UNAVAILABLE)),
      { timeout: 20_000, interval: 250 }).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect((await roomMessages()).filter(m => m.kind === "text" && m.from?.botId === rbId)).toHaveLength(2);
    expect(JSON.stringify(events.frames)).not.toContain(SECRET);
    expect(existsSync(join(A.info.dataDir, "room-remote-threads.json"))).toBe(true);
  } finally {
    events?.close();
    await Promise.all([a?.close(), bClosed ? undefined : b.close()]);
  }
}, 180_000);
