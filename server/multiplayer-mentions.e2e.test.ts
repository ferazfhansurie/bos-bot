import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("keeps human notifications separate from bot requests and retries stable after renaming", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    await api("PUT", "/api/config", { profile: { name: "Alex" } });
    const me = (await api("GET", "/api/multiplayer/me")).body;
    const pair = (await api("POST", "/api/auth/pairing", { scopes: ["peer"] })).body;
    const paired = (await api("POST", "/api/auth/pair", { code: pair.code, label: "Fixture teammate" })).body;
    const personId = "maya-home:person:owner";
    expect((await api("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId, name: "Maya" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Maya", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const botId = `${me.homeId}:bot:${bot.id}`;
    const room = (await api("POST", "/api/multiplayer/rooms", { name: "Mention tests", memberIds: [me.actorId, personId] })).body.room;
    const path = `/api/multiplayer/rooms/${room.id}`;
    const human = await api("POST", `${path}/messages`, { text: "@Maya · person please review", sendId: "human", humanMentions: [personId], botTargets: [] });
    expect(human.status).toBe(201);
    expect(human.body.message).toMatchObject({ humanMentions: [personId], botTargets: [] });
    for (const [sendId, text] of [["ambiguous", "@Maya help"], ["quoted", '> @Maya · Alex\n\n`@Maya · person`'], ["plain", "Maya will review"]]) {
      const result = await api("POST", `${path}/messages`, { text, sendId });
      expect(result.status).toBe(201);
      expect(result.body.message).toMatchObject({ humanMentions: [], botTargets: [] });
    }
    expect((await api("POST", `${path}/messages`, { text: "@Maya · person", sendId: "wrong-bot", botTargets: [botId] })).status).toBe(403);
    expect((await api("POST", `${path}/messages`, { text: "@Maya · Alex", sendId: "wrong-person", humanMentions: [personId] })).status).toBe(403);
    expect((await api("POST", `${path}/messages`, { text: "@Nobody", sendId: "outsider", humanMentions: ["outside:person:owner"] })).status).toBe(403);
    const suppressed = await api("POST", `${path}/messages`, { text: "@Maya · Alex", sendId: "no-bot-selected", botTargets: [] });
    expect(suppressed.body.message.botTargets).toEqual([]);
    expect((await api("GET", `${path}/requests`)).body.requests).toEqual([]);
    const payload = { text: "@Maya · Alex summarize this", sendId: "bot-request", botTargets: [botId] };
    const asked = await api("POST", `${path}/messages`, payload);
    expect(asked.status).toBe(201);
    expect(asked.body.message).toMatchObject({ humanMentions: [], botTargets: [botId] });
    await expect.poll(async () => (await api("GET", `${path}/requests`)).body.requests[0]?.state, { timeout: 20_000, interval: 100 }).toBe("completed");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed" })).status).toBe(200);
    const retry = await api("POST", `${path}/messages`, payload);
    expect(retry.status).toBe(200);
    expect(retry.body.message.id).toBe(asked.body.message.id);
    expect((await api("GET", `${path}/requests`)).body.requests).toHaveLength(1);
    expect((await api("POST", `${path}/messages`, { ...payload, text: "changed contents" })).status).toBe(400);
    const follow = await api("POST", `${path}/messages`, { text: "and explain it", sendId: "follow", botTargets: [] });
    expect(follow.body.message.botTargets).toEqual([botId]);
    expect((await api("GET", `${path}/preferences`)).body.replyBotIds).toEqual([botId]);
    await api("POST", `${path}/messages`, { text: "@Maya your turn", sendId: "pause" });
    expect((await api("POST", `${path}/messages`, { text: "still talking to Maya", sendId: "paused" })).body.message.botTargets).toEqual([]);
    expect((await api("PATCH", `${path}/preferences`, { replyMode: "fixed", replyBotId: "outside:bot:no" })).status).toBe(403);
    expect((await api("PATCH", `${path}/preferences`, { replyMode: "fixed", replyBotId: botId })).body.replyBotIds).toEqual([botId]);
    expect((await api("POST", `${path}/messages`, { text: "fixed reply", sendId: "fixed" })).body.message.botTargets).toEqual([botId]);
    expect((await api("PATCH", `${path}/preferences`, { replyMode: "mentions" })).status).toBe(200);
    expect((await api("POST", `${path}/messages`, { text: "quiet now", sendId: "quiet" })).body.message.botTargets).toEqual([]);
    const originalRetry = await api("POST", `${path}/messages`, { text: "and explain it", sendId: "follow", botTargets: [] });
    expect(originalRetry.body.message.botTargets).toEqual([botId]);
    const direct = (await api("POST", "/api/multiplayer/dm", { targetId: personId })).body.room;
    const directPath = `/api/multiplayer/rooms/${direct.id}/messages`;
    const directAsk = await api("POST", directPath, { text: "@Renamed help", sendId: "direct-ask" });
    expect(directAsk.body.message.botTargets).toEqual([botId]);
    const directFollow = await api("POST", directPath, { text: "private human followup", sendId: "direct-follow" });
    expect(directFollow.body.message.botTargets).toEqual([]);


  } finally { await fixture.close(); }
}, 60_000);
