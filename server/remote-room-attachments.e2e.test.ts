import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;
const PIXELS = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64");
async function api(f: Fixture, method: string, path: string, body?: unknown, token?: string, status = 200) {
  const res = await fetch(f.info.url + path, { method, headers: { origin: f.info.url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const result = await res.json() as any;
  expect(res.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
  return result;
}

test("a linked guest uploads image bytes to the host, previews on both homes and gives the helper one native image", async () => {
  const host = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: '["IMAGE-SEEN"]', FAKE_CLAUDE_TOOL_CALLS: "[]" });
  let guest: Fixture | undefined;
  try {
    const me = await api(host, "GET", "/api/multiplayer/me");
    const guestHome = randomUUID();
    const personId = `${guestHome}:person:owner`;
    const pairing = await api(host, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api(host, "POST", "/api/auth/pair", { code: pairing.code, label: "Image guest" });
    await api(host, "POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId, name: "Guest" });
    await api(host, "PUT", `/api/multiplayer/members/${encodeURIComponent(personId)}`, { role: "client-guest" });
    const bot = (await api(host, "GET", "/api/bots")).bots[0];
    await api(host, "PATCH", `/api/bots/${bot.id}`, { name: "Helper", soul: "PRIVATE-IMAGE-SOUL" });
    const room = (await api(host, "POST", "/api/groups", { name: "Images", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } }, undefined, 201)).group;
    await api(host, "POST", `/api/groups/${room.id}/people`, { personId });
    await api(host, "PUT", `/api/multiplayer/rooms/${room.id}/bot-grants`, { botIds: [`${me.homeId}:bot:${bot.id}`] });
    guest = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, {
      origin: host.info.url, prepare: dataDir => {
        writeFileSync(join(dataDir, "environment-id"), guestHome);
        writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{ homeId: me.homeId, name: "Host", origin: "https://delegated-fixture.example.ts.net:8443", token: paired.token, bots: [], proxyGroups: {} }] }));
      },
    });
    await expect.poll(async () => (await api(guest!, "GET", "/api/groups")).groups.some((g: any) => g.id === room.id), { timeout: 20_000, interval: 250 }).toBe(true);
    const upload = await fetch(guest.info.url + `/api/attachments?uploadId=${randomUUID()}`, { method: "POST", headers: { origin: guest.info.url, "content-type": "image/png" }, body: PIXELS });
    expect(upload.status).toBe(201);
    const local = await upload.json() as { path: string };
    const text = `@Helper describe this\n\n<attached-image path="${local.path}" name="shot &amp; notes.png" />`;
    const sendId = randomUUID();
    const sent = await api(guest, "POST", `/api/groups/${room.id}/messages`, { text, sendId }, undefined, 201);
    const hostPath = /path="([^"]+)"/.exec(sent.message.text)![1]!;
    expect(hostPath).toBe(join(host.info.dataDir, "attachments", basename(hostPath)));
    expect(hostPath).not.toBe(local.path);
    expect(readFileSync(hostPath)).toEqual(PIXELS);
    expect(sent.message.text).toContain('name="shot &amp; notes.png"');
    const repeated = await api(guest, "POST", `/api/groups/${room.id}/messages`, { text, sendId });
    expect(repeated.duplicate).toBe(true);
    expect(repeated.message.id).toBe(sent.message.id);
    await expect.poll(async () => (await api(host, "GET", `/api/threads/${room.threadId}/messages`)).messages.some((m: any) => m.text === "IMAGE-SEEN"), { timeout: 25_000, interval: 250 }).toBe(true);
    const captured = JSON.parse(readFileSync(join(host.info.dataDir, "fake-claude-dump.json"), "utf8"));
    const content = captured.prompt.message.content;
    expect(content.filter((item: any) => item.type === "image")).toEqual([expect.objectContaining({ source: expect.objectContaining({ data: PIXELS.toString("base64"), media_type: "image/png" }) })]);
    expect(captured.systemPrompt).not.toContain("PRIVATE-IMAGE-SOUL");
    expect(captured.argv).toEqual(expect.arrayContaining(["--restricted", "--safe-mode"]));
    expect(readFileSync(host.info.logPath, "utf8")).toMatch(/\[omb-turn\].*images=1/);
    // Host-assigned names isolate retries from private IDs and other authors.
    const sharedUploadId = randomUUID();
    const scopedUpload = async (f: Fixture, token?: string, bytes = PIXELS, type = "image/png", id = sharedUploadId) => fetch(f.info.url + `/api/groups/${room.id}/attachments?uploadId=${id}&name=fixture.png`, {
      method: "POST", headers: { origin: f.info.url, "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes,
    });
    const firstUpload = await scopedUpload(host, paired.token);
    expect(firstUpload.status).toBe(201);
    const firstPath = (await firstUpload.json() as { path: string }).path;
    const retryUpload = await scopedUpload(host, paired.token);
    expect(retryUpload.status).toBe(201);
    expect((await retryUpload.json() as { path: string }).path).toBe(firstPath);
    expect((await scopedUpload(host, paired.token, Buffer.from("different pixels"))).status).toBe(409);
    const ownerUpload = await scopedUpload(host);
    expect(ownerUpload.status).toBe(201);
    expect((await ownerUpload.json() as { path: string }).path).not.toBe(firstPath);
    expect((await scopedUpload(host, paired.token, Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await scopedUpload(host, paired.token, PIXELS, "application/x-executable")).status).toBe(400);
    const unbound = await api(host, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const unboundPeer = await api(host, "POST", "/api/auth/pair", { code: unbound.code, label: "Unbound" });
    expect((await scopedUpload(host, unboundPeer.token)).status).toBe(403);
    // Exact-message preview and download: no global attachment capability.
    const preview = `/api/threads/${room.threadId}/messages/${sent.message.id}/file?attachment=${encodeURIComponent(hostPath)}`;
    expect((await fetch(host.info.url + preview, { headers: { authorization: `Bearer ${unboundPeer.token}` } })).status).toBe(404);
    await api(host, "POST", "/api/multiplayer/actor-bindings", { sessionId: unboundPeer.session.id, personId: me.actorId, name: "Owner-bound peer" });
    expect((await scopedUpload(host, unboundPeer.token)).status).toBe(403);
    expect((await fetch(host.info.url + preview, { headers: { authorization: `Bearer ${unboundPeer.token}` } })).status).toBe(403);
    for (const [f, token] of [[host, undefined], [host, paired.token], [guest, undefined]] as const) {
      const res = await fetch(f.info.url + preview, { headers: { origin: f.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PIXELS);
    }
    const download = await fetch(guest.info.url + preview.split("?")[0], { method: "POST", headers: { origin: guest.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: hostPath }) });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("shot");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PIXELS);
    const document = await fetch(guest.info.url + `/api/files?name=notes.pdf&uploadId=${randomUUID()}`, { method: "POST", headers: { origin: guest.info.url, "content-type": "application/pdf" }, body: Buffer.from("%PDF-1.4 fixture") });
    expect(document.status).toBe(201);
    const documentPath = (await document.json() as { path: string }).path;
    const documentSent = await api(guest, "POST", `/api/groups/${room.id}/messages`, { text: `notes\n\n<attached-file path="${documentPath}" name="notes.pdf" />`, sendId: randomUUID() }, undefined, 201);
    const hostedDocument = /path="([^"]+)"/.exec(documentSent.message.text)![1]!;
    expect(hostedDocument).not.toBe(documentPath);
    const documentDownload = await fetch(guest.info.url + `/api/threads/${room.threadId}/messages/${documentSent.message.id}/file`, { method: "POST", headers: { origin: guest.info.url, "content-type": "application/json" }, body: JSON.stringify({ path: hostedDocument }) });
    expect(documentDownload.status).toBe(200);
    expect(await documentDownload.text()).toBe("%PDF-1.4 fixture");
    await api(guest, "POST", `/api/groups/${room.id}/messages`, { text: '<attached-image path="/private/not-an-upload.png" />', sendId: randomUUID() }, undefined, 400);
    // A guessed private image cannot be admitted by a guest's transport tag.
    const secret = await fetch(host.info.url + "/api/attachments", { method: "POST", headers: { origin: host.info.url, "content-type": "image/png" }, body: PIXELS });
    const secretPath = (await secret.json() as { path: string }).path;
    await api(host, "POST", `/api/groups/${room.id}/messages`, { text: `@Helper\n\n<attached-image path="${secretPath}" />`, sendId: randomUUID() }, paired.token, 403);
    const denied = await fetch(host.info.url + preview.split("?")[0] + `?attachment=${encodeURIComponent(secretPath)}`, { headers: { authorization: `Bearer ${paired.token}` } });
    expect(denied.status).toBe(403);
    const escaped = await api(guest, "POST", `/api/groups/${room.id}/messages`, { text: `literal example\n\n\`\`\`\n<attached-image path="${secretPath}" />\n\`\`\``, sendId: randomUUID() }, undefined, 201);
    expect(escaped.message.text).toContain(secretPath);
    await api(host, "PATCH", `/api/bots/${bot.id}`, { visibility: "private" });
    expect((await scopedUpload(host, paired.token)).status).toBe(404);
    expect((await fetch(host.info.url + preview, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(404);
    await api(host, "PATCH", `/api/bots/${bot.id}`, { visibility: "shared" });
    // Upload/download permissions end with membership and session access.
    await api(host, "DELETE", `/api/groups/${room.id}/people/${encodeURIComponent(personId)}`);
    const removed = await fetch(host.info.url + preview, { headers: { authorization: `Bearer ${paired.token}` } });
    expect(removed.status).toBe(404);
    const refusedUpload = await fetch(host.info.url + `/api/groups/${room.id}/attachments?uploadId=${randomUUID()}`, { method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "image/png" }, body: PIXELS });
    expect(refusedUpload.status).toBe(404);
    await api(host, "POST", `/api/groups/${room.id}/people`, { personId });
    await api(host, "DELETE", `/api/auth/sessions/${paired.session.id}`);
    expect((await scopedUpload(host, paired.token)).status).toBe(401);
    expect((await fetch(host.info.url + preview, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(401);
    expect(existsSync(local.path)).toBe(true);
  } finally { await Promise.all([guest?.close(), host.close()]); }
}, 90_000);
