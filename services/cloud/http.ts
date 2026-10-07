import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { CloudService } from "./service.ts";
import { StubIssuer, CloudError } from "./identity.ts";
import {
  SubscribeSchema,
  LIMITS,
  IdSchema,
} from "../../shared/cloud-protocol/index.ts";
const bytesLimit = 524288;
async function body(req: IncomingMessage) {
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
  const v = req.headers.authorization ?? "";
  if (!v.startsWith("Bearer ") || v.length > 4096)
    throw new CloudError("unauthenticated", 401);
  return v.slice(7);
}
function error(e: unknown) {
  if (e instanceof z.ZodError)
    return { status: 400, value: { error: "invalid_request" } };
  if (e instanceof CloudError)
    return {
      status: e.status,
      value: {
        error: e.code,
        ...(e.code === "rate_limited" ? { retry_after: 1 } : {}),
      },
    };
  if (["57014", "55P03"].includes((e as any)?.code))
    return { status: 503, value: { error: "deadline_exceeded" } };
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
  hookSecret?: string,
) {
  if (host !== "127.0.0.1" || !(service.issuer instanceof StubIssuer))
    throw new Error("slice one only: loopback fictional issuer");
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
        let o;
        try {
          o = new URL(origin);
        } catch {
          throw new CloudError("forbidden");
        }
        if (!["127.0.0.1", "localhost", "[::1]"].includes(o.hostname))
          throw new CloudError("forbidden");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,X-Cloud-Fixture-Secret",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,DELETE,OPTIONS",
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
        write(res, { slice: 1, fixture: true });
        return;
      }
      if (path[0] !== "v2") throw new CloudError("not_found", 404);
      if (path[1] === "test" && path[2] === "hooks") {
        if (
          !service.hooks ||
          !hookSecret ||
          req.headers["x-cloud-fixture-secret"] !== hookSecret
        )
          throw new CloudError("forbidden");
        const hooks = service.hooks,
          stub = service.issuer as StubIssuer;
        if (method === "GET" && path.length === 3) {
          write(res, {
            gates: hooks.state(),
            worker_paused: hooks.pausedWorker,
            drop_notify: hooks.dropNotify,
            worker_fault: hooks.workerFault,
          });
          return;
        }
        if (method !== "POST") throw new CloudError("not_found", 404);
        const b = await body(req);
        if (path[3] === "arm") {
          const v = z
            .object({
              id: IdSchema,
              point: z
                .string()
                .regex(
                  /^(message\.send|operation\.seal|operation\.lookup|operation\.list|invite\.redeem|invite\.revoke|member\.remove|snapshot\.create|snapshot\.page|realtime\.publication|http\.publication|replay|history|read)\.(before_admission|after_admission)$/,
                ),
              match: z.record(z.string(), z.string()).default({}),
            })
            .strict()
            .parse(b);
          hooks.arm(v.id, v.point, v.match);
        } else if (path[3] === "release") {
          hooks.release(z.object({ id: IdSchema }).strict().parse(b).id);
        } else if (path[3] === "control") {
          const v = z
            .object({
              worker_paused: z.boolean().optional(),
              drop_notify: z.boolean().optional(),
              worker_fault: z
                .enum(["none", "before_complete", "after_commit"])
                .optional(),
              issuer_unavailable: z.boolean().optional(),
              issuer_stall_ms: z.number().int().min(0).max(16000).optional(),
              revoke_bearer: z.string().max(4096).optional(),
            })
            .strict()
            .parse(b);
          if (v.worker_paused !== undefined)
            hooks.pausedWorker = v.worker_paused;
          if (v.drop_notify !== undefined) hooks.dropNotify = v.drop_notify;
          if (v.worker_fault !== undefined) hooks.workerFault = v.worker_fault;
          if (v.issuer_unavailable !== undefined)
            stub.unavailable = v.issuer_unavailable;
          if (v.issuer_stall_ms !== undefined) stub.stallMs = v.issuer_stall_ms;
          if (v.revoke_bearer) stub.revoked.add(v.revoke_bearer);
        } else if (
          path[3] === "expire-window" ||
          path[3] === "rotate-epoch" ||
          path[3] === "expire-snapshot" ||
          path[3] === "queue-state" ||
          path[3] === "redeliver"
        ) {
          const v = z
            .object({
              workspace_id: IdSchema,
              account_id: IdSchema.optional(),
              window_id: IdSchema.optional(),
              snapshot_id: IdSchema.optional(),
              room_id: IdSchema.optional(),
              event_id: IdSchema.optional(),
              after_ms: z.number().int().min(0).max(5000).optional(),
            })
            .strict()
            .parse(b);
          const value = await service.db.tx(
            v.account_id ?? "worker",
            v.workspace_id,
            async (q) => {
              await q.query(
                "SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
                [v.workspace_id],
              );
              if (path[3] === "expire-window") {
                if (!v.window_id || !v.account_id)
                  throw new CloudError("invalid_request", 400);
                await q.query(
                  "UPDATE cloud.windows SET expires_at=clock_timestamp()+($3::int * interval '1 millisecond') WHERE workspace_id=$1 AND window_id=$2",
                  [v.workspace_id, v.window_id, v.after_ms ?? 0],
                );
              }
              if (path[3] === "rotate-epoch") {
                await q.query(
                  "UPDATE cloud.workspaces SET epoch=md5(random()::text||clock_timestamp()::text) WHERE workspace_id=$1",
                  [v.workspace_id],
                );
              }
              if (path[3] === "expire-snapshot") {
                if (!v.snapshot_id || !v.account_id)
                  throw new CloudError("invalid_request", 400);
                await q.query(
                  "UPDATE cloud.snapshots SET expires_at=clock_timestamp()+($3::int * interval '1 millisecond') WHERE workspace_id=$1 AND snapshot_id=$2",
                  [v.workspace_id, v.snapshot_id, v.after_ms ?? 0],
                );
              }
              if (path[3] === "redeliver") {
                if (!v.room_id || !v.event_id)
                  throw new CloudError("invalid_request", 400);
                await q.query(
                  "UPDATE cloud.work_queue SET completed_at=NULL WHERE workspace_id=$1 AND room_id=$2 AND event_id=$3",
                  [v.workspace_id, v.room_id, v.event_id],
                );
              }
              if (path[3] === "queue-state")
                return (
                  await q.query(
                    "SELECT room_id,event_id,attempts,completed_at FROM cloud.work_queue WHERE workspace_id=$1 ORDER BY room_id,event_id",
                    [v.workspace_id],
                  )
                ).rows;
              return { ok: true };
            },
          );
          write(res, value);
          return;
        } else throw new CloudError("not_found", 404);
        write(res, { ok: true });
        return;
      }
      if (path.join("/") === "v2/test/sign-in" && method === "POST") {
        const b = z
          .object({ subject: z.string() })
          .strict()
          .parse(await body(req));
        write(res, (service.issuer as StubIssuer).signin(b.subject));
        return;
      }
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
          value = await service.invite(token, w, await body(req));
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
  wsServer.on("connection", (ws) => {
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
                bearer: z.string().min(1).max(4096),
              })
              .strict()
              .parse(v);
            const i = await service.identify(b.bearer);
            if (closed) return;
            token = b.bearer;
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
  const worker = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await service.tickWorker();
    } catch {
      /* Durable rows survive faults; next tick retries. */
    } finally {
      workerBusy = false;
    }
  }, 200);
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
