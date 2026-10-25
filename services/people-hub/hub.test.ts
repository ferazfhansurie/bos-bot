import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHub } from "./hub.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "people-hub-"));
  const emails: Array<{ to: string; subject: string }> = [];
  const { hub, server } = startHub({ port: 0, dataDir: dir, publicOrigin: "https://people.test", sendEmail: async (to, subject) => { emails.push({ to, subject }); } });
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const response = await fetch(base + path, { method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined });
    const text = await response.text();
    return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  const join2 = async (homeId: string, name: string) => (await call("/hub/v1/register", { body: { homeId, name } })).body.token as string;
  return { hub, server, call, join: join2, emails, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("invite, dm, tag a bot, group with bots and two people", async () => {
  const t = await setup();
  try {
    const a = await t.join("homeA", "Aina");
    const b = await t.join("homeB", "Badrul");
    assert.equal((await t.call("/hub/v1/register", { body: { homeId: "homeA", name: "squat" } })).status, 409);
    await t.call("/hub/v1/bots", { method: "PUT", token: a, body: { bots: [{ localId: "chief", name: "Chief" }] } });
    await t.call("/hub/v1/bots", { method: "PUT", token: b, body: { bots: [{ localId: "sales", name: "Sales" }] } });

    const invite = await t.call("/hub/v1/invites", { token: a, body: { email: "badrul@example.com" } });
    assert.equal(invite.status, 201);
    assert.equal(t.emails[0]?.to, "badrul@example.com");
    const token = invite.body.token as string;
    assert.match((await t.call(`/i/${token}`)).body, /Aina invited you/);
    assert.equal((await t.call(`/hub/v1/invites/${token}/accept`, { token: a, body: {} })).status, 400);
    const accepted = await t.call(`/hub/v1/invites/${token}/accept`, { token: b, body: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.contact.name, "Aina");
    const dm = accepted.body.room;

    // B sees A as a contact and the DM named after A.
    const contacts = await t.call("/api/multiplayer/contacts", { token: b });
    assert.deepEqual(contacts.body.contacts.map((c: { name: string }) => c.name), ["Aina"]);
    const rooms = await t.call("/api/multiplayer/rooms", { token: b });
    assert.equal(rooms.body.rooms[0].name, "Aina");

    // A plain DM never wakes a bot.
    const hello = await t.call(`/api/multiplayer/rooms/${dm.id}/messages`, { token: b, body: { text: "hey", sendId: "s1" } });
    assert.equal(hello.status, 201);
    assert.equal(hello.body.message.botTargets, undefined);
    const noteA = await t.call("/hub/v1/events?after=0", { token: a });
    assert.equal(noteA.body.jobs.length, 0);
    assert.equal(noteA.body.notifications[0].senderName, "Badrul");

    // A tags A's own bot; B's bots are not available in A's DM.
    const bots = await t.call(`/api/multiplayer/rooms/${dm.id}/bots`, { token: a });
    assert.deepEqual(bots.body.bots.map((bot: { name: string }) => bot.name), ["Chief"]);
    const ask = await t.call(`/api/multiplayer/rooms/${dm.id}/messages`, { token: a, body: { text: "@Chief what's the plan", sendId: "s2" } });
    assert.deepEqual(ask.body.message.botTargets, ["homeA:bot:chief"]);
    const events = await t.call("/hub/v1/events?after=-1", { token: a });
    assert.equal(events.body.jobs.length, 1);
    const job = events.body.jobs[0];
    assert.equal((await t.call(`/hub/v1/jobs/${job.id}/claim`, { token: b, body: {} })).status, 404);
    const claim = await t.call(`/hub/v1/jobs/${job.id}/claim`, { token: a, body: {} });
    assert.equal(claim.body.senderName, "Aina");
    assert.equal(claim.body.recent[0].text, "hey");
    assert.equal((await t.call(`/hub/v1/jobs/${job.id}/claim`, { token: a, body: {} })).status, 409);
    await t.call(`/hub/v1/jobs/${job.id}/activity`, { token: a, body: { sendId: "act1", tool: { name: "Read" } } });
    const reply = await t.call(`/hub/v1/jobs/${job.id}/reply`, { token: a, body: { text: "ship the invite flow" } });
    assert.equal(reply.body.message.actor.localId, "chief");
    const after = await t.call(`/api/multiplayer/rooms/${dm.id}/messages?latest=1`, { token: b });
    assert.equal(after.body.messages.at(-1).text, "ship the invite flow");
    const requests = await t.call(`/api/multiplayer/rooms/${dm.id}/requests`, { token: b });
    assert.equal(requests.body.requests[0].state, "completed");

    // Group: A creates it with B and both A's bot; B adds B's own bot.
    const stranger = await t.join("homeC", "Chan");
    assert.equal((await t.call("/api/multiplayer/rooms", { token: a, body: { name: "Launch", memberIds: ["homeA:person:owner", "homeC:person:owner"] } })).status, 403);
    const group = (await t.call("/api/multiplayer/rooms", { token: a, body: { name: "Launch", memberIds: ["homeA:person:owner", "homeB:person:owner", "homeA:bot:chief"] } })).body.room;
    assert.equal((await t.call(`/api/multiplayer/rooms/${group.id}`, { method: "PATCH", token: b, body: { revision: group.revision, memberIds: [...group.memberIds, "homeC:person:owner"] } })).status, 403);
    const added = await t.call(`/api/multiplayer/rooms/${group.id}`, { method: "PATCH", token: b, body: { revision: group.revision, memberIds: [...group.memberIds, "homeB:bot:sales"] } });
    assert.equal(added.status, 200);
    const renamed = await t.call(`/api/multiplayer/rooms/${group.id}`, { method: "PATCH", token: b, body: { revision: added.body.room.revision, name: "Launch crew" } });
    assert.equal(renamed.body.room.name, "Launch crew");
    const groupBots = await t.call(`/api/multiplayer/rooms/${group.id}/bots`, { token: b });
    assert.deepEqual(groupBots.body.bots.map((bot: { name: string }) => bot.name).sort(), ["Chief", "Sales"]);
    const both = await t.call(`/api/multiplayer/rooms/${group.id}/messages`, { token: b, body: { text: "@Sales and @Chief draft the post", sendId: "g1" } });
    assert.deepEqual([...both.body.message.botTargets].sort(), ["homeA:bot:chief", "homeB:bot:sales"]);
    assert.equal((await t.call("/hub/v1/events?after=-1", { token: a })).body.jobs.length, 1);
    assert.equal((await t.call("/hub/v1/events?after=-1", { token: b })).body.jobs.length, 1);
    // Strangers cannot read the group.
    assert.equal((await t.call(`/api/multiplayer/rooms/${group.id}/messages?latest=1`, { token: stranger })).status, 404);
    // Leaving takes B's bot out too.
    const left = await t.call(`/api/multiplayer/rooms/${group.id}/leave`, { token: b, body: { revision: renamed.body.room.revision } });
    assert.deepEqual(left.body.room.memberIds, ["homeA:person:owner", "homeA:bot:chief"]);
  } finally { t.close(); }
});

test("long-poll wakes on a new message and unknown tokens are refused", async () => {
  const t = await setup();
  try {
    const a = await t.join("homeA", "Aina");
    const b = await t.join("homeB", "Badrul");
    assert.equal((await t.call("/hub/v1/events", { token: "bph_nope" })).status, 401);
    const { body: invite } = await t.call("/hub/v1/invites", { token: a, body: {} });
    const room = (await t.call(`/hub/v1/invites/${invite.token}/accept`, { token: b, body: {} })).body.room;
    const started = Date.now();
    const waiting = t.call("/hub/v1/events?after=0&wait=10", { token: a });
    setTimeout(() => void t.call(`/api/multiplayer/rooms/${room.id}/messages`, { token: b, body: { text: "ping", sendId: "p1" } }), 100);
    const result = await waiting;
    assert.ok(Date.now() - started < 5000);
    assert.equal(result.body.notifications[0].text, "ping");
    const summaries = await t.call("/api/multiplayer/rooms", { token: a });
    assert.equal(summaries.body.rooms[0].unreadCount, 1);
  } finally { t.close(); }
});
