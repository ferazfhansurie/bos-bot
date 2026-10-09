import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { FILE_MAX_BYTES } from "./attachments.ts";
import { uploadRemoteRoomAttachments } from "./remote-room-attachments.ts";
import { relayAvatars, remoteGroupRouteAllowed, type MultiplayerLinks, type OwnBotAvatar, type RemoteGroupView } from "./multiplayer-links.ts";

/** A guest home shows rooms it joined on a canonical home next to its own
 * rooms and relays their reads, sends and events over the existing link.
 * Local rooms always win: an id or thread this home owns is never relayed. */
export interface RemoteRoomContext {
  links: Pick<MultiplayerLinks, "joinedGroupHomes" | "joinedThreadHome" | "homeLabel" | "remoteGroups" | "forwardGroup" | "openGroupEvents" | "groupAvatar" | "uploadGroupAttachment" | "groupMessageFile">;
  isLocalGroup(id: string): boolean;
  isLocalThread(id: string): boolean;
  localGroups(): Array<{ id: string }>;
  readBody(req: IncomingMessage, limit: number): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Rechecked after every remote await: the local owner session is live. */
  stillOwner(): boolean;
  waitMs?: number;
  ownBotAvatar?: OwnBotAvatar;
}

export async function withRemoteGroups<T extends { id: string }>(groups: T[], ctx: Pick<RemoteRoomContext, "links" | "waitMs">): Promise<Array<T | RemoteGroupView>> {
  const local = new Set(groups.map(group => group.id));
  const homes = ctx.links.joinedGroupHomes();
  const remote = (await ctx.links.remoteGroups(ctx.waitMs)).filter(group => !local.has(group.id) && homes.get(group.id) === group.home.id);
  return [...groups, ...remote];
}

/** Handles owner requests for joined remote rooms; false lets the request
 * continue to the ordinary local handlers unchanged. */
export async function handleRemoteRoom(
  req: IncomingMessage, res: ServerResponse,
  request: { method: string; path: string; search: string; owner: boolean },
  ctx: RemoteRoomContext,
): Promise<boolean> {
  const { method, path, search, owner } = request;
  if (!owner) return false;
  if (method === "GET" && path === "/api/groups") {
    const groups = await withRemoteGroups(ctx.localGroups(), ctx);
    if (!ctx.stillOwner()) { ctx.json(res, 403, { error: "owner session ended" }); return true; }
    ctx.json(res, 200, { groups });
    return true;
  }
  const groupId = /^\/api\/groups\/([\w-]+)(?:\/|$)/.exec(path)?.[1];
  const threadId = /^\/api\/threads\/([\w-]+)\/messages(?:\/[\w-]+\/file)?$/.exec(path)?.[1];
  let homeId: string | null | undefined;
  if (groupId) homeId = ctx.isLocalGroup(groupId) ? null : ctx.links.joinedGroupHomes().get(groupId);
  else if (threadId) homeId = ctx.isLocalThread(threadId) ? null : ctx.links.joinedThreadHome(threadId);
  if (!homeId) return false;

  if (method === "GET" && path === `/api/groups/${groupId}/events`) {
    await relayEvents(req, res, homeId, ctx);
    return true;
  }
  const avatar = method === "GET" && /^\/api\/groups\/[\w-]+\/avatars\/([\w.-]+)$/.exec(path)?.[1];
  if (avatar) {
    req.resume();
    const image = await ctx.links.groupAvatar(homeId, groupId!, avatar).catch(() => null);
    if (!ctx.stillOwner()) { ctx.json(res, 403, { error: "owner session ended" }); return true; }
    if (!image) { ctx.json(res, 404, { error: "no such avatar" }); return true; }
    res.writeHead(200, { "content-type": image.mime, "content-length": String(image.bytes.byteLength), "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    res.end(image.bytes);
    return true;
  }
  const route = path + search;
  if (!remoteGroupRouteAllowed(method, route)) {
    req.resume();
    ctx.json(res, 403, { error: "this action is not available in a room on another home" });
    return true;
  }
  try {
    let body = method === "POST" ? await ctx.readBody(req, 100_000) : undefined;
    if (method !== "POST") req.resume();
    const check = () => { if (!ctx.stillOwner()) throw Object.assign(new Error("owner session ended"), { status: 403 }); };
    if (method === "POST" && path === `/api/groups/${groupId}/messages` && body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string") {
      const text = (body as { text: string }).text;
      if (text.length > 20_000) throw Object.assign(new Error("a chat message of at most 20000 characters is required"), { status: 400 });
      body = { ...body, text: await uploadRemoteRoomAttachments(ctx.links, homeId, groupId!, text, check) };
    }
    check();
    if (threadId && path.endsWith("/file")) {
      const upstream = await ctx.links.groupMessageFile(homeId, route, method, body);
      check();
      if (!upstream.ok) { ctx.json(res, upstream.status, await upstream.json()); return true; }
      // Bound even a host/proxy response without Content-Length.
      const reader = upstream.body?.getReader();
      if (!reader) throw new Error("empty file response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          check();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > FILE_MAX_BYTES) throw Object.assign(new Error("attachment exceeds 25 MB"), { status: 413 });
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const headers: Record<string, string> = { "content-length": String(size), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
      for (const key of ["content-type", "content-disposition"]) { const value = upstream.headers.get(key); if (value) headers[key] = value; }
      res.writeHead(200, headers);
      res.end(Buffer.concat(chunks));
      return true;
    }
    const forwarded = await ctx.links.forwardGroup(homeId, route, method, body);
    if (!ctx.stillOwner()) { ctx.json(res, 403, { error: "owner session ended" }); return true; }
    let answer = forwarded.body;
    const group = (answer as { group?: unknown } | null)?.group;
    if (forwarded.status < 300 && group && typeof group === "object" && !Array.isArray(group)) {
      answer = { ...(answer as object), group: { ...relayAvatars(group as Record<string, unknown>, groupId!, ctx.ownBotAvatar), home: { id: homeId, name: ctx.links.homeLabel(homeId), available: true } } };
    }
    ctx.json(res, forwarded.status, answer);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) ctx.json(res, status, { error: (error as Error).message });
    else ctx.json(res, 502, { error: "the room's home is unavailable" });
  }
  return true;
}

async function relayEvents(req: IncomingMessage, res: ServerResponse, homeId: string, ctx: RemoteRoomContext): Promise<void> {
  req.resume();
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream: Response;
  try { upstream = await ctx.links.openGroupEvents(homeId, abort.signal); }
  catch { if (!res.headersSent && !abort.signal.aborted) ctx.json(res, 502, { error: "the room's home is unavailable" }); return; }
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
    abort.abort();
    ctx.json(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, { error: "the room's home refused its event stream" });
    return;
  }
  if (!ctx.stillOwner()) { abort.abort(); ctx.json(res, 403, { error: "owner session ended" }); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  req.socket.setTimeout(0);
  const check = setInterval(() => { if (!ctx.stillOwner()) abort.abort(); }, 15_000);
  check.unref?.();
  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  const finish = () => { clearInterval(check); res.end(); };
  stream.on("error", finish).on("end", finish);
  abort.signal.addEventListener("abort", () => { stream.destroy(); finish(); });
  stream.pipe(res, { end: false });
}
