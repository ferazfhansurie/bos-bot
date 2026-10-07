import {runtimeRoute} from './runtime-http.ts';
import * as Sentry from '@sentry/node';
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { CloudService } from "./service.ts";
import { CloudError } from "./identity.ts";
import {
  SubscribeSchema,
  LIMITS,
  IdSchema,
} from "../../shared/cloud-protocol/index.ts";
const bytesLimit = 524288;
export async function body(req: IncomingMessage) {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > bytesLimit) throw new CloudError("invalid_request", 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw new CloudError("invalid_request", 400);
  }
}
function bearer(req: IncomingMessage) {
  const v = req.headers.authorization;
  if (v !== undefined) {
    if (!/^Bearer [^\s\0]+$/.test(v) || v.length>4096) throw new CloudError("session_invalid",401);
    return v.slice(7);
  }
  const cookie = req.headers.cookie;
  if (cookie && cookie.length<=8192) return "cookie\0"+cookie;
  throw new CloudError("session_invalid",401);
}
function error(e: unknown) {
  if (e instanceof z.ZodError)
    return { status: 400, value: { error: "invalid_request" } };
  if (e instanceof CloudError)
    return {
      status: e.status,
      value: {
        error: e.code,
        ...(["rate_limited", "identity_unavailable"].includes(e.code) ? { retry_after: 1 } : {}),
      },
    };
  if (["57014", "55P03"].includes((e as any)?.code))
    return { status: 503, value: { error: "deadline_exceeded" } };
  Sentry.captureException(e);
  return { status: 503, value: { error: "unavailable" } };
}
type Subscription = {
  workspace_id: string;
  room_id: string;
  thread_id: string;
  cursor: string | null;
  snapshot_id?: string;
};
export async function startCloud(
  service: CloudService,
  port = 0,
  host = "127.0.0.1",
  fixtureRoute?: (req: IncomingMessage,res: ServerResponse,path: string[],write: (res: ServerResponse,value:unknown,status?:number)=>void) => Promise<boolean>,
  automaticWorker = true,
  allowedOrigins: ReadonlySet<string> = new Set([service.service]),
  options: { selfHost?: boolean } = {},
) {
  if (host !== "127.0.0.1" && !options.selfHost) throw new Error("local slices only: loopback service");
  await service.db.assertRole();
  const rates = new Map<string, { until: number; n: number }>();
  let active = 0;
  const write = (res: ServerResponse, value: unknown, status = 200) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    active++;
    const deadline = setTimeout(() => {
      if (!res.writableEnded) {
        write(res, { error: "deadline_exceeded" }, 503);
        req.destroy();
      }
    }, LIMITS.requestMs);
    try {
      if (active > 128) throw new CloudError("rate_limited", 429);
      const origin = req.headers.origin;
      if (origin) {
        if (!URL.canParse(origin) || !allowedOrigins.has(origin)) throw new CloudError("forbidden");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,X-Cloud-Fixture-Secret,X-Cloud-Host-Credential,Range",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,DELETE,OPTIONS",
        );
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", service.service);
      const path = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const method = req.method ?? "GET";
      if (path.join("/") === "v2/health" && method === "GET") {
        write(res, { slice: fixtureRoute ? 1 : 2, fixture: !!fixtureRoute });
        return;
      }
      if (path[0] !== "v2") throw new CloudError("not_found", 404);
      if (fixtureRoute && await fixtureRoute(req,res,path,write)) return;
      if (path[1] === "test") throw new CloudError("not_found",404);
      if (req.headers.cookie && !req.headers.authorization && !["GET","HEAD"].includes(method) && !allowedOrigins.has(req.headers.origin ?? ""))
        throw new CloudError("forbidden");
      const token = bearer(req);
      const rateKey = token;
      const now = Date.now();
      const r = rates.get(rateKey);
      if (r && r.until > now) {
        if (++r.n > 2000) throw new CloudError("rate_limited", 429);
      } else {
        rates.set(rateKey, { until: now + 1000, n: 1 });
        if (rates.size > 2048)
          for (const [k, v] of rates) if (v.until < now) rates.delete(k);
      }
      if(await runtimeRoute(service,req,res,path,url,token,body,write))return;
      let value: any, scope: string | undefined, room: string | undefined;
      if (path.join("/") === "v2/me" && method === "GET") {
        const i = await service.identify(token);
        value = i;
      } else if (path.join("/") === "v2/discovery/sync" && method === "GET") {
        value = await service.discovery(token, (v) => write(res, v));
        return;
      } else if (path.join("/") === "v2/workspaces" && method === "POST") {
        value = await service.createWorkspace(token, await body(req));
        scope = value.workspace_id;
      } else if (
        path[1] === "invites" &&
        path.length === 3 &&
        method === "POST"
      ) {
        if (!["preview", "redeem"].includes(path[2]))
          throw new CloudError("not_found", 404);
        value = await service.inviteAction(
          token,
          await body(req),
          path[2] === "redeem",
          path[2] === "preview" ? (v) => write(res, v) : undefined,
        );
        if (path[2] === "redeem") scope = value.workspace_id;
        else return;
      } else if (path[1] === "workspaces" && path[2]) {
        const w = path[2];
        IdSchema.parse(w);
        scope = w;
        if (path[3] === "rooms" && path.length === 4 && method === "POST") {
          value = await service.createRoom(token, w, await body(req));
          room = value.room_id;
        } else if (
          path[3] === "invites" &&
          path.length === 4 &&
          method === "POST"
        )
          {
            await service.invite(token,w,await body(req), (v) => new Promise<void>((resolve,reject) => {
              if (res.destroyed || res.writableEnded) return reject(new CloudError("unavailable",503));
              const cleanup = () => {
                res.off("finish",finish);res.off("close",close);res.off("error",fail);
              };
              const finish = () => {cleanup();resolve();};
              const fail = () => {cleanup();reject(new CloudError("unavailable",503));};
              const close = () => {if(res.writableFinished) finish(); else fail();};
              res.once("finish",finish);res.once("close",close);res.once("error",fail);
              try {write(res,v);} catch {fail();}
            }));
            return;
          }
        else if (
          path[3] === "invites" &&
          path.length === 5 &&
          method === "DELETE"
        )
          value = await service.revokeInvite(token, w, path[4]);
        else if (
          path[3] === "members" &&
          path.length === 5 &&
          method === "DELETE"
        )
          value = await service.removeMember(token, w, path[4]);
        else if (
          path[3] === "operation-windows" &&
          path.length === 4 &&
          method === "POST"
        ) {
          z.object({})
            .strict()
            .parse(await body(req));
          value = await service.window(token, w);
        } else if (
          path[3] === "messages" &&
          path.length === 4 &&
          method === "POST"
        ) {
          const b = await body(req);
          value = await service.operation(token, w, b);
          room = b.room_id;
        } else if (path[3] === "operations") {
          if (path.length === 4 && method === "GET")
            value = await service.operations(
              token,
              w,
              url.searchParams.get("cursor") ?? undefined,
            );
          else if (path.length === 5 && method === "GET") {
            value = await service.lookup(token, w, path[4]);
            room = value.room_id;
          } else if (
            path.length === 6 &&
            path[5] === "resolve-not-accepted" &&
            method === "POST"
          ) {
            const b = await body(req);
            if (b.client_operation_id !== path[4])
              throw new CloudError("operation_conflict", 409);
            value = await service.operation(token, w, b, true);
            room = b.room_id;
          } else throw new CloudError("not_found", 404);
        } else if (path[3] === "rooms" && path[4]) {
          room = path[4];
          if (path[5] === "snapshot" && path.length === 6 && method === "POST")
            value = await service.snapshot(token, w, room, await body(req));
          else if (
            path[5] === "snapshots" &&
            path.length === 7 &&
            method === "GET"
          )
            value = await service.snapshotPage(token, w, room, path[6]);
          else if (
            path[5] === "replay" &&
            path.length === 6 &&
            method === "POST"
          )
            value = await service.replay(token, w, room, await body(req));
          else if (
            path[5] === "history" &&
            path.length === 6 &&
            method === "GET"
          )
            value = await service.history(
              token,
              w,
              room,
              url.searchParams.get("thread_id") ?? "",
              url.searchParams.get("before") ?? "9223372036854775807",
              Number(url.searchParams.get("limit") ?? 100),
            );
          else if (path[5] === "read" && path.length === 6 && method === "POST")
            value = await service.read(token, w, room, await body(req));
          else throw new CloudError("not_found", 404);
        } else throw new CloudError("not_found", 404);
      } else throw new CloudError("not_found", 404);
      if (scope)
        await service.publishHttp(token, scope, room, () => write(res, value));
      else {
        await service.identify(token);
        write(res, value);
      }
    } catch (e) {
      const info = error(e);
      write(res, info.value, info.status);
    } finally {
      clearTimeout(deadline);
      active--;
    }
  });
  server.requestTimeout = LIMITS.requestMs;
  server.headersTimeout = LIMITS.requestMs;
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 131072,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", service.service);
    const origin = req.headers.origin;
    if ((origin && !allowedOrigins.has(origin))) {socket.destroy();return;}
    if (
      u.pathname !== "/v2/realtime" ||
      u.search ||
      wsServer.clients.size >= 128
    ) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) =>
      wsServer.emit("connection", ws, req),
    );
  });
  const wakeups = new Set<() => void>();
  const listener = await service.db.pool.connect();
  await listener.query("LISTEN cloud_wakeup");
  const onNotify = () => {
    for (const wake of wakeups) wake();
  };
  listener.on("notification", onNotify);
  listener.on("error", () => {});
  const accountCounts = new Map<string, number>();
  wsServer.on("connection", (ws, req) => {
    let token = "",
      account = "",
      busy = false,
      closed = false,
      pending = 0;
    let authenticated = false;
    const subs = new Map<string, Subscription>();
    const authTimeout = setTimeout(
      () => ws.close(1008, "authenticate first"),
      3000,
    );
    const releaseSubs = () => {
      if (account) {
        accountCounts.set(
          account,
          Math.max(0, (accountCounts.get(account) ?? 0) - subs.size),
        );
      }
      subs.clear();
    };
    const send = (frame: any) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const data = JSON.stringify(frame);
      if (
        ws.bufferedAmount + Buffer.byteLength(data) > LIMITS.socketBytes ||
        pending >= LIMITS.socketFrames
      ) {
        releaseSubs();
        if (ws.bufferedAmount < 4096)
          ws.send(
            JSON.stringify({
              type: "reset_required",
              workspace_id: frame.workspace_id,
              room_id: frame.room_id,
              reason: "overflow",
            }),
          );
        ws.close(1013, "overflow: recover with snapshot");
        return false;
      }
      pending++;
      ws.send(data, () => pending--);
      return true;
    };
    const pump = async () => {
      if (busy || closed || !authenticated) return;
      busy = true;
      try {
        // Poll persisted heads regardless of worker/NOTIFY. Each actual publication holds authority lock.
        for (const sub of subs.values()) {
          const frame = await service.replay(
            token,
            sub.workspace_id,
            sub.room_id,
            {
              thread_id: sub.thread_id,
              cursor: sub.cursor,
              ...(sub.snapshot_id ? { snapshot_id: sub.snapshot_id } : {}),
            },
            send,
          );
          if (frame.type === "event_batch") {
            sub.cursor = frame.cursor!;
            if (frame.live) delete sub.snapshot_id;
          } else {
            sub.cursor = frame.snapshot!.cursor;
            sub.snapshot_id = frame.snapshot!.snapshot_id;
          }
        }
      } catch (e) {
        send({ type: "error", error: error(e).value.error });
        releaseSubs();
        ws.close(1008, "authorization unavailable");
      } finally {
        busy = false;
      }
    };
    const wake = () => {
      void pump();
    };
    wakeups.add(wake);
    const timer = setInterval(wake, 250);
    let inbound = Promise.resolve(),
      inboundBytes = 0,
      inboundFrames = 0;
    ws.on("message", (raw) => {
      const size = Array.isArray(raw)
        ? raw.reduce((n, b) => n + b.byteLength, 0)
        : raw.byteLength;
      if (
        inboundBytes + size > LIMITS.socketBytes ||
        inboundFrames >= LIMITS.socketFrames
      ) {
        ws.close(1013, "inbound overflow");
        return;
      }
      inboundBytes += size;
      inboundFrames++;
      inbound = inbound.then(async () => {
        try {
          if (closed) return;
          const v = JSON.parse(raw.toString());
          if (!authenticated) {
            const b = z
              .object({
                type: z.literal("authenticate"),
                bearer: z.string().min(1).max(4096).regex(/^[^\s\0]+$/).optional(),
              })
              .strict()
              .parse(v);
            if (!b.bearer && !allowedOrigins.has(req.headers.origin ?? "")) throw new CloudError("forbidden");
            const credential = b.bearer ?? bearer(req);
            const i = await service.identify(credential);
            if (closed) return;
            token = credential;
            account = i.account_id;
            authenticated = true;
            clearTimeout(authTimeout);
            send({ type: "heartbeat" });
            return;
          }
          const b = SubscribeSchema.parse(v);
          const key = b.workspace_id + "\0" + b.room_id;
          if (!subs.has(key)) {
            if ((accountCounts.get(account) ?? 0) >= 50)
              throw new CloudError("rate_limited", 429);
            accountCounts.set(account, (accountCounts.get(account) ?? 0) + 1);
          }
          subs.set(key, {
            workspace_id: b.workspace_id,
            room_id: b.room_id,
            thread_id: b.thread_id,
            cursor: b.cursor,
            ...(b.snapshot_id ? { snapshot_id: b.snapshot_id } : {}),
          });
          await pump();
        } catch (e) {
          send({ type: "error", error: error(e).value.error });
        } finally {
          inboundBytes -= size;
          inboundFrames--;
        }
      });
    });
    ws.on("close", () => {
      closed = true;
      wakeups.delete(wake);
      clearTimeout(authTimeout);
      clearInterval(timer);
      releaseSubs();
    });
    ws.on("error", () => {});
  });
  let workerBusy = false;
  const worker = automaticWorker
    ? setInterval(async () => {
        if (workerBusy) return;
        workerBusy = true;
        try {
          await service.tickWorker();
        } catch {
          /* Durable rows survive faults; next tick retries. */
        } finally {
          workerBusy = false;
        }
      }, 200)
    : undefined;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    wsServer,
    url: "http://127.0.0.1:" + (server.address() as any).port,
    async close() {
      clearInterval(worker);
      listener.removeListener("notification", onNotify);
      try {
        await listener.query("UNLISTEN cloud_wakeup");
      } catch {}
      listener.release(true);
      service.hooks?.close();
      for (const ws of wsServer.clients) ws.terminate();
      await new Promise<void>((r) => wsServer.close(() => r()));
      server.closeIdleConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await service.db.close();
    },
  };
}
