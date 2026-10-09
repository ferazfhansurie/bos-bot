import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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

async function roomWithPerson(role: "admin" | "member" | "client-guest") {
  const scratch = mkdtempSync(join(tmpdir(), "room-admin-trust-"));
  const a = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(["ADMIN-TRUST-REPLY-904"]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "state"), FAKE_CLAUDE_TOOL_CALLS: "[]" });
  try {
    const me = await api(a, "GET", "/api/multiplayer/me");
    const local = (await api(a, "GET", "/api/bots")).bots[0];
    await api(a, "PATCH", `/api/bots/${local.id}`, { name: "Local", soul: "HOME-SOUL-904" });
    const room = (await api(a, "POST", "/api/groups", { name: "Team inbox", memberIds: [local.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).group;
    const pairing = await api(a, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api(a, "POST", "/api/auth/pair", { code: pairing.code, label: "Linked home person" });
    const personId = `${randomUUID()}:person:owner`;
    await api(a, "POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId, name: "Firaz" });
    await api(a, "PUT", `/api/multiplayer/members/${encodeURIComponent(personId)}`, { role });
    await api(a, "POST", `/api/groups/${room.id}/people`, { personId });
    await api(a, "PUT", `/api/multiplayer/rooms/${room.id}/bot-grants`, { botIds: [`${me.homeId}:bot:${local.id}`] });
    return { a, local, room, token: paired.token as string,
      messages: async () => (await api(a, "GET", `/api/threads/${room.threadId}/messages?limit=200`)).messages as any[],
      dump: () => JSON.parse(readFileSync(join(a.info.dataDir, "fake-claude-dump.json"), "utf8")),
      close: async () => { await a.close(); await removeTempDir(scratch); } };
  } catch (error) { await a.close(); await removeTempDir(scratch); throw error; }
}

test("an admin's room message runs the bot with its full home setup", async () => {
  const f = await roomWithPerson("admin");
  try {
    const sent = await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Local check the server", sendId: randomUUID() }, f.token);
    expect(sent.message.sender.name).toBe("Firaz");
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "ADMIN-TRUST-REPLY-904"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    const dump = f.dump();
    expect(dump.systemPrompt).toContain("HOME-SOUL-904");
    expect(dump.argv).not.toContain("--restricted");
    expect(JSON.stringify(dump.prompt)).not.toContain("This is a helper conversation");
    // No private helper thread: the turn ran in the room itself.
    const tasks = (await api(f.a, "GET", "/api/bots")).bots.find((bot: any) => bot.id === f.local.id).tasks;
    expect(tasks.some((task: any) => String(task.title).startsWith("room · "))).toBe(false);
    expect((await f.messages()).filter(m => m.role === "user").map(m => m.sender?.name)).toEqual(["Firaz"]);
  } finally { await f.close(); }
}, 60_000);

test.each(["member", "client-guest"] as const)("a %s keeps the conversation-only helper policy", async role => {
  const f = await roomWithPerson(role);
  try {
    await api(f.a, "POST", `/api/groups/${f.room.id}/messages`, { text: "@Local check the server", sendId: randomUUID() }, f.token);
    await expect.poll(async () => (await f.messages()).some(m => m.from?.botId === f.local.id && m.text === "ADMIN-TRUST-REPLY-904"),
      { timeout: 20_000, interval: 250 }).toBe(true);
    const dump = f.dump();
    expect(dump.systemPrompt).not.toContain("HOME-SOUL-904");
    expect(dump.argv).toEqual(expect.arrayContaining(["--restricted", "--safe-mode"]));
  } finally { await f.close(); }
}, 60_000);
