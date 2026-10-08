import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;
async function api(fixture: Fixture, method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(fixture.info.url + path, { method,
    headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json() as any;
  expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
}

async function linkedRoom(remoteReplies: string[], localReplies = ["local answer"], remoteApproval = false, scriptedLocal = false, gateRemote = false) {
  const scratch = mkdtempSync(join(tmpdir(), "remote-reply-mentions-"));
  let a: Fixture | undefined;
  let b: Fixture | undefined;
  try {
    b = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(remoteReplies),
      FAKE_CLAUDE_REPLY_STATE: join(scratch, "remote-state"), FAKE_CLAUDE_TOOL_CALLS: "[]",
      ...(gateRemote ? { FAKE_CLAUDE_MODE: "background-result", FAKE_CLAUDE_FINISH_GATE: join(scratch, "remote-finish") } : {}) });
    const bHome = (await api(b, "GET", "/.well-known/openmausbot/environment")).environmentId;
    const template = (await api(b, "GET", "/api/bots")).bots[0];
    const remote = (await api(b, "POST", "/api/bots", { name: "Pixie", modelSelection: template.modelSelection })).bot;
    if (remoteApproval) await api(b, "PATCH", `/api/bots/${remote.id}`, { approvePeerComms: true });
    const pairing = await api(b, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api(b, "POST", "/api/auth/pair", { code: pairing.code, label: "Fixture bridge" });
    a = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(localReplies),
      FAKE_CLAUDE_REPLY_STATE: join(scratch, "local-state"), FAKE_CLAUDE_TOOL_CALLS: "[]" },
      undefined, undefined, undefined, undefined, scriptedLocal ? { scripted: true } : undefined, [], undefined, {
        origin: b.info.url, prepare: dataDir => {
          writeFileSync(join(dataDir, "environment-id"), randomUUID());
          writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{
            homeId: bHome, name: "B", origin: "https://delegated-fixture.example.ts.net:8443", token: paired.token, bots: [], proxyGroups: {},
          }] }));
        },
      });
    const A = a;
    let rbId = "";
    await expect.poll(async () => {
      rbId = (await api(A, "GET", "/api/bots")).bots.find((bot: any) => bot.id.startsWith("rb-") && bot.id.endsWith(`-${remote.id}`))?.id ?? "";
      return rbId;
    }, { timeout: 30_000, interval: 250 }).not.toBe("");
    const local = (await api(A, "GET", "/api/bots")).bots.find((bot: any) => !bot.id.startsWith("rb-"));
    await api(A, "PATCH", `/api/bots/${local.id}`, { name: "Local" });
    const room = (await api(A, "POST", "/api/groups", { name: "Mixed homes", memberIds: [local.id, rbId],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).group;
    return { a: A, b, bHome, rbId, local, room,
      releaseRemote: () => writeFileSync(join(scratch, "remote-finish"), "finish fixture turn"),
      messages: async () => (await api(A, "GET", `/api/threads/${room.threadId}/messages?limit=200`)).messages as any[],
      settled: async () => { await expect.poll(async () => {
        const current = (await api(A, "GET", "/api/groups")).groups.find((g: any) => g.id === room.id);
        return Boolean(current.working);
      }, { timeout: 25_000, interval: 250 }).toBe(false); },
      close: async () => { await Promise.all([A.close(), b!.close()]); await removeTempDir(scratch); } };
  } catch (error) {
    await Promise.all([a?.close(), b?.close()]); await removeTempDir(scratch); throw error;
  }
}

async function roomGuest(f: Awaited<ReturnType<typeof linkedRoom>>, grantLocal = true, homeId = f.bHome) {
  const me = await api(f.a, "GET", "/api/multiplayer/me");
  const pairing = await api(f.a, "POST", "/api/auth/pairing", { scopes: ["peer"] });
  const paired = await api(f.a, "POST", "/api/auth/pair", { code: pairing.code, label: "Linked home guest" });
  const personId = `${homeId}:person:owner`;
  await api(f.a, "POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId, name: "Guest" });
  await api(f.a, "PUT", `/api/multiplayer/members/${encodeURIComponent(personId)}`, { role: "client-guest" });
  await api(f.a, "POST", `/api/groups/${f.room.id}/people`, { personId });
  if (grantLocal) await api(f.a, "PUT", `/api/multiplayer/rooms/${f.room.id}/bot-grants`, { botIds: [`${me.homeId}:bot:${f.local.id}`] });
  return { token: paired.token as string, sessionId: paired.session.id as string, personId };
}

test("a guest's linked-mac mention wakes a granted local helper and routes its reply back", async () => {
  const f = await linkedRoom(["@Local answer GUEST-REMOTE-731", "REMOTE-FOLLOWUP-731"], ["@Pixie review GUEST-LOCAL-731"]);
  try {
    const { token } = await roomGuest(f);
    await api(f.a, "PATCH", `/api/bots/${f.local.id}`, { soul: "PRIVATE-GUEST-CHAIN-SOUL" });
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie ask Local", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "@Pixie review GUEST-LOCAL-731"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    const dump = JSON.parse(readFileSync(join(f.a.info.dataDir, "fake-claude-dump.json"), "utf8"));
    expect(JSON.stringify(dump.prompt)).toContain("GUEST-REMOTE-731");
    expect(dump.systemPrompt).not.toContain("PRIVATE-GUEST-CHAIN-SOUL");
    expect(dump.mcpConfig?.mcpServers?.agents).toBeUndefined();
    expect(dump.argv[dump.argv.indexOf("--tools") + 1]).toBe("");
    expect(dump.argv).toEqual(expect.arrayContaining(["--restricted", "--safe-mode"]));
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.rbId && m.text === "REMOTE-FOLLOWUP-731"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    const replies = (await f.messages()).filter(m => m.kind === "text" && m.role === "bot");
    expect(replies.map(m => m.from.botId)).toEqual([f.rbId, f.local.id, f.rbId]);
    expect(replies[1].replyToId).toBe(replies[0].id);
    expect(replies[2].replyToId).toBe(replies[1].id);
  } finally { await f.close(); }
}, 90_000);

test("guest reply mentions never wake an ungranted local bot", async () => {
  const f = await linkedRoom(["@Local @Forbidden review GUEST-GRANTS-731"], ["@Forbidden review my result"]);
  try {
    const forbidden = (await api(f.a, "POST", "/api/bots", { name: "Forbidden", modelSelection: f.local.modelSelection })).bot;
    const tasksBefore = forbidden.tasks.map((task: any) => task.threadId);
    await api(f.a, "PATCH", `/api/groups/${f.room.id}`, { memberIds: [f.local.id, forbidden.id, f.rbId] });
    const { token } = await roomGuest(f);
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie begin", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "@Forbidden review my result"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === forbidden.id)).toHaveLength(0);
    expect((await api(f.a, "GET", "/api/bots")).bots.find((bot: any) => bot.id === forbidden.id).tasks.map((task: any) => task.threadId)).toEqual(tasksBefore);
  } finally { await f.close(); }
}, 90_000);

test("a guest's local reply cannot summon another person's ungranted linked-mac bot", async () => {
  const f = await linkedRoom(["REMOTE-MUST-NOT-RUN-731"], ["@Pixie review this question"]);
  try {
    const { token } = await roomGuest(f, true, "unrelated-guest-home");
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Local begin", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "@Pixie review this question"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.rbId)).toHaveLength(0);
    expect(existsSync(join(f.b.info.dataDir, "fake-claude-dump.json"))).toBe(false);
  } finally { await f.close(); }
}, 90_000);

test.each(["grant", "session", "membership"])("guest mentions recheck %s after an in-flight linked-mac reply", async revoke => {
  const f = await linkedRoom(["@Local answer GUEST-REVOKE-731"], ["LOCAL-MUST-NOT-RUN-731"], false, false, true);
  try {
    const guest = await roomGuest(f);
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie ask Local", sendId: randomUUID() }, guest.token);
    await expect.poll(() => existsSync(join(f.b.info.dataDir, "fake-claude-dump.json")), { timeout: 20_000, interval: 250 }).toBe(true);
    if (revoke === "grant") await api(f.a, "PUT", `/api/multiplayer/rooms/${f.room.id}/bot-grants`, { botIds: [] });
    if (revoke === "session") await api(f.a, "DELETE", `/api/auth/sessions/${guest.sessionId}`);
    if (revoke === "membership") await api(f.a, "DELETE", `/api/groups/${f.room.id}/people/${encodeURIComponent(guest.personId)}`);
    f.releaseRemote();
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id)).toHaveLength(0);
    expect(existsSync(join(f.a.info.dataDir, "fake-claude-dump.json"))).toBe(false);
  } finally { f.releaseRemote(); await f.close(); }
}, 90_000);

test.each(["remote", "local"])("guest reply mentions preserve %s sender peer approval", async speaker => {
  const f = await linkedRoom(["@Local review this request"], ["@Pixie review this result"], speaker === "remote");
  try {
    const { token } = await roomGuest(f);
    if (speaker === "local") await api(f.a, "PATCH", `/api/bots/${f.local.id}`, { approvePeerComms: true });
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: speaker === "remote" ? "@Pixie begin" : "@Local begin", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).some(m => m.tool?.name?.includes("Sender requires peer approval")),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.kind === "text" && m.role === "bot").map(m => m.from.botId))
      .toEqual([speaker === "remote" ? f.rbId : f.local.id]);
  } finally { await f.close(); }
}, 90_000);

test("guest local-to-linked-mac reply chains stop at six hops", async () => {
  const f = await linkedRoom(Array.from({ length: 10 }, (_, i) => `@Local guest remote question ${i}`),
    Array.from({ length: 10 }, (_, i) => `@Pixie guest local question ${i}`));
  try {
    const { token } = await roomGuest(f);
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Local begin", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).filter(m => m.kind === "text" && m.role === "bot").length,
      { timeout: 30_000, interval: 250 }).toBe(6);
    await f.settled();
    expect((await f.messages()).filter(m => m.kind === "text" && m.role === "bot").map(m => m.from.botId))
      .toEqual([f.local.id, f.rbId, f.local.id, f.rbId, f.local.id, f.rbId]);
  } finally { await f.close(); }
}, 90_000);

test("guest repeated mention routes deliver once per request", async () => {
  const f = await linkedRoom(Array(5).fill("@Local review the same guest request"), Array(5).fill("@Pixie review the same guest result"));
  try {
    const { token } = await roomGuest(f);
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie begin", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).filter(m => m.kind === "text" && m.role === "bot").length,
      { timeout: 20_000, interval: 250 }).toBe(3);
    await f.settled();
    expect((await f.messages()).filter(m => m.kind === "text" && m.role === "bot").map(m => m.from.botId))
      .toEqual([f.rbId, f.local.id, f.rbId]);
  } finally { await f.close(); }
}, 90_000);

test.each(["@Local thanks", "the question for @Local is already answered"])("guest reply does not chain on %s", async reply => {
  const f = await linkedRoom([reply]);
  try {
    const { token } = await roomGuest(f);
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie answer once", sendId: randomUUID() }, token);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.rbId && m.text === reply),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text")).toHaveLength(0);
  } finally { await f.close(); }
}, 90_000);

test("a linked-mac member's @name reply wakes the local member", async () => {
  const f = await linkedRoom(["@Local please answer REMOTE-REQUEST-731"], ["LOCAL-ANSWER-731"]);
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie ask our local teammate" });
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.rbId && m.text?.includes("REMOTE-REQUEST-731")),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "LOCAL-ANSWER-731"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    const dump = JSON.parse(readFileSync(join(f.a.info.dataDir, "fake-claude-dump.json"), "utf8"));
    expect(JSON.stringify(dump.prompt)).toContain("REMOTE-REQUEST-731");
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text")).toHaveLength(1);
  } finally { await f.close(); }
}, 90_000);

test("repeated linked-mac mention routes deliver once per round", async () => {
  const f = await linkedRoom(Array(5).fill("@Local review the same request"), Array(5).fill("@Pixie review the same response"));
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie begin the exchange" });
    await expect.poll(async () => (await f.messages()).filter(m => m.role === "bot" && m.kind === "text").length,
      { timeout: 20_000, interval: 250 }).toBe(3);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text")).toHaveLength(1);
  } finally { await f.close(); }
}, 90_000);

test("a remote room handoff's addressed reply wakes a local room member", async () => {
  const f = await linkedRoom(["@Local review REMOTE-HANDOFF-731"], [], false, true);
  try {
    const requester = (await api(f.a, "POST", "/api/bots", { name: "Requester", modelSelection: f.local.modelSelection })).bot;
    await api(f.a, "PATCH", `/api/groups/${f.room.id}`, { memberIds: [requester.id, f.local.id, f.rbId] });
    writeFileSync(join(f.a.info.dataDir, "room-plan.json"), JSON.stringify({
      [requester.id]: { steps: [{ arguments: { bot_ids: [f.rbId], request_key: "remote-review", message: "Ask Local to review this" } }], reply: "Assigned", resumeReply: "Review complete" },
      [f.local.id]: { reply: "LOCAL-HANDOFF-ANSWER-731" },
    }));
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Requester coordinate the review" });
    // The scripted provider answers depth-capped turns from their prompt
    // when no teammate tools are mounted. Either way, Local must run and
    // receive the remote handoff reply as the addressed source.
    await expect.poll(async () => (await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text").length,
      { timeout: 25_000, interval: 250 }).toBe(1);
    expect((await f.messages()).find(m => m.from?.botId === f.local.id && m.kind === "text").text).toContain("REMOTE-HANDOFF-731");
    await f.settled();
  } finally { await f.close(); }
}, 90_000);

test("a local sender still requires peer approval when replying to a linked-mac member", async () => {
  const f = await linkedRoom(["@Local answer this question"], ["@Pixie answer my followup"]);
  try {
    await api(f.a, "PATCH", `/api/bots/${f.local.id}`, { approvePeerComms: true });
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie request an answer" });
    await expect.poll(async () => (await f.messages()).some(m => m.tool?.name?.includes("Sender requires peer approval")),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.rbId && m.kind === "text")).toHaveLength(1);
  } finally { await f.close(); }
}, 90_000);

test("linked-mac reply mentions keep local-to-remote chains bounded by six hops", async () => {
  const f = await linkedRoom(Array.from({ length: 10 }, (_, i) => `@Local remote question ${i}`),
    Array.from({ length: 10 }, (_, i) => `@Pixie local question ${i}`));
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie begin the exchange" });
    await expect.poll(async () => (await f.messages()).filter(m => m.role === "bot" && m.kind === "text").length,
      { timeout: 30_000, interval: 250 }).toBe(6);
    await f.settled();
    const replies = (await f.messages()).filter(m => m.role === "bot" && m.kind === "text");
    expect(replies.map(m => m.from.botId)).toEqual([f.rbId, f.local.id, f.rbId, f.local.id, f.rbId, f.local.id]);
    expect(replies[2].replyToId).toBe(replies[1].id);
  } finally { await f.close(); }
}, 90_000);

test.each(["@Local thanks", "the question for @Local is already answered"])("linked-mac reply does not chain on %s", async reply => {
  const f = await linkedRoom([reply]);
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie answer once" });
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.rbId && m.text === reply),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text")).toHaveLength(0);
  } finally { await f.close(); }
}, 90_000);

test("linked-mac mention routing preserves sender peer approval", async () => {
  const f = await linkedRoom(["@Local please answer this question"], ["@Pixie reply to this question"], true);
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Pixie request a local reply" });
    await expect.poll(async () => (await f.messages()).some(m => m.tool?.name?.includes("Sender requires peer approval")),
      { timeout: 20_000, interval: 250 }).toBe(true);
    await f.settled();
    expect((await f.messages()).filter(m => m.from?.botId === f.local.id && m.kind === "text")).toHaveLength(0);
  } finally { await f.close(); }
}, 90_000);
