import {PushHints} from './push.ts';
import { RoomRuntime } from './runtime.ts';
import { Attachments } from './attachments.ts';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { Database } from "./db.ts";
import type { Sql } from "./db.ts";
import { CloudError, currentIdentity } from "./identity.ts";
import type { Identity, IssuerAdapter } from "./identity.ts";
import { FixtureHooks } from "./hooks.ts";
import {
  SendEnvelopeSchema,
  ReadCoverageSchema,
  SequenceSchema,
  IdSchema,
  RoleSchema,
  LIMITS,
  canonicalJson,
} from "../../shared/cloud-protocol/index.ts";
import type {
  CloudMessage,
  CloudSnapshot,
  CloudEvent,
  ReadCoverage,
} from "../../shared/cloud-protocol/index.ts";
const id = () => randomBytes(18).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const readEmpty = () => ({ prefix: "0", intervals: [], attention: false });
type Authority = { workspace: any; member: any; room?: any };
export class CloudService {
  push: PushHints;
  runtime: RoomRuntime;
  attachments: Attachments;
  db: Database;
  issuer: IssuerAdapter;
  service: string;
  key: Buffer;
  hooks?: FixtureHooks;
  constructor(
    db: Database,
    issuer: IssuerAdapter,
    service: string,
    key: Buffer,
    hooks?: FixtureHooks,
  ) {
    this.db = db;
    this.issuer = issuer;
    this.service = service;
    this.key = key;
    this.hooks = hooks;
    this.push = new PushHints(this);
    this.runtime = new RoomRuntime(this);
    this.attachments = new Attachments(this);
  }
  sign(value: Record<string, unknown>) {
    const data = Buffer.from(canonicalJson(value)).toString("base64url");
    return (
      data +
      "." +
      createHmac("sha256", this.key).update(data).digest("base64url")
    );
  }
  verify(token: string, kind: string) {
    try {
      const [data, sig, ...rest] = token.split(".");
      if (rest.length || !data || !sig) throw 0;
      const expected = createHmac("sha256", this.key).update(data).digest();
      const got = Buffer.from(sig, "base64url");
      if (got.length !== expected.length || !timingSafeEqual(got, expected))
        throw 0;
      const v = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
      if (v.kind !== kind || v.service !== this.service) throw 0;
      return v;
    } catch {
      throw new CloudError(
        kind === "cursor" ? "cursor_invalid" : "recovery_unknown",
        kind === "cursor" ? 400 : 503,
      );
    }
  }
  async identify(bearer: string) {
    const i = await currentIdentity(this.issuer, bearer);
    if (i.service !== this.service)
      throw new CloudError("unauthenticated", 401);
    const account = await this.db.tx(
      i.account_id,
      "",
      async (q) =>
        (
          await q.query("SELECT cloud.ensure_account($1,$2,$3) AS a", [
            i.account_id,
            i.issuer,
            i.subject,
          ])
        ).rows[0].a,
    );
    if (account !== i.account_id)
      throw new CloudError("identity_unavailable", 503);
    return i;
  }
  async protect<T>(
    bearer: string,
    w: string,
    r: string | undefined,
    action: string,
    details: Record<string, string>,
    fn: (q: Sql, i: Identity, a: Authority) => Promise<T>,
  ): Promise<T> {
    IdSchema.parse(w);
    if (r) IdSchema.parse(r);
    const before = await this.identify(bearer);
    await this.hooks?.hit(action + ".before_admission", {
      workspace_id: w,
      room_id: r ?? "",
      account_id: before.account_id,
      ...details,
    });
    return this.db.tx(before.account_id, w, async (q) => {
      const workspace = (
        await q.query(
          "SELECT * FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
          [w],
        )
      ).rows[0];
      if (!workspace) throw new CloudError("forbidden");
      // Fresh authoritative validation AFTER the lock wait; never silently extend an assertion.
      const i = await currentIdentity(this.issuer, bearer);
      if (
        i.account_id !== before.account_id ||
        i.issuer !== before.issuer ||
        i.subject !== before.subject ||
        i.service !== this.service
      )
        throw new CloudError("unauthenticated", 401);
      const member = (
        await q.query(
          "SELECT * FROM cloud.members WHERE workspace_id=$1 AND account_id=$2",
          [w, i.account_id],
        )
      ).rows[0];
      if (!member) throw new CloudError("forbidden");
      let room;
      if (r) {
        room = (
          await q.query(
            "SELECT * FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2 FOR UPDATE",
            [w, r],
          )
        ).rows[0];
        if (!room) throw new CloudError("forbidden");
        if (
          member.role === "guest" &&
          !(
            await q.query(
              "SELECT 1 FROM cloud.room_grants WHERE workspace_id=$1 AND room_id=$2 AND account_id=$3",
              [w, r, i.account_id],
            )
          ).rowCount
        )
          throw new CloudError("forbidden");
      }
      await this.hooks?.hit(action + ".after_admission", {
        workspace_id: w,
        room_id: r ?? "",
        account_id: i.account_id,
        ...details,
      });
      const result = await fn(q, i, { workspace, member, room });
      this.fresh(i);
      return result;
    });
  }
  fresh(i: Identity) {
    if (i.expires_at <= Date.now())
      throw new CloudError("identity_unavailable", 503);
  }
  admin(a: Authority, ownerOnly = false) {
    if (
      ownerOnly
        ? a.member.role !== "owner"
        : !["owner", "admin"].includes(a.member.role)
    )
      throw new CloudError("forbidden");
  }
  async thread(q: Sql, w: string, r: string, t: string) {
    IdSchema.parse(t);
    if (
      !(
        await q.query(
          "SELECT 1 FROM cloud.threads WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND NOT archived",
          [w, r, t],
        )
      ).rowCount
    )
      throw new CloudError("forbidden");
  }
  namespace(i: Identity, w: any) {
    return {
      service: this.service,
      issuer: i.issuer,
      subject: i.subject,
      account_id: i.account_id,
      workspace_id: w.workspace_id,
      epoch: w.epoch,
    };
  }
  async createWorkspace(bearer: string, body: unknown) {
    const { name } = z
      .object({ name: z.string().min(1).max(128) })
      .strict()
      .parse(body);
    const i = await this.identify(bearer);
    const w = id();
    return this.db.tx(i.account_id, w, async (q) => {
      await q.query("INSERT INTO cloud.workspaces VALUES($1,$2,$3)", [
        w,
        name,
        id(),
      ]);
      await q.query("INSERT INTO cloud.members VALUES($1,$2,'owner')", [
        w,
        i.account_id,
      ]);
      this.fresh(i);
      return { workspace_id: w, role: "owner" };
    });
  }
  async discovery(bearer: string, deliver?: (value: any) => void) {
    const i = await this.identify(bearer);
    const list = await this.db.tx(
      i.account_id,
      "",
      async (q) =>
        (await q.query("SELECT * FROM cloud.discover() ORDER BY workspace_id"))
          .rows,
    );
    // Sorted tenant authority locks remain held through actual replacement publication.
    return this.db.tx(i.account_id, "", async (q) => {
      const workspaces = [];
      for (const m of list) {
        await q.query("SELECT set_config('cloud.workspace_id',$1,true)", [
          m.workspace_id,
        ]);
        const w = (
          await q.query(
            "SELECT * FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
            [m.workspace_id],
          )
        ).rows[0];
        if (!w) continue;
        const member = (
          await q.query(
            "SELECT role FROM cloud.members WHERE workspace_id=$1 AND account_id=$2",
            [m.workspace_id, i.account_id],
          )
        ).rows[0];
        if (!member) continue;
        workspaces.push({
          workspace_id: m.workspace_id,
          role: member.role,
          rooms: (
            await q.query(
              "SELECT r.room_id,t.thread_id,r.policy_revision::text FROM cloud.rooms r JOIN cloud.threads t USING(workspace_id,room_id) WHERE r.workspace_id=$1 AND ($3<>'guest' OR EXISTS(SELECT 1 FROM cloud.room_grants g WHERE g.workspace_id=r.workspace_id AND g.room_id=r.room_id AND g.account_id=$2)) ORDER BY r.room_id,t.thread_id",
              [m.workspace_id, i.account_id, member.role],
            )
          ).rows,
        });
      }
      await currentIdentity(this.issuer, bearer);
      const value = { workspaces };
      if (deliver) deliver(value);
      return value;
    });
  }
  async createRoom(bearer: string, w: string, body: unknown) {
    const { name } = z
      .object({ name: z.string().min(1).max(128) })
      .strict()
      .parse(body);
    return this.protect(
      bearer,
      w,
      undefined,
      "room.create",
      {},
      async (q, _i, a) => {
        this.admin(a);
        const r = id(),
          t = id();
        await q.query(
          "INSERT INTO cloud.rooms(workspace_id,room_id,name) VALUES($1,$2,$3)",
          [w, r, name],
        );
        await q.query(
          "INSERT INTO cloud.threads(workspace_id,room_id,thread_id) VALUES($1,$2,$3)",
          [w, r, t],
        );
        return { room_id: r, thread_id: t, policy_revision: "1" };
      },
    );
  }
  async invite(bearer: string, w: string, body: unknown, deliver?: (value: any) => void | Promise<void>) {
    const b = z
      .object({
        role: RoleSchema,
        room_ids: z.array(IdSchema).min(1).max(50),
        subject: z.string().max(128).optional(),
        expires_in_seconds: z.number().int().min(1).max(604800).optional(),
      })
      .strict()
      .parse(body);
    const value = await this.protect(
      bearer,
      w,
      undefined,
      "invite.create",
      {},
      async (q, i, a) => {
        this.admin(a, ["owner", "admin"].includes(b.role));
        for (const r of b.room_ids)
          if (
            !(
              await q.query(
                "SELECT 1 FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2",
                [w, r],
              )
            ).rowCount
          )
            throw new CloudError("forbidden");
        const token = randomBytes(32).toString("base64url"),
          invite_id = id();
        const expires = new Date(
          Date.now() + (b.expires_in_seconds ?? 604800) * 1000,
        );
        await q.query(
          "INSERT INTO cloud.invites(workspace_id,invite_id,token_hash,inviter_id,role,subject,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            w,
            invite_id,
            hash(token),
            i.account_id,
            b.role,
            b.subject ?? null,
            expires,
          ],
        );
        for (const r of new Set(b.room_ids))
          await q.query("INSERT INTO cloud.invite_rooms VALUES($1,$2,$3)", [
            w,
            invite_id,
            r,
          ]);
        await q.query("INSERT INTO cloud.invite_outbox(workspace_id,invite_id,publication_state) VALUES($1,$2,$3)",[w,invite_id,deliver ? "pending" : "published"]);
        const value = {invite_id,token,expires_at:expires.toISOString()};
        this.fresh(i);

        return value;
      },
    );
    if (deliver) {
      try {
        await this.protect(bearer,w,undefined,"http.publication",{invite_id:value.invite_id},async(q,i)=>{
          this.fresh(i);
          await deliver(value);
          await q.query("UPDATE cloud.invite_outbox SET publication_state='published' WHERE workspace_id=$1 AND invite_id=$2",[w,value.invite_id]);
        });
      } catch(e) {
        await this.reapInvite(w,value.invite_id);
        throw e;
      }
    }
    return value;
  }
  async reapInvite(w: string,invite: string) {
    await this.db.tx("worker",w,async q=>{
      await q.query("SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",[w]);
      const pending=(await q.query("SELECT 1 FROM cloud.invite_outbox WHERE workspace_id=$1 AND invite_id=$2 AND publication_state='pending'",[w,invite])).rowCount;
      if (!pending) return;
      await q.query("DELETE FROM cloud.invite_rooms WHERE workspace_id=$1 AND invite_id=$2",[w,invite]);
      await q.query("DELETE FROM cloud.invites WHERE workspace_id=$1 AND invite_id=$2",[w,invite]);
    });
  }
  async inviteAction(
    bearer: string,
    body: unknown,
    redeem: boolean,
    deliver?: (value: any) => void,
  ) {
    const { token } = z
      .object({ token: z.string().min(1).max(256) })
      .strict()
      .parse(body);
    const i = await this.identify(bearer),
      h = hash(token);
    const w = await this.db.tx(
      i.account_id,
      "",
      async (q) =>
        (await q.query("SELECT cloud.locate_invite($1) AS w", [h])).rows[0].w,
    );
    if (!w) throw new CloudError("not_found", 404);
    const action = redeem ? "invite.redeem" : "invite.preview";
    await this.hooks?.hit(action + ".before_admission", {
      workspace_id: w,
      account_id: i.account_id,
      token_hash: h,
    });
    return this.db.tx(i.account_id, w, async (q) => {
      const workspace = (
        await q.query(
          "SELECT * FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
          [w],
        )
      ).rows[0];
      if (!workspace) throw new CloudError("not_found", 404);
      const fresh = await currentIdentity(this.issuer, bearer);
      if (
        fresh.account_id !== i.account_id ||
        fresh.issuer !== i.issuer ||
        fresh.subject !== i.subject ||
        fresh.service !== i.service
      )
        throw new CloudError("unauthenticated", 401);
      const inv = (
        await q.query(
          "SELECT * FROM cloud.invites WHERE workspace_id=$1 AND token_hash=$2 FOR UPDATE",
          [w, h],
        )
      ).rows[0];
      if (!inv) throw new CloudError("not_found", 404);
      await this.hooks?.hit(action + ".after_admission", {
        workspace_id: w,
        account_id: i.account_id,
        token_hash: h,
        invite_id: inv.invite_id,
      });
      if (!(await q.query("SELECT 1 FROM cloud.invite_outbox WHERE workspace_id=$1 AND invite_id=$2 AND publication_state='published'",[w,inv.invite_id])).rowCount)
        throw new CloudError("unavailable",503);
      if (inv.revoked) throw new CloudError("invite_revoked");
      if (inv.redeemed_by) throw new CloudError("invite_used");
      if (inv.expires_at.getTime() <= Date.now())
        throw new CloudError("invite_expired");
      if (inv.subject && inv.subject !== i.subject)
        throw new CloudError("forbidden");
      const room_ids = (
        await q.query(
          "SELECT room_id FROM cloud.invite_rooms WHERE workspace_id=$1 AND invite_id=$2 ORDER BY room_id",
          [w, inv.invite_id],
        )
      ).rows.map((x) => x.room_id);
      if (!redeem) {
        const value = {
          issuer: i.issuer,
          workspace_id: w,
          inviter_id: inv.inviter_id,
          role: inv.role,
          room_ids,
          expires_at: inv.expires_at.toISOString(),
        };
        this.fresh(fresh);
        if (inv.expires_at.getTime() <= Date.now())
          throw new CloudError("invite_expired");
        if (deliver) deliver(value);
        return value;
      }
      if (
        (
          await q.query(
            "SELECT 1 FROM cloud.members WHERE workspace_id=$1 AND account_id=$2",
            [w, i.account_id],
          )
        ).rowCount
      )
        throw new CloudError("invalid_request", 409);
      this.fresh(fresh);
      if (inv.expires_at.getTime() <= Date.now())
        throw new CloudError("invite_expired");
      await q.query("INSERT INTO cloud.members VALUES($1,$2,$3)", [
        w,
        i.account_id,
        inv.role,
      ]);
      if (inv.role === "guest")
        for (const r of room_ids)
          await q.query("INSERT INTO cloud.room_grants VALUES($1,$2,$3)", [
            w,
            r,
            i.account_id,
          ]);
      await q.query(
        "UPDATE cloud.invites SET redeemed_by=$3 WHERE workspace_id=$1 AND invite_id=$2",
        [w, inv.invite_id, i.account_id],
      );
      await this.bumpPolicies(q, w);
      return { workspace_id: w, role: inv.role, room_ids };
    });
  }
  async revokeInvite(bearer: string, w: string, invite: string) {
    IdSchema.parse(invite);
    return this.protect(
      bearer,
      w,
      undefined,
      "invite.revoke",
      { invite_id: invite },
      async (q, _i, a) => {
        this.admin(a);
        if (
          !(
            await q.query(
              "UPDATE cloud.invites SET revoked=true WHERE workspace_id=$1 AND invite_id=$2 RETURNING 1",
              [w, invite],
            )
          ).rowCount
        )
          throw new CloudError("not_found", 404);
        return { revoked: true };
      },
    );
  }
  async removeMember(bearer: string, w: string, account: string) {
    IdSchema.parse(account);
    return this.protect(
      bearer,
      w,
      undefined,
      "member.remove",
      { target_id: account },
      async (q, i, a) => {
        this.admin(a);
        const target = (
          await q.query(
            "SELECT role FROM cloud.members WHERE workspace_id=$1 AND account_id=$2",
            [w, account],
          )
        ).rows[0];
        if (!target) throw new CloudError("not_found", 404);
        if (["owner", "admin"].includes(target.role)) this.admin(a, true);
        if (
          target.role === "owner" &&
          (
            await q.query(
              "SELECT count(*)::int AS n FROM cloud.members WHERE workspace_id=$1 AND role='owner'",
              [w],
            )
          ).rows[0].n <= 1
        )
          throw new CloudError("last_owner", 409);
        await q.query(
          "DELETE FROM cloud.members WHERE workspace_id=$1 AND account_id=$2",
          [w, account],
        );
        await this.runtime.revokeActor(q, w, account);
        await this.bumpPolicies(q, w);
        return { removed: true };
      },
    );
  }
  async bumpPolicies(q: Sql, w: string) {
    const rooms = (
      await q.query(
        "UPDATE cloud.rooms SET policy_revision=policy_revision+1 WHERE workspace_id=$1 RETURNING room_id,policy_revision::text",
        [w],
      )
    ).rows;
    for (const r of rooms)
      await this.event(q, w, r.room_id, null, "room.membership_changed", {
        policy_revision: r.policy_revision,
      });
  }
  async event(
    q: Sql,
    w: string,
    r: string,
    t: string | null,
    kind: string,
    payload: unknown,
  ) {
    const sequence = (
      await q.query(
        "UPDATE cloud.rooms SET head=head+1 WHERE workspace_id=$1 AND room_id=$2 RETURNING head::text",
        [w, r],
      )
    ).rows[0].head;
    const event_id = id();
    await q.query(
      "INSERT INTO cloud.room_events VALUES($1,$2,$3,$4,$5,$6,$7)",
      [w, r, event_id, sequence, t, kind, payload],
    );
    await q.query("INSERT INTO cloud.outbox VALUES($1,$2,$3)", [
      w,
      r,
      event_id,
    ]);
    await q.query(
      "INSERT INTO cloud.work_queue(workspace_id,room_id,event_id) VALUES($1,$2,$3)",
      [w, r, event_id],
    );
    return sequence;
  }
  async window(bearer: string, w: string) {
    return this.protect(
      bearer,
      w,
      undefined,
      "window.create",
      {},
      async (q, i, a) => {
        const window_id = id(),
          issued_at = new Date(),
          expires_at = new Date(issued_at.getTime() + LIMITS.windowMs);
        const namespace = this.namespace(i, a.workspace);
        const window_token = this.sign({
          kind: "window",
          service: this.service,
          namespace,
          window_id,
          kid: "slice1",
          issued_at: issued_at.toISOString(),
          expires_at: expires_at.toISOString(),
        });
        await q.query("INSERT INTO cloud.windows VALUES($1,$2,$3,$4,$5,$6)", [
          w,
          i.account_id,
          window_id,
          a.workspace.epoch,
          issued_at,
          expires_at,
        ]);
        return {
          namespace,
          window_id,
          window_token,
          issued_at: issued_at.toISOString(),
          expires_at: expires_at.toISOString(),
        };
      },
    );
  }
  async operation(bearer: string, w: string, body: unknown, seal = false) {
    const e = SendEnvelopeSchema.parse(body),
      digest = hash(canonicalJson(e));
    if (e.namespace.workspace_id !== w) throw new CloudError("forbidden");
    return this.protect(
      bearer,
      w,
      e.room_id,
      seal ? "operation.seal" : "message.send",
      { client_operation_id: e.client_operation_id, digest },
      async (q, i, a) => {
        await this.thread(q, w, e.room_id, e.thread_id);
        const expected = this.namespace(i, a.workspace);
        if (
          Object.entries(expected).some(
            ([k, v]) => k !== "epoch" && (e.namespace as any)[k] !== v,
          )
        )
          throw new CloudError("forbidden");
        const old = (
          await q.query(
            "SELECT * FROM cloud.operations WHERE workspace_id=$1 AND account_id=$2 AND client_operation_id=$3",
            [w, i.account_id, e.client_operation_id],
          )
        ).rows[0];
        if (old) {
          if (old.digest !== digest)
            throw new CloudError("operation_conflict", 409);
          return old.result;
        }
        if (e.namespace.epoch !== a.workspace.epoch)
          return {
            status: "recovery_unknown",
            client_operation_id: e.client_operation_id,
            retry: "reconcile_only",
          };
        const token = this.verify(e.window_token, "window");
        if (
          canonicalJson(token.namespace) !== canonicalJson(e.namespace) ||
          !e.client_operation_id.startsWith(token.window_id + ".") ||
          token.kid !== "slice1"
        )
          throw new CloudError("operation_conflict", 409);
        const win = (
          await q.query(
            "SELECT * FROM cloud.windows WHERE workspace_id=$1 AND account_id=$2 AND window_id=$3",
            [w, i.account_id, token.window_id],
          )
        ).rows[0];
        if (!win || win.epoch !== a.workspace.epoch)
          return {
            status: "recovery_unknown",
            client_operation_id: e.client_operation_id,
            retry: "reconcile_only",
          };
        let reason: string | undefined;
        if (
          win.expires_at.getTime() <= Date.now() ||
          Date.parse(token.expires_at) <= Date.now()
        )
          reason = "operation_expired";
        else if (e.expected_policy_revision !== a.room.policy_revision)
          reason = "policy_changed";
        else {
          reason = await this.runtime.validate(q,w,e.room_id,e.thread_id,i.account_id,e.mentions,e.attachment_ids);
          for (const m of e.mentions) {
            if (m.kind === "bot") continue;
            const member = (
              await q.query(
                "SELECT 1 FROM cloud.members m WHERE m.workspace_id=$1 AND m.account_id=$2 AND (m.role<>'guest' OR EXISTS(SELECT 1 FROM cloud.room_grants g WHERE g.workspace_id=m.workspace_id AND g.account_id=m.account_id AND g.room_id=$3))",
                [w, m.id, e.room_id],
              )
            ).rowCount;
            if (!member) {
              reason = "invalid_mention";
              break;
            }
          }
          if (e.reply_to_message_id) {
            const parent = (
              await q.query(
                "SELECT 1 FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND message_id=$4 AND NOT deleted",
                [w, e.room_id, e.thread_id, e.reply_to_message_id],
              )
            ).rowCount;
            if (!parent) reason = "invalid_reply";
          }
        }
        if (seal && !reason) reason = "not_found";
        this.fresh(i);
        if (
          !reason &&
          (win.expires_at.getTime() <= Date.now() ||
            Date.parse(token.expires_at) <= Date.now())
        )
          reason = "operation_expired";
        let result;
        if (reason)
          result = {
            status: "rejected",
            client_operation_id: e.client_operation_id,
            digest,
            reason,
            retry: "none",
          };
        else {
          const message_id = id();
          const seq = (
            await q.query(
              "SELECT (head+1)::text AS n FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2",
              [w, e.room_id],
            )
          ).rows[0].n;
          const m = (
            await q.query(
              "INSERT INTO cloud.messages(workspace_id,room_id,thread_id,message_id,actor_id,client_operation_id,sequence,text,mentions,reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
              [
                w,
                e.room_id,
                e.thread_id,
                message_id,
                i.account_id,
                e.client_operation_id,
                seq,
                JSON.stringify(e.text),
                JSON.stringify(e.mentions),
                e.reply_to_message_id,
              ],
            )
          ).rows[0];
          if (e.attachment_ids.length) {
            await q.query('UPDATE cloud.messages SET attachment_ids=$4 WHERE workspace_id=$1 AND room_id=$2 AND message_id=$3',[w,e.room_id,message_id,JSON.stringify(e.attachment_ids)]);
            m.attachment_ids=e.attachment_ids;
            await this.attachments.attach(q,w,e.room_id,message_id,e.attachment_ids);
          }
          const message = this.message(m);
          const sequence = await this.event(
            q,
            w,
            e.room_id,
            e.thread_id,
            "message.created",
            { message },
          );
          await this.runtime.offer(q,w,e.room_id,e.thread_id,message,e.attachment_ids);
          result = {
            status: "accepted",
            client_operation_id: e.client_operation_id,
            digest,
            message_id,
            room_id: e.room_id,
            thread_id: e.thread_id,
            sequence,
            redacted: false,
            retry: "none",
          };
        }
        await q.query(
          "INSERT INTO cloud.operations(workspace_id,account_id,client_operation_id,digest,room_id,thread_id,result) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            w,
            i.account_id,
            e.client_operation_id,
            digest,
            e.room_id,
            e.thread_id,
            result,
          ],
        );
        return result;
      },
    );
  }
  message(m: any): CloudMessage {
    return { ...m, created_at: m.created_at.toISOString() };
  }
  async lookup(bearer: string, w: string, operation: string) {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,128}$/.test(operation))
      throw new CloudError("invalid_request", 400);
    return this.protect(
      bearer,
      w,
      undefined,
      "operation.lookup",
      { client_operation_id: operation },
      async (q, i, a) => {
        const old = (
          await q.query(
            "SELECT * FROM cloud.operations WHERE workspace_id=$1 AND account_id=$2 AND client_operation_id=$3",
            [w, i.account_id, operation],
          )
        ).rows[0];
        if (old) {
          await this.roomCheck(q, w, old.room_id, i, a.member);
          return old.result;
        }
        const win = (
          await q.query(
            "SELECT epoch FROM cloud.windows WHERE workspace_id=$1 AND account_id=$2 AND window_id=$3",
            [w, i.account_id, operation.split(".")[0]],
          )
        ).rows[0];
        return win && win.epoch === a.workspace.epoch
          ? {
              status: "not_found",
              client_operation_id: operation,
              retry: "unchanged_or_seal",
            }
          : {
              status: "recovery_unknown",
              client_operation_id: operation,
              retry: "reconcile_only",
            };
      },
    );
  }
  async roomCheck(q: Sql, w: string, r: string, i: Identity, member: any) {
    if (
      !(
        await q.query(
          "SELECT 1 FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2",
          [w, r],
        )
      ).rowCount
    )
      throw new CloudError("forbidden");
    if (
      member.role === "guest" &&
      !(
        await q.query(
          "SELECT 1 FROM cloud.room_grants WHERE workspace_id=$1 AND room_id=$2 AND account_id=$3",
          [w, r, i.account_id],
        )
      ).rowCount
    )
      throw new CloudError("forbidden");
  }
  async operations(bearer: string, w: string, cursor?: string) {
    return this.protect(
      bearer,
      w,
      undefined,
      "operation.list",
      {},
      async (q, i, a) => {
        let after = "";
        if (cursor) {
          const c = this.verify(cursor, "list");
          if (
            c.account_id !== i.account_id ||
            c.workspace_id !== w ||
            c.epoch !== a.workspace.epoch
          )
            throw new CloudError("forbidden");
          after = c.after;
        }
        const ops = (
          await q.query(
            "SELECT o.* FROM cloud.operations o WHERE workspace_id=$1 AND account_id=$2 AND client_operation_id>$3 AND created_at>clock_timestamp()-interval '30 days' ORDER BY client_operation_id LIMIT 101",
            [w, i.account_id, after],
          )
        ).rows;
        const visible = [];
        for (const o of ops.slice(0, 100))
          try {
            await this.roomCheck(q, w, o.room_id, i, a.member);
            visible.push(o.result);
          } catch (e) {
            if (!(e instanceof CloudError)) throw e;
          }
        return {
          operations: visible,
          next_cursor:
            ops.length > 100
              ? this.sign({
                  kind: "list",
                  service: this.service,
                  account_id: i.account_id,
                  workspace_id: w,
                  epoch: a.workspace.epoch,
                  after: ops[99].client_operation_id,
                })
              : null,
        };
      },
    );
  }
  cursor(
    i: Identity,
    a: Authority,
    t: string,
    sequence: string,
    frontier?: string,
  ) {
    return this.sign({
      kind: "cursor",
      service: this.service,
      account_id: i.account_id,
      workspace_id: a.workspace.workspace_id,
      room_id: a.room.room_id,
      thread_id: t,
      epoch: a.workspace.epoch,
      revision: a.room.policy_revision,
      sequence,
      ...(frontier === undefined ? {} : { frontier }),
      expires_at: Date.now() + LIMITS.snapshotMs,
    });
  }
  async acknowledged(
    q: Sql,
    w: string,
    r: string,
    t: string,
    a: string,
    head: string,
  ) {
    await q.query(
      "INSERT INTO cloud.read_heads VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,room_id,thread_id,account_id) DO UPDATE SET head=greatest(cloud.read_heads.head,excluded.head)",
      [w, r, t, a, head],
    );
  }
  async coverage(
    q: Sql,
    w: string,
    r: string,
    t: string,
    a: string,
  ): Promise<ReadCoverage> {
    const v = (
      await q.query(
        "SELECT prefix::text,intervals,attention FROM cloud.read_coverage WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND account_id=$4",
        [w, r, t, a],
      )
    ).rows[0];
    return v ?? readEmpty();
  }
  async makeSnapshot(
    q: Sql,
    i: Identity,
    a: Authority,
    t: string,
  ): Promise<CloudSnapshot> {
    const w = a.workspace.workspace_id,
      r = a.room.room_id;
    await this.thread(q, w, r, t);
    const messages = (
      await q.query(
        "SELECT * FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 ORDER BY sequence DESC LIMIT 50",
        [w, r, t],
      )
    ).rows
      .reverse()
      .map((m) => this.message(m));
    const members = (
      await q.query(
        "SELECT account_id,role FROM cloud.members m WHERE workspace_id=$1 AND (role<>'guest' OR EXISTS(SELECT 1 FROM cloud.room_grants g WHERE g.workspace_id=m.workspace_id AND g.account_id=m.account_id AND g.room_id=$2)) ORDER BY account_id",
        [w, r],
      )
    ).rows;
    const threads = (
      await q.query(
        "SELECT thread_id,archived FROM cloud.threads WHERE workspace_id=$1 AND room_id=$2 ORDER BY thread_id",
        [w, r],
      )
    ).rows;
    const runtimeProjection=await this.runtime.projection(q,w,r,t,i.account_id);
    a.room.head=(await q.query('SELECT head::text FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2',[w,r])).rows[0].head;
    const snapshot_id = id(),
      expires_at = new Date(Date.now() + LIMITS.snapshotMs).toISOString();
    const projection = {
      snapshot_id,
      expires_at,
      workspace_id: w,
      room_id: r,
      thread_id: t,
      watermark: a.room.head,
      frontier: a.room.head,
      cursor: this.cursor(i, a, t, a.room.head),
      policy_revision: a.room.policy_revision,
      messages,
      members,
      threads,
      capabilities: ["message.send", "history", "read"],
      read: await this.coverage(q, w, r, t, i.account_id),
      ...runtimeProjection,
    };
    await q.query(
      "INSERT INTO cloud.snapshots VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        w,
        r,
        t,
        snapshot_id,
        i.account_id,
        a.workspace.epoch,
        a.room.policy_revision,
        a.room.head,
        expires_at,
        projection,
      ],
    );
    await this.acknowledged(q, w, r, t, i.account_id, a.room.head);
    return projection;
  }
  async snapshot(bearer: string, w: string, r: string, body: unknown) {
    const { thread_id } = z
      .object({ thread_id: IdSchema })
      .strict()
      .parse(body);
    return this.protect(bearer, w, r, "snapshot.create", {}, (q, i, a) =>
      this.makeSnapshot(q, i, a, thread_id),
    );
  }
  async snapshotRow(q: Sql, i: Identity, a: Authority, s: string) {
    IdSchema.parse(s);
    const v = (
      await q.query(
        "SELECT * FROM cloud.snapshots WHERE workspace_id=$1 AND room_id=$2 AND snapshot_id=$3 AND account_id=$4",
        [a.workspace.workspace_id, a.room.room_id, s, i.account_id],
      )
    ).rows[0];
    if (!v || v.expires_at.getTime() <= Date.now())
      throw new CloudError("snapshot_expired", 409);
    if (
      v.epoch !== a.workspace.epoch ||
      v.policy_revision !== a.room.policy_revision
    )
      throw new CloudError("visibility_changed", 409);
    return v;
  }
  async snapshotPage(bearer: string, w: string, r: string, s: string) {
    return this.protect(
      bearer,
      w,
      r,
      "snapshot.page",
      { snapshot_id: s },
      async (q, i, a) => (await this.snapshotRow(q, i, a, s)).projection,
    );
  }
  async replayIn(
    q: Sql,
    i: Identity,
    a: Authority,
    b: { thread_id: string; cursor: string | null; snapshot_id?: string },
  ) {
    const w = a.workspace.workspace_id,
      r = a.room.room_id;
    await this.thread(q, w, r, b.thread_id);
    let reason = "cursor_invalid",
      c;
    if (b.cursor)
      try {
        c = this.verify(b.cursor, "cursor");
        if (
          c.account_id !== i.account_id ||
          c.workspace_id !== w ||
          c.room_id !== r ||
          c.thread_id !== b.thread_id
        )
          throw new CloudError("cursor_invalid", 400);
        if (
          c.epoch !== a.workspace.epoch ||
          c.revision !== a.room.policy_revision
        ) {
          reason = "visibility_changed";
          throw 0;
        }
        if (c.expires_at <= Date.now()) {
          reason = "snapshot_expired";
          throw 0;
        }
        SequenceSchema.parse(c.sequence);
        if (BigInt(c.sequence) > BigInt(a.room.head)) throw 0;
        if (c.frontier !== undefined) {
          SequenceSchema.parse(c.frontier);
          if (
            BigInt(c.frontier) > BigInt(a.room.head) ||
            BigInt(c.frontier) < BigInt(c.sequence)
          )
            throw 0;
        }
        if (b.snapshot_id) {
          const s = await this.snapshotRow(q, i, a, b.snapshot_id);
          if (
            s.thread_id !== b.thread_id ||
            BigInt(c.sequence) < BigInt(s.watermark)
          )
            throw 0;
        }
      } catch (e) {
        if (
          e instanceof CloudError &&
          ["snapshot_expired", "visibility_changed"].includes(e.code)
        )
          reason = e.code;
        c = undefined;
      }
    if (!c)
      return {
        type: "reset_required",
        workspace_id: w,
        room_id: r,
        reason,
        snapshot: await this.makeSnapshot(q, i, a, b.thread_id),
      };
    const frontier = c.frontier ?? a.room.head;
    const rows = (
      await q.query(
        "SELECT * FROM cloud.room_events WHERE workspace_id=$1 AND room_id=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT 100",
        [w, r, c.sequence, frontier],
      )
    ).rows;
    const events: CloudEvent[] = [];
    let scanned = c.sequence,
      bytes = 2048;
    for (const e of rows) {
      const visible = (e.thread_id === null || e.thread_id === b.thread_id) &&
        (!['approval.updated','attachment.updated'].includes(e.kind) || e.payload.actor_id === i.account_id);
      const event = {
        schema_version: 1,
        workspace_id: w,
        room_id: r,
        event_id: e.event_id,
        sequence: e.sequence,
        kind: e.kind,
        required: true,
        payload: e.payload,
      };
      const size = visible ? Buffer.byteLength(JSON.stringify(event)) : 0;
      if (bytes + size > LIMITS.replayBytes) break;
      if (visible) {
        events.push(event);
        bytes += size;
      }
      scanned = e.sequence;
    }
    if (rows.length === 0) scanned = frontier;
    await this.acknowledged(q, w, r, b.thread_id, i.account_id, scanned);
    return {
      type: "event_batch",
      workspace_id: w,
      room_id: r,
      events,
      cursor: this.cursor(
        i,
        a,
        b.thread_id,
        scanned,
        scanned === frontier ? undefined : frontier,
      ),
      scanned_sequence: scanned,
      frontier,
      live: scanned === frontier,
    };
  }
  async replay(
    bearer: string,
    w: string,
    r: string,
    body: unknown,
    deliver?: (v: any) => void | boolean,
  ) {
    const b = z
      .object({
        thread_id: IdSchema,
        cursor: z.string().max(4096).nullable(),
        snapshot_id: IdSchema.optional(),
      })
      .strict()
      .parse(body);
    return this.protect(
      bearer,
      w,
      r,
      deliver ? "realtime.publication" : "replay",
      {},
      async (q, i, a) => {
        const frame = await this.replayIn(q, i, a, b);
        this.fresh(i);
        if (deliver && deliver(frame) === false)
          throw new CloudError("unavailable", 503);
        return frame;
      },
    );
  }
  async history(
    bearer: string,
    w: string,
    r: string,
    t: string,
    before: string,
    limit: number,
  ) {
    SequenceSchema.parse(before);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new CloudError("invalid_request", 400);
    return this.protect(bearer, w, r, "history", {}, async (q, _i, _a) => {
      await this.thread(q, w, r, t);
      const rows = (
        await q.query(
          "SELECT * FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND sequence<$4 ORDER BY sequence DESC LIMIT $5",
          [w, r, t, before, limit],
        )
      ).rows;
      return {
        messages: rows.reverse().map((m) => this.message(m)),
        next_before: rows.length === limit ? rows[0].sequence : null,
      };
    });
  }
  async read(bearer: string, w: string, r: string, body: unknown) {
    const b = z
      .object({
        thread_id: IdSchema,
        intervals: z.array(z.tuple([SequenceSchema, SequenceSchema])).max(256),
        mark_read_through: SequenceSchema.optional(),
        attention: z.boolean().optional(),
      })
      .strict()
      .parse(body);
    return this.protect(bearer, w, r, "read", {}, async (q, i, _a) => {
      await this.thread(q, w, r, b.thread_id);
      const current = await this.coverage(q, w, r, b.thread_id, i.account_id);
      const acknowledged =
        (
          await q.query(
            "SELECT head::text FROM cloud.read_heads WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND account_id=$4",
            [w, r, b.thread_id, i.account_id],
          )
        ).rows[0]?.head ?? "0";
      const max = BigInt(acknowledged);
      let prefix = BigInt(current.prefix);
      const intervals = [...current.intervals, ...b.intervals].map(
        ([l, h]) => [BigInt(l), BigInt(h)] as [bigint, bigint],
      );
      if (
        intervals.some(([l, h]) => l < 1n || l > h || h > max) ||
        (b.mark_read_through !== undefined && BigInt(b.mark_read_through) > max)
      )
        throw new CloudError("invalid_request", 400);
      if (
        b.mark_read_through !== undefined &&
        BigInt(b.mark_read_through) > prefix
      )
        prefix = BigInt(b.mark_read_through);
      intervals.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const merged: [bigint, bigint][] = [];
      for (const [lo, hi] of intervals) {
        if (hi <= prefix) continue;
        if (lo <= prefix + 1n) {
          prefix = hi;
          continue;
        }
        const last = merged.at(-1);
        if (last && lo <= last[1] + 1n) {
          if (hi > last[1]) last[1] = hi;
        } else merged.push([lo, hi]);
      }
      if (merged.length > 256) throw new CloudError("read_coverage_limit", 409);
      const value = ReadCoverageSchema.parse({
        prefix: String(prefix),
        intervals: merged.map(([l, h]) => [String(l), String(h)]),
        attention: b.attention ?? current.attention,
      });
      await q.query(
        "INSERT INTO cloud.read_coverage VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,room_id,thread_id,account_id) DO UPDATE SET prefix=excluded.prefix,intervals=excluded.intervals,attention=excluded.attention",
        [
          w,
          r,
          b.thread_id,
          i.account_id,
          value.prefix,
          JSON.stringify(value.intervals),
          value.attention,
        ],
      );
      return value;
    });
  }
  async publishHttp(
    bearer: string,
    w: string,
    r: string | undefined,
    send: () => void,
  ) {
    return this.protect(bearer, w, r, "http.publication", {}, async () => {
      send();
    });
  }
  async tickWorker() {
    if (this.hooks?.pausedWorker) return;
    const stale=await this.db.tx("worker","",async q=>(await q.query("SELECT * FROM cloud.pending_invite_publications()" )).rows);
    for(const row of stale) await this.reapInvite(row.workspace_id,row.invite_id);
    const workspaces = await this.db.tx(
      "worker",
      "",
      async (q) =>
        (
          await q.query(
            "SELECT * FROM cloud.pending_workspaces() AS workspace_id",
          )
        ).rows,
    );
    for (const { workspace_id: w } of workspaces) {
      await this.db.tx("worker", w, async (q) => {
        // Same authority lock as writes/revocations. No external effects in this slice.
        await q.query(
          "SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
          [w],
        );
        await this.runtime.sweep(q,w);
        await this.attachments.expire(q,w);
        const work = (
          await q.query(
            "SELECT * FROM cloud.work_queue WHERE workspace_id=$1 AND completed_at IS NULL ORDER BY room_id,event_id LIMIT 100 FOR UPDATE SKIP LOCKED",
            [w],
          )
        ).rows;
        for (const row of work) {
          await q.query(
            "UPDATE cloud.work_queue SET attempts=attempts+1 WHERE workspace_id=$1 AND room_id=$2 AND event_id=$3",
            [w, row.room_id, row.event_id],
          );
          if (this.hooks?.workerFault === "before_complete")
            throw new CloudError("unavailable", 503);
          await q.query(
            "UPDATE cloud.work_queue SET completed_at=clock_timestamp() WHERE workspace_id=$1 AND room_id=$2 AND event_id=$3",
            [w, row.room_id, row.event_id],
          );
          if (!this.hooks?.dropNotify)
            await q.query("SELECT pg_notify('cloud_wakeup',$1)", [
              JSON.stringify({ workspace_id: w, room_id: row.room_id }),
            ]);
        }
      });
      if (this.hooks?.workerFault === "after_commit")
        throw new CloudError("unavailable", 503);
    }
  }
}
