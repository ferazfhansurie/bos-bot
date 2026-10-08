import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MultiplayerLinks } from "./multiplayer-links.ts";
import { handleRemoteRoom, type RemoteRoomContext } from "./remote-rooms.ts";

const TOKEN = `omb_sess_${"p".repeat(43)}`;
const ORIGIN = "https://partner-fixture.ts.net";
const remoteGroup = {
  id: "room-remote", threadId: "thread-remote", name: "Launch room", memberIds: ["pixie", "claude"],
  memberBots: [{ id: "pixie", name: "Pixie", title: "helper", color: "blue", mascotBody: "cat", mascotEyes: "round", avatarUrl: null }, { id: "claude", name: "Claude", title: "helper", mascotBody: null, mascotEyes: null, avatarUrl: "/api/attachments/claude.png" }], avatarUrl: "/api/attachments/room.png", peopleIds: ["firaz-home:person:owner"],
  tasks: [{ threadId: "thread-remote-2", title: "second" }], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [],
};
const relayedBots = remoteGroup.memberBots.map(bot => ({ ...bot, avatarUrl: bot.avatarUrl && bot.avatarUrl.replace("/api/attachments/", "/api/groups/room-remote/avatars/") }));
const collidingGroup = { ...remoteGroup, id: "room-local", threadId: "thread-colliding", tasks: [] };

let canonical: Server;
let local: Server;
let canonicalUrl = "";
let localUrl = "";
let folder = "";
let seen: Array<{ method: string; url: string; authorization?: string; cookie?: string; body: string }> = [];
let groupsStatus = 200;
let owner = true;

const read = (req: IncomingMessage) => new Promise<string>(resolve => {
  let data = ""; req.on("data", chunk => { data += chunk; }); req.on("end", () => resolve(data));
});
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };

beforeEach(async () => {
  seen = []; groupsStatus = 200; owner = true;
  folder = mkdtempSync(join(tmpdir(), "remote-rooms-test-"));
  // A stand-in for the canonical home's membership-checked peer routes.
  canonical = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, cookie: req.headers.cookie, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "no" });
    if (req.url === "/api/bots?messages=0") return send(res, 200, { bots: [] });
    if (req.url === "/api/multiplayer/home") return send(res, 200, { homeId: "partner-home", name: "Partner" });
    if (req.url === "/api/groups") return groupsStatus === 200 ? send(res, 200, { groups: [remoteGroup, collidingGroup, { id: "../bad" }] }) : send(res, groupsStatus, { error: "forbidden" });
    if (req.url === "/api/groups/room-remote") return send(res, 200, { group: remoteGroup });
    if (req.url === "/api/groups/room-remote/messages" && req.method === "POST") {
      return send(res, 201, { message: { id: "m1", text: JSON.parse(body).text, sender: { id: "firaz-home:person:owner", name: "Firaz" } } });
    }
    if (req.url === "/api/attachments/claude.png" || req.url === "/api/attachments/secret.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.from("png-bytes")); }
    if (req.url?.startsWith("/api/threads/thread-remote-2/messages")) return send(res, 200, { messages: [{ id: "old" }], hasMore: false });
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      res.write(`data: ${JSON.stringify({ kind: "message", groupId: "room-remote" })}\n\n`);
      return;
    }
    return send(res, 404, { error: "unknown" });
  });
  canonicalUrl = await listen(canonical);
});

afterEach(async () => {
  canonical.closeAllConnections(); local?.closeAllConnections();
  await new Promise(resolve => canonical.close(resolve));
  if (local?.listening) await new Promise(resolve => local.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

const fetcher: typeof fetch = (input, init) => {
  const target = new URL(String(input));
  expect(target.origin).toBe(ORIGIN);
  return fetch(new URL(target.pathname + target.search, canonicalUrl), init);
};
const linked = async () => {
  const links = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", fetcher);
  await links.addVerified(ORIGIN, TOKEN, { environmentId: "partner-home", label: "Partner's Mac", multiplayerProtocol: 1 });
  return links;
};

it("records joined rooms from the canonical home and lists them with their home", async () => {
  const links = await linked();
  expect(links.joinedGroupHomes().size).toBe(0);
  expect(await links.refreshJoinedGroups("partner-home")).toBe(true);
  expect([...links.joinedGroupHomes()]).toEqual([["room-remote", "partner-home"], ["room-local", "partner-home"]]);
  expect(links.joinedThreadHome("thread-remote-2")).toBe("partner-home");
  expect(links.joinedThreadHome("thread-elsewhere")).toBeNull();
  const saved = JSON.parse(readFileSync(join(folder, "links.json"), "utf8"));
  expect(saved.links[0].joinedGroups).toEqual([
    { id: "room-remote", name: "Launch room", threadIds: ["thread-remote", "thread-remote-2"], memberIds: remoteGroup.memberIds, memberBots: remoteGroup.memberBots, avatarUrl: remoteGroup.avatarUrl },
    { id: "room-local", name: "Launch room", threadIds: ["thread-colliding"], memberIds: remoteGroup.memberIds, memberBots: remoteGroup.memberBots, avatarUrl: remoteGroup.avatarUrl },
  ]);
  expect(await links.remoteGroups()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "room-remote", peopleIds: remoteGroup.peopleIds, home: { id: "partner-home", name: "Partner", available: true } }),
  ]));

  expect(JSON.stringify(saved)).not.toContain('"messages"');
  // After a restart with the home offline, the joined rooms keep display metadata.
  const restarted = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", () => Promise.reject(new Error("offline")));
  expect(await restarted.remoteGroups(500)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "room-remote", threadId: "thread-remote", name: "Launch room", memberIds: remoteGroup.memberIds, avatarUrl: "/api/groups/room-remote/avatars/room.png", home: { id: "partner-home", name: "Partner", available: false } }),
  ]));
});

it("keeps the previous record when a home without room people refuses the list", async () => {
  groupsStatus = 403;
  const links = await linked();
  expect(await links.refreshJoinedGroups("partner-home")).toBe(false);
  expect(await links.remoteGroups()).toEqual([]);
});

it("relays only allowlisted room routes with the link token", async () => {
  const links = await linked();
  expect(await links.forwardGroup("partner-home", "/api/groups/room-remote", "GET")).toMatchObject({ status: 200, body: { group: { id: "room-remote" } } });
  for (const [method, path] of [
    ["PATCH", "/api/groups/room-remote"], ["DELETE", "/api/groups/room-remote"], ["POST", "/api/groups/room-remote/read"],
    ["POST", "/api/groups/room-remote/interrupt"], ["GET", "/api/bots"], ["GET", "/api/multiplayer/me"], ["POST", "/api/groups"],
    ["DELETE", "/api/groups/room-remote/people/.."], ["GET", "/api/threads/t/messages/../../auth/sessions"], ["POST", "/api/threads/t/messages"],
  ]) await expect(links.forwardGroup("partner-home", path, method, method === "GET" || method === "DELETE" ? undefined : {})).rejects.toThrow("invalid joined room route");
  expect(seen.every(request => request.authorization === `Bearer ${TOKEN}` && !request.cookie)).toBe(true);
  expect(seen.some(request => request.url.includes("auth") || request.method === "PATCH")).toBe(false);
});

it("serves joined rooms beside local rooms and relays their routes for the owner only", async () => {
  const links = await linked();
  await links.refreshJoinedGroups("partner-home");
  const ctx: RemoteRoomContext = {
    links, isLocalGroup: id => id === "room-local", isLocalThread: id => id === "thread-local",
    localGroups: () => [{ id: "room-local", name: "Mine" } as { id: string }],
    readBody: async req => JSON.parse(await read(req) || "{}"),
    json: send, stillOwner: () => owner, waitMs: 1_000,
  };
  local = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    if (await handleRemoteRoom(req, res, { method: req.method!, path: url.pathname, search: url.search, owner }, ctx)) return;
    req.resume();
    send(res, 418, { local: true });
  });
  localUrl = await listen(local);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(localUrl + path, { method, headers: { cookie: "omb_session=owner-secret", authorization: "Bearer omb_sess_localowner" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };

  const list = await call("GET", "/api/groups");
  expect(list.status).toBe(200);
  expect(list.body.groups.map((group: any) => [group.id, group.home?.id ?? null])).toEqual([["room-local", null], ["room-remote", "partner-home"]]);
  expect(await call("GET", "/api/groups/room-remote")).toMatchObject({ status: 200, body: { group: { id: "room-remote", home: { id: "partner-home", name: "Partner" } } } });
  expect(await call("POST", "/api/groups/room-remote/messages", { text: "hello partner", sendId: "send-0000000000000001" }))
    .toMatchObject({ status: 201, body: { message: { text: "hello partner", sender: { name: "Firaz" } } } });
  expect(JSON.parse(seen.find(request => request.url === "/api/groups/room-remote/messages")!.body)).toEqual({ text: "hello partner", sendId: "send-0000000000000001" });
  expect(await call("GET", "/api/threads/thread-remote-2/messages?before=m9&limit=20")).toMatchObject({ status: 200, body: { messages: [{ id: "old" }] } });
  expect(seen.some(request => request.url === "/api/threads/thread-remote-2/messages?before=m9&limit=20")).toBe(true);
  expect(await call("POST", "/api/groups/room-remote/read", {})).toMatchObject({ status: 403 });
  expect(await call("PATCH", "/api/groups/room-remote", { name: "x" })).toMatchObject({ status: 403 });
  // Local rooms, local threads and unknown rooms keep their local handlers.
  expect(await call("GET", "/api/groups/room-local")).toMatchObject({ status: 418 });
  expect(await call("POST", "/api/groups/room-local/messages", { text: "mine" })).toMatchObject({ status: 418 });
  expect(await call("GET", "/api/threads/thread-local/messages")).toMatchObject({ status: 418 });
  expect(await call("GET", "/api/groups/room-unknown")).toMatchObject({ status: 418 });
  expect(seen.some(request => request.url.includes("room-local") || request.url.includes("thread-local"))).toBe(false);
  // Local credentials never cross the link.
  expect(seen.every(request => request.authorization === `Bearer ${TOKEN}` && !request.cookie)).toBe(true);

  const events = await fetch(`${localUrl}/api/groups/room-remote/events`);
  expect(events.headers.get("content-type")).toContain("text/event-stream");
  const reader = events.body!.getReader();
  let text = "";
  while (!text.includes("room-remote")) text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain(`"kind":"hello"`);
  await reader.cancel();

  owner = false;
  expect(await call("GET", "/api/groups/room-remote")).toMatchObject({ status: 418 });
  expect(await call("GET", "/api/groups")).toMatchObject({ status: 418 });
});

it("clears cached bot records when the canonical room changes membership", async () => {
  const links = await linked();
  await links.refreshJoinedGroups("partner-home");
  const answer = await links.remoteGroups();
  expect(answer.find(group => group.id === "room-remote")?.memberBots).toEqual(relayedBots);
  // A successful empty list is authoritative, even after restarting offline.
  canonical.removeAllListeners("request");
  canonical.on("request", (req, res) => { req.resume(); send(res, 200, { groups: [] }); });
  expect(await links.remoteGroups()).toEqual([]);
  const restarted = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", () => Promise.reject(new Error("offline")));
  expect(await restarted.remoteGroups()).toEqual([]);
});

it("persists only room bot display fields, never private bot settings", async () => {
  const scopedFetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/api/groups") return fetcher(input, init);
    return Response.json({ groups: [{ ...remoteGroup, memberBots: [
      { ...remoteGroup.memberBots[0], soul: "PRIVATE_SENTINEL", messages: [{ text: "PRIVATE_SENTINEL" }], cwd: "/private/project" },
      remoteGroup.memberBots[1],
      { id: "not-a-room-member", name: "Other bot", title: "helper" },
    ] }] });
  };
  const links = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", scopedFetcher);
  await links.addVerified(ORIGIN, TOKEN, { environmentId: "partner-home", multiplayerProtocol: 1 });
  await links.refreshJoinedGroups("partner-home");
  const saved = readFileSync(join(folder, "links.json"), "utf8");
  expect(saved).not.toContain("PRIVATE_SENTINEL");
  expect(saved).not.toContain("/private/project");
  expect(saved).not.toContain("not-a-room-member");
  const offline = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", () => Promise.reject(new Error("offline")));
  expect((await offline.remoteGroups())[0].memberBots).toEqual(relayedBots);
});

it("relays a joined room's own avatars from its home and nothing else", async () => {
  const links = await linked();
  await links.refreshJoinedGroups("partner-home");
  const [room] = (await links.remoteGroups()).filter(group => group.id === "room-remote");
  expect(room.avatarUrl).toBe("/api/groups/room-remote/avatars/room.png");
  expect((room.memberBots as Array<{ avatarUrl: string | null }>).map(bot => bot.avatarUrl)).toEqual([null, "/api/groups/room-remote/avatars/claude.png"]);
  const image = await links.groupAvatar("partner-home", "room-remote", "claude.png");
  expect(image?.mime).toBe("image/png");
  expect(image?.bytes.toString()).toBe("png-bytes");
  expect(seen.find(request => request.url === "/api/attachments/claude.png")?.authorization).toBe(`Bearer ${TOKEN}`);
  // Names the room does not list, unknown rooms and path tricks are never fetched.
  seen = [];
  expect(await links.groupAvatar("partner-home", "room-remote", "secret.png")).toBeNull();
  expect(await links.groupAvatar("partner-home", "room-other", "claude.png")).toBeNull();
  expect(await links.groupAvatar("partner-home", "room-remote", "../claude.png")).toBeNull();
  expect(seen).toEqual([]);
});

it("keeps a bot this home shared into a joined room on its own photo", async () => {
  const links = new MultiplayerLinks(join(folder, "own-avatar-links.json"), "mac-home");
  const view = { ...remoteGroup, memberBots: [...remoteGroup.memberBots,
    { id: "rb-ea1d2ab01102-bos-local", name: "bos", avatarUrl: "/api/attachments/bos.png" },
    { id: "rb-ea1d2ab01102-stale-local", name: "old", avatarUrl: "/api/attachments/old.png" }] };
  const { relayAvatars } = await import("./multiplayer-links.ts");
  links.ownBotAvatar = id => ({ "bos-local": "/api/attachments/bos.png", "stale-local": "/api/attachments/new.png" } as Record<string, string>)[id];
  const relayed = relayAvatars(view, "room-remote", links.ownBotAvatar);
  expect((relayed.memberBots as Array<{ avatarUrl: string | null }>).map(bot => bot.avatarUrl)).toEqual([
    null, "/api/groups/room-remote/avatars/claude.png", "/api/attachments/bos.png", "/api/groups/room-remote/avatars/old.png",
  ]);
  expect(relayAvatars(view, "room-remote").memberBots).toEqual(expect.arrayContaining([expect.objectContaining({ avatarUrl: "/api/groups/room-remote/avatars/bos.png" })]));
});
