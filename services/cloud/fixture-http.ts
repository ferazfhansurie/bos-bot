import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CloudService } from "./service.ts";
import { StubIssuer } from "./stub-issuer.ts";
import { CloudError } from "./identity.ts";
import { body } from "./http.ts";
import { IdSchema } from "../../shared/cloud-protocol/index.ts";
export function fixtureRoutes(service: CloudService, hookSecret: string) {
  return async (req: IncomingMessage, res: ServerResponse, path: string[], write: (res: ServerResponse,value:unknown,status?:number)=>void) => {
    const method = req.method ?? "GET";
      if (path[1] === "test" && path[2] === "hooks") {
        const suppliedSecret = req.headers["x-cloud-fixture-secret"];
        const actual = Buffer.from(
          typeof suppliedSecret === "string" ? suppliedSecret : "",
        );
        const expected = Buffer.from(hookSecret ?? "");
        if (
          !service.hooks ||
          !hookSecret ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
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
          return true;
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
          if (!(stub instanceof StubIssuer) && (v.issuer_unavailable !== undefined || v.issuer_stall_ms !== undefined || v.revoke_bearer)) throw new CloudError("invalid_request",400);
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
          return true;
        } else throw new CloudError("not_found", 404);
        write(res, { ok: true });
        return true;
      }
      if (path.join("/") === "v2/test/sign-in" && method === "POST" && service.issuer instanceof StubIssuer) {
        const b = z
          .object({ subject: z.string() })
          .strict()
          .parse(await body(req));
        write(res, (service.issuer as StubIssuer).signin(b.subject));
        return true;
      }

    return false;
  };
}
