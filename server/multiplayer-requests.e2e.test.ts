import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("records, scopes and cancels exact shared requests without dispatching cancelled queued work", async () => {
  const gate = join("/tmp", `bos-requests-${randomUUID()}.gate`);
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const me = (await api("GET", "/api/multiplayer/me")).body;
    const pair = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api("POST", "/api/auth/pair", { code: pair.body.code, label: "Fixture teammate" });
    const teammate = "teammate-home:person:owner";
    expect((await api("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.body.session.id, personId: teammate, name: "Teammate" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Helper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const room = (await api("POST", "/api/multiplayer/rooms", { name: "Request tests", memberIds: [me.actorId, teammate] })).body.room;
    const path = `/api/multiplayer/rooms/${room.id}`;
    const requests = async () => (await api("GET", `${path}/requests`)).body.requests as any[];
    const message = { text: "@Helper work on this", sendId: "first" };
    const first = await api("POST", `${path}/messages`, message);
    expect(first.status).toBe(201);
    expect((await api("POST", `${path}/messages`, message)).status).toBe(200);
    await expect.poll(async () => (await requests())[0]?.state, { timeout: 15_000, interval: 100 }).toBe("working");
    const working = (await requests())[0];
    expect(working).toMatchObject({ sourceId: first.body.message.id, requesterId: me.actorId, ownerId: me.actorId, botId: `${me.homeId}:bot:${bot.id}` });
    expect(await requests()).toHaveLength(1);
    expect((await api("GET", `${path}/requests`, undefined, paired.body.token)).status).toBe(200);
    expect((await api("POST", `${path}/requests/${working.id}/cancel`, {}, paired.body.token)).status).toBe(403);
    const second = await api("POST", `${path}/messages`, { text: "@Helper next", sendId: "second" });
    expect(second.status).toBe(201);
    const queued = (await requests()).find(item => item.sourceId === second.body.message.id);
    expect(queued.state).toBe("queued");
    expect(queued.dispatchedAt).toBeUndefined();
    expect((await api("POST", `${path}/requests/${queued.id}/cancel`, {})).body.request.state).toBe("cancelled");
    expect((await api("POST", `${path}/requests/${working.id}/cancel`, {})).body.request.state).toBe("cancelled");
    await expect.poll(async () => (await api("GET", `${path}/messages`)).body.messages.some((item: any) => item.responseTo === first.body.message.id && item.tool?.name === "working" && item.tool.ok === false), { timeout: 10_000, interval: 100 }).toBe(true);
    writeFileSync(gate, "finish");
    const third = await api("POST", `${path}/messages`, { text: "@Helper new deliberate request", sendId: "third" });
    await expect.poll(async () => (await requests()).find(item => item.sourceId === third.body.message.id)?.state, { timeout: 20_000, interval: 100 }).toBe("completed");
    const records = await requests();
    expect(records.find(item => item.id === queued.id)).toMatchObject({ state: "cancelled" });
    expect(records.find(item => item.id === queued.id).dispatchedAt).toBeUndefined();
    const history = (await api("GET", `${path}/messages`)).body.messages;
    expect(history.filter((item: any) => [first.body.message.id, second.body.message.id].includes(item.responseTo) && item.kind !== "activity")).toHaveLength(0);
    const complete = records.find(item => item.sourceId === third.body.message.id);
    expect(history.some((item: any) => item.id === complete.resultId)).toBe(true);
    expect((await api("POST", `${path}/requests/${complete.id}/cancel`, {})).body.request.state).toBe("completed");
    expect((await api("GET", `${path}/requests?limit=1`)).body).toMatchObject({ requests: [{ id: complete.id }], hasMore: true });
    expect((await api("GET", `${path}/requests?before=${third.body.message.sequence}&limit=1`)).body.requests[0].id).toBe(queued.id);
    expect((await api("GET", `${path}/requests?limit=101`)).status).toBe(400);
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "shared-requests.json"), "utf8"));
    expect(saved.requests.filter((item: any) => item.state === "cancelled")).toHaveLength(2);
    rmSync(gate);
    const revised = await api("POST", `${path}/messages`, { text: "@Helper original request", sendId: "revised" });
    await expect.poll(async () => (await requests()).find(item => item.sourceId === revised.body.message.id)?.state, { timeout: 10_000, interval: 100 }).toBe("working");
    expect((await api("PATCH", `${path}/messages/${revised.body.message.id}`, { text: "changed request" })).status).toBe(200);
    await expect.poll(async () => (await requests()).find(item => item.sourceId === revised.body.message.id)?.state, { timeout: 10_000, interval: 100 }).toBe("cancelled");
    expect((await api("GET", `${path}/messages`)).body.messages.some((item: any) => item.responseTo === revised.body.message.id && item.kind !== "activity")).toBe(false);
    const left = await api("POST", `${path}/leave`, { revision: 1 }, paired.body.token);
    expect(left.status).toBe(200);
    expect((await api("GET", `${path}/requests`, undefined, paired.body.token)).status).toBe(404);
  } finally { await fixture.close(); rmSync(gate, { force: true }); }
}, 60_000);
