import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { WebSocket } from "ws";
import pg from "pg";
import { fixture } from "../fixture.ts";
import { Database } from "../db.ts";
import { CloudService } from "../service.ts";
import {
  SnapshotSchema,
  LookupSchema,
  FrameSchema,
  MessageSchema,
  canonicalJson,
} from "../../../shared/cloud-protocol/index.ts";
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
  // Fault tests advance the real SQL worker explicitly, without a competing timer.
  f = await fixture(false);
});
after(async () => {
  if (f) await f.stop();
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function request(
  method: string,
  path: string,
  token?: string,
  value?: unknown,
) {
  const response = await fetch(f.url + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function ok(
  method: string,
  path: string,
  token?: string,
  value?: unknown,
) {
  const r = await request(method, path, token, value);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body;
}
let serial = 0;
async function humans(role = "member") {
  const a = await ok("POST", "/v2/test/sign-in", undefined, {
      subject: "fictional_alice_" + ++serial,
    }),
    b = await ok("POST", "/v2/test/sign-in", undefined, {
      subject: "fictional_bob_" + serial,
    });
  const w = (
    await ok("POST", "/v2/workspaces", a.bearer, {
      name: "fictional workspace",
    })
  ).workspace_id;
  const r = await ok("POST", `/v2/workspaces/${w}/rooms`, a.bearer, {
    name: "fictional room",
  });
  const invite = await ok("POST", `/v2/workspaces/${w}/invites`, a.bearer, {
    role,
    room_ids: [r.room_id],
  });
  await ok("POST", "/v2/invites/redeem", b.bearer, { token: invite.token });
  const s = await ok(
    "POST",
    `/v2/workspaces/${w}/rooms/${r.room_id}/snapshot`,
    a.bearer,
    { thread_id: r.thread_id },
  );
  return { a, b, w, r, s };
}
async function envelope(
  h: any,
  actor = h.a,
  text = "fictional exact 🦊\n@plain",
) {
  const win = await ok(
    "POST",
    `/v2/workspaces/${h.w}/operation-windows`,
    actor.bearer,
    {},
  );
  const s = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    actor.bearer,
    { thread_id: h.r.thread_id },
  );
  return {
    kind: "message.send",
    namespace: win.namespace,
    client_operation_id: win.window_id + "." + randomBytes(16).toString("hex"),
    window_token: win.window_token,
    room_id: h.r.room_id,
    thread_id: h.r.thread_id,
    text,
    mentions: [],
    attachment_ids: [],
    reply_to_message_id: null,
    expected_policy_revision: s.policy_revision,
  };
}
async function entered(id: string) {
  for (let n = 0; n < 100; n++) {
    if (f.hooks.state().find((g) => g.id === id)?.entered) return;
    await pause(5);
  }
  throw new Error("barrier not entered " + id);
}
async function sqlAdmin(query: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: f.migration_url });
  await c.connect();
  try {
    return await c.query(query, values);
  } finally {
    await c.end();
  }
}
test("fresh postgres uses non-owner no-bypass app role and tenant/private RLS fails closed", async () => {
  const h = await humans(),
    other = await humans();
  const sent = await ok(
    "POST",
    `/v2/workspaces/${other.w}/messages`,
    other.a.bearer,
    await envelope(other),
  );
  assert.equal(sent.status, "accepted");
  const c = await f.service.db.pool.connect();
  try {
    const role = (
      await c.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(role.current_user, "cloud_app");
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    assert.equal((await c.query("SELECT * FROM cloud.messages")).rowCount, 0);
  } finally {
    c.release();
  }
  await f.service.db.tx(h.a.account_id, h.w, async (q) => {
    assert.equal(
      (
        await q.query("SELECT * FROM cloud.messages WHERE workspace_id=$1", [
          other.w,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await q.query("SELECT * FROM cloud.operations WHERE workspace_id=$1", [
          other.w,
        ])
      ).rowCount,
      0,
    );
  });
  await assert.rejects(
    f.service.db.tx(h.a.account_id, h.w, (q) =>
      q.query(
        "INSERT INTO cloud.rooms(workspace_id,room_id,name) VALUES($1,$2,$3)",
        [other.w, "foreign", "sentinel"],
      ),
    ),
    (e: any) => e.code === "42501",
  );
  await assert.rejects(
    f.service.db.tx(h.a.account_id, h.w, (q) =>
      q.query(
        "INSERT INTO cloud.threads(workspace_id,room_id,thread_id) VALUES($1,$2,$3)",
        [h.w, other.r.room_id, "foreign"],
      ),
    ),
    (e: any) => e.code === "23503",
  );
});
test("two stub humans sign in, invite, redeem and exchange exact text through HTTP + actual WS", async () => {
  const h = await humans();
  SnapshotSchema.parse(h.s);
  const ws = new WebSocket(f.ws_url);
  f.hooks.dropNotify = true;
  try {
    const frames: any[] = [];
    ws.on("message", (raw) =>
      frames.push(FrameSchema.parse(JSON.parse(raw.toString()))),
    );
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "authenticate", bearer: h.b.bearer }));
    ws.send(
      JSON.stringify({
        type: "subscribe",
        workspace_id: h.w,
        room_id: h.r.room_id,
        thread_id: h.r.thread_id,
        cursor: null,
      }),
    );
    const e = await envelope(h),
      accepted = await ok(
        "POST",
        `/v2/workspaces/${h.w}/messages`,
        h.a.bearer,
        e,
      );
    LookupSchema.parse(accepted);
    assert.equal(accepted.status, "accepted");
    const e2 = await envelope(h, h.b, "fictional reply"),
      accepted2 = await ok(
        "POST",
        `/v2/workspaces/${h.w}/messages`,
        h.b.bearer,
        e2,
      );
    assert.equal(accepted2.status, "accepted");
    for (
      let n = 0;
      n < 100 &&
      !frames.some(
        (v) =>
          v.type === "event_batch" &&
          v.events.some(
            (x: any) => x.payload.message?.message_id === accepted2.message_id,
          ),
      );
      n++
    )
      await pause(20);
    const remote = await ok(
      "POST",
      `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
      h.b.bearer,
      { thread_id: h.r.thread_id },
    );
    assert.deepEqual(
      remote.messages.map((m: any) => m.text),
      [e.text, e2.text],
    );
    remote.messages.forEach((m: any) => MessageSchema.parse(m));
    assert(
      frames.some(
        (v) =>
          v.type === "event_batch" &&
          v.events.some((x: any) => x.payload.message?.text === e2.text),
      ),
      JSON.stringify(frames.map((v) => ({ type: v.type, error: v.error }))),
    );
  } finally {
    f.hooks.dropNotify = false;
    ws.terminate();
  }
});
test("identical retries/lookup survive replaced service object; changed digest conflicts; other actor gets no receipt", async () => {
  const h = await humans(),
    e = await envelope(h);
  const url = `/v2/workspaces/${h.w}/messages`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ok("POST", url, h.a.bearer, e)),
  );
  assert.equal(new Set(results.map((r) => r.message_id)).size, 1);
  const found = await ok(
    "GET",
    `/v2/workspaces/${h.w}/operations/${e.client_operation_id}`,
    h.a.bearer,
  );
  assert.deepEqual(found, results[0]);
  assert.equal(
    found.digest,
    createHash("sha256").update(canonicalJson(e)).digest("hex"),
  );
  const changed = await request("POST", url, h.a.bearer, {
    ...e,
    text: e.text + "!",
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "operation_conflict");
  const other = await ok(
    "GET",
    `/v2/workspaces/${h.w}/operations/${e.client_operation_id}`,
    h.b.bearer,
  );
  assert.equal(other.status, "recovery_unknown");
  const replacement = new CloudService(
    new Database(f.database_url),
    f.issuer,
    f.url,
    f.service.key,
  );
  try {
    assert.deepEqual(
      await replacement.lookup(h.a.bearer, h.w, e.client_operation_id),
      found,
    );
  } finally {
    await replacement.db.close();
  }
  const history = await ok(
    "GET",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/history?thread_id=${h.r.thread_id}`,
    h.a.bearer,
  );
  assert.equal(history.messages.length, 1);
});
for (const action of ["message.send", "operation.seal"]) {
  test(`digest-selected ${action} hooks isolate changed envelopes with the same key`, async () => {
    const h = await humans(),
      loser = await envelope(h),
      winner = { ...loser, text: loser.text + "!" };
    const digest = (e: unknown) =>
      createHash("sha256").update(canonicalJson(e)).digest("hex");
    const control = async (name: string, body?: unknown, method = "POST") => {
      const response = await fetch(f.url + "/v2/test/hooks" + name, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Cloud-Fixture-Secret": f.hook_secret,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const match = {
      workspace_id: h.w,
      room_id: h.r.room_id,
      account_id: h.a.account_id,
      client_operation_id: loser.client_operation_id,
    };
    const before = "digest_loser",
      after = "digest_winner";
    await control("/arm", {
      id: before,
      point: action + ".before_admission",
      match: { ...match, digest: digest(loser) },
    });
    await control("/arm", {
      id: after,
      point: action + ".after_admission",
      match: { ...match, digest: digest(winner) },
    });
    const path =
      action === "message.send"
        ? `/v2/workspaces/${h.w}/messages`
        : `/v2/workspaces/${h.w}/operations/${loser.client_operation_id}/resolve-not-accepted`;
    const pending = [request("POST", path, h.a.bearer, loser)];
    try {
      await entered(before);
      pending.push(request("POST", path, h.a.bearer, winner));
      await entered(after);
      const state = await control("", undefined, "GET");
      for (const id of [before, after]) {
        assert.deepEqual(
          state.gates.find((g: any) => g.id === id),
          {
            id,
            point:
              action +
              (id === before ? ".before_admission" : ".after_admission"),
            entered: true,
            waiting: 1,
          },
        );
      }
      await control("/release", { id: after });
      const accepted = await pending[1];
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.digest, digest(winner));
      assert.equal(
        accepted.body.status,
        action === "message.send" ? "accepted" : "rejected",
      );
      assert.equal((await control("", undefined, "GET")).gates[0].waiting, 1);
      await control("/release", { id: before });
      const conflict = await pending[0];
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error, "operation_conflict");
      assert.deepEqual(
        await ok(
          "GET",
          `/v2/workspaces/${h.w}/operations/${loser.client_operation_id}`,
          h.a.bearer,
        ),
        accepted.body,
      );
    } finally {
      await control("/release", { id: before });
      await control("/release", { id: after });
      await Promise.allSettled(pending);
    }
  });
}
test("send vs seal uses the same real admission lock in both orders x100", async () => {
  const h = await humans();
  for (const winner of ["message.send", "operation.seal"])
    for (let n = 0; n < 100; n++) {
      const e = await envelope(h);
      const gate = "race_" + winner.replace(".", "_") + "_" + n;
      f.hooks.arm(gate, winner + ".after_admission", {
        client_operation_id: e.client_operation_id,
      });
      const send = () =>
        ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
      const seal = () =>
        ok(
          "POST",
          `/v2/workspaces/${h.w}/operations/${e.client_operation_id}/resolve-not-accepted`,
          h.a.bearer,
          e,
        );
      const first = winner === "message.send" ? send() : seal();
      await entered(gate);
      const second = winner === "message.send" ? seal() : send();
      await pause(2);
      f.hooks.release(gate);
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual(a, b);
      assert.equal(
        a.status,
        winner === "message.send" ? "accepted" : "rejected",
      );
    }
});
test("expiry is evaluated inside authority lock; retained acceptance wins expiry; old epoch absence cannot seal", async () => {
  const h = await humans(),
    e = await envelope(h),
    e2 = await envelope(h);
  await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e2);
  await sqlAdmin(
    "UPDATE cloud.windows SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE workspace_id=$1 AND window_id=$2",
    [h.w, e.client_operation_id.split(".")[0]],
  );
  f.hooks.arm("expiry_lock", "read.after_admission", { workspace_id: h.w });
  const blocker = f.service.protect(
    h.a.bearer,
    h.w,
    h.r.room_id,
    "read",
    {},
    async () => ({ ok: true }),
  );
  await entered("expiry_lock");
  const waiting = ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
  await pause(200);
  f.hooks.release("expiry_lock");
  await blocker;
  const expired = await waiting;
  assert.equal(expired.reason, "operation_expired");
  await sqlAdmin(
    "UPDATE cloud.windows SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    [h.w],
  );
  assert.equal(
    (await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e2)).status,
    "accepted",
  );
  const missing = await envelope(h);
  await sqlAdmin("UPDATE cloud.workspaces SET epoch=$2 WHERE workspace_id=$1", [
    h.w,
    "new_epoch",
  ]);
  assert.equal(
    (
      await ok(
        "POST",
        `/v2/workspaces/${h.w}/operations/${missing.client_operation_id}/resolve-not-accepted`,
        h.a.bearer,
        missing,
      )
    ).status,
    "recovery_unknown",
  );
});
test("window swap, bot/attachment/foreign mention, policy revision fail closed with terminal tombstones", async () => {
  const h = await humans();
  for (const patch of [
    { attachment_ids: ["fictional_attachment"] },
    { mentions: [{ kind: "bot", id: "fictional_bot", start: 0, end: 1 }] },
    { mentions: [{ kind: "human", id: "foreign_human", start: 0, end: 1 }] },
    { expected_policy_revision: "0" },
  ]) {
    const e = { ...(await envelope(h)), ...patch };
    const receipt = await ok(
      "POST",
      `/v2/workspaces/${h.w}/messages`,
      h.a.bearer,
      e,
    );
    assert.equal(receipt.status, "rejected");
    assert.deepEqual(
      await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e),
      receipt,
    );
  }
  const e = await envelope(h),
    newer = await envelope(h);
  assert.equal(
    (
      await request("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, {
        ...e,
        window_token: newer.window_token,
      })
    ).body.error,
    "operation_conflict",
  );
});
test("revocation denies subsequent send, read, snapshot page, lookup and stream publication; guest only granted room", async () => {
  const h = await humans("guest"),
    extra = await ok("POST", `/v2/workspaces/${h.w}/rooms`, h.a.bearer, {
      name: "other room",
    });
  assert.equal(
    (
      await request(
        "POST",
        `/v2/workspaces/${h.w}/rooms/${extra.room_id}/snapshot`,
        h.b.bearer,
        { thread_id: extra.thread_id },
      )
    ).status,
    403,
  );
  const discovery = await ok("GET", "/v2/discovery/sync", h.b.bearer);
  assert.equal(discovery.workspaces[0].rooms.length, 1);
  const s = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    h.b.bearer,
    { thread_id: h.r.thread_id },
  );
  const e = await envelope(h, h.b);
  await ok(
    "DELETE",
    `/v2/workspaces/${h.w}/members/${h.b.account_id}`,
    h.a.bearer,
  );
  for (const [method, path, value] of [
    ["POST", `/v2/workspaces/${h.w}/messages`, e],
    [
      "POST",
      `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/read`,
      { thread_id: h.r.thread_id, intervals: [] },
    ],
    [
      "GET",
      `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshots/${s.snapshot_id}`,
      undefined,
    ],
    [
      "GET",
      `/v2/workspaces/${h.w}/operations/${e.client_operation_id}`,
      undefined,
    ],
  ] as const)
    assert.equal((await request(method, path, h.b.bearer, value)).status, 403);
  assert.deepEqual(
    (await ok("GET", "/v2/discovery/sync", h.b.bearer)).workspaces,
    [],
  );
});
test("removal races actual send in both orders, and paused snapshot/publication reauthorizes", async () => {
  for (const winner of ["message.send", "member.remove"]) {
    const h = await humans(),
      e = await envelope(h, h.b),
      gate = "remove_" + winner.replace(".", "_");
    f.hooks.arm(gate, winner + ".after_admission", { workspace_id: h.w });
    const send = () =>
        request("POST", `/v2/workspaces/${h.w}/messages`, h.b.bearer, e),
      remove = () =>
        ok(
          "DELETE",
          `/v2/workspaces/${h.w}/members/${h.b.account_id}`,
          h.a.bearer,
        );
    const first = winner === "message.send" ? send() : remove();
    await entered(gate);
    const second = winner === "message.send" ? remove() : send();
    await pause(2);
    f.hooks.release(gate);
    await Promise.all([first, second]);
    const rows = (
      await sqlAdmin("SELECT * FROM cloud.messages WHERE workspace_id=$1", [
        h.w,
      ])
    ).rows;
    assert.equal(rows.length, winner === "message.send" ? 1 : 0);
  }
  for (const action of ["snapshot.page", "realtime.publication"]) {
    const h = await humans(),
      s = await f.service.snapshot(h.b.bearer, h.w, h.r.room_id, {
        thread_id: h.r.thread_id,
      });
    f.hooks.arm("protected_read", action + ".before_admission", {
      workspace_id: h.w,
    });
    let delivered = false;
    const pending =
      action === "snapshot.page"
        ? f.service.snapshotPage(h.b.bearer, h.w, h.r.room_id, s.snapshot_id)
        : f.service.replay(
            h.b.bearer,
            h.w,
            h.r.room_id,
            { thread_id: h.r.thread_id, cursor: s.cursor },
            () => {
              delivered = true;
            },
          );
    const rejection = assert.rejects(
      pending,
      (e: any) => e.code === "forbidden",
    );
    await entered("protected_read");
    await ok(
      "DELETE",
      `/v2/workspaces/${h.w}/members/${h.b.account_id}`,
      h.a.bearer,
    );
    f.hooks.release("protected_read");
    await rejection;
    assert.equal(delivered, false);
  }
});
test("single-use invites, expiry/revoke, double-redeem and concurrent last-owner removals", async () => {
  const h = await humans("owner");
  const c = await ok("POST", "/v2/test/sign-in", undefined, {
      subject: "fictional_charlie_" + ++serial,
    }),
    d = await ok("POST", "/v2/test/sign-in", undefined, {
      subject: "fictional_dana_" + serial,
    });
  const inv = await ok("POST", `/v2/workspaces/${h.w}/invites`, h.a.bearer, {
    role: "member",
    room_ids: [h.r.room_id],
  });
  const attempts = await Promise.all([
    request("POST", "/v2/invites/redeem", c.bearer, { token: inv.token }),
    request("POST", "/v2/invites/redeem", d.bearer, { token: inv.token }),
  ]);
  assert.equal(attempts.filter((r) => r.status === 200).length, 1);
  assert.equal(
    attempts.filter((r) => r.body.error === "invite_used").length,
    1,
  );
  const inv2 = await ok("POST", `/v2/workspaces/${h.w}/invites`, h.a.bearer, {
    role: "member",
    room_ids: [h.r.room_id],
  });
  await ok(
    "DELETE",
    `/v2/workspaces/${h.w}/invites/${inv2.invite_id}`,
    h.a.bearer,
  );
  assert.equal(
    (
      await request("POST", "/v2/invites/preview", c.bearer, {
        token: inv2.token,
      })
    ).body.error,
    "invite_revoked",
  );
  const inv3 = await ok("POST", `/v2/workspaces/${h.w}/invites`, h.a.bearer, {
    role: "member",
    room_ids: [h.r.room_id],
  });
  await sqlAdmin(
    "UPDATE cloud.invites SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND invite_id=$2",
    [h.w, inv3.invite_id],
  );
  assert.equal(
    (
      await request("POST", "/v2/invites/redeem", c.bearer, {
        token: inv3.token,
      })
    ).body.error,
    "invite_expired",
  );
  await Promise.all([
    request(
      "DELETE",
      `/v2/workspaces/${h.w}/members/${h.a.account_id}`,
      h.a.bearer,
    ),
    request(
      "DELETE",
      `/v2/workspaces/${h.w}/members/${h.b.account_id}`,
      h.b.bearer,
    ),
  ]);
  assert.equal(
    (
      await sqlAdmin(
        "SELECT count(*)::int AS n FROM cloud.members WHERE workspace_id=$1 AND role='owner'",
        [h.w],
      )
    ).rows[0].n,
    1,
  );
});
test("snapshot pinned at H, replay after H, filtered gaps, expired snapshot and foreign cursor reset safely", async () => {
  const h = await humans();
  const s = await f.service.snapshot(h.a.bearer, h.w, h.r.room_id, {
      thread_id: h.r.thread_id,
    }),
    e = await envelope(h);
  await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
  const pinned = await ok(
    "GET",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshots/${s.snapshot_id}`,
    h.a.bearer,
  );
  assert.equal(pinned.watermark, s.watermark);
  assert.equal(pinned.messages.length, 0);
  const replay = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/replay`,
    h.a.bearer,
    { thread_id: h.r.thread_id, cursor: s.cursor, snapshot_id: s.snapshot_id },
  );
  FrameSchema.parse(replay);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.live, true);
  const reset = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/replay`,
    h.b.bearer,
    { thread_id: h.r.thread_id, cursor: s.cursor },
  );
  assert.equal(reset.type, "reset_required");
  assert.equal(reset.snapshot.messages.length, 1);
  await sqlAdmin(
    "UPDATE cloud.snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    [h.w],
  );
  assert.equal(
    (
      await request(
        "GET",
        `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshots/${s.snapshot_id}`,
        h.a.bearer,
      )
    ).body.error,
    "snapshot_expired",
  );
});
test("private coverage merges, preserves unseen gaps, rejects unacknowledged marks and remains private", async () => {
  const h = await humans();
  for (let n = 0; n < 4; n++)
    await ok(
      "POST",
      `/v2/workspaces/${h.w}/messages`,
      h.a.bearer,
      await envelope(h),
    );
  const s = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    h.b.bearer,
    { thread_id: h.r.thread_id },
  );
  const head = s.messages[3].sequence,
    lo = s.messages[1].sequence;
  const route = `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/read`;
  const read = await ok("POST", route, h.b.bearer, {
    thread_id: h.r.thread_id,
    intervals: [[lo, head]],
    attention: true,
  });
  assert.equal(read.prefix, "0");
  assert.deepEqual(read.intervals, [[lo, head]]);
  const a = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    h.a.bearer,
    { thread_id: h.r.thread_id },
  );
  assert.deepEqual(a.read, { prefix: "0", intervals: [], attention: false });
  assert.equal(
    (
      await request("POST", route, h.b.bearer, {
        thread_id: h.r.thread_id,
        intervals: [],
        mark_read_through: String(BigInt(head) + 1n),
      })
    ).body.error,
    "invalid_request",
  );
  const marked = await ok("POST", route, h.b.bearer, {
    thread_id: h.r.thread_id,
    intervals: [],
    mark_read_through: head,
  });
  assert.equal(marked.prefix, head);
  assert.deepEqual(marked.intervals, []);
  await f.service.db.tx(h.a.account_id, h.w, async (q) =>
    assert.equal(
      (
        await q.query("SELECT * FROM cloud.read_coverage WHERE account_id=$1", [
          h.b.account_id,
        ])
      ).rowCount,
      0,
    ),
  );
});
test("durable outbox/SQL queue commits once; rollback and after-commit faults recover; lost NOTIFY cannot lose stream", async () => {
  f.hooks.pausedWorker = true;
  const h = await humans();
  const e = await envelope(h);
  await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
  const before = (
    await sqlAdmin("SELECT * FROM cloud.work_queue WHERE workspace_id=$1", [
      h.w,
    ])
  ).rows;
  assert(before.some((r) => r.completed_at === null));
  f.hooks.pausedWorker = false;
  f.hooks.workerFault = "before_complete";
  await assert.rejects(f.service.tickWorker());
  assert.equal(
    (
      await sqlAdmin(
        "SELECT count(*)::int AS n FROM cloud.work_queue WHERE workspace_id=$1 AND completed_at IS NULL",
        [h.w],
      )
    ).rows[0].n,
    before.length,
  );
  f.hooks.workerFault = "after_commit";
  f.hooks.dropNotify = true;
  await assert.rejects(f.service.tickWorker());
  f.hooks.workerFault = "none";
  await f.service.tickWorker();
  assert.equal(
    (
      await sqlAdmin(
        "SELECT count(*)::int AS n FROM cloud.work_queue WHERE workspace_id=$1 AND completed_at IS NULL",
        [h.w],
      )
    ).rows[0].n,
    0,
  );
  const replay = await f.service.replay(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
    cursor: null,
  });
  assert.equal(replay.snapshot!.messages.length, 1);
  f.hooks.dropNotify = false;
});
test("identity outage/revoked session fail closed, ignored actor headers and bounded fixture hook auth", async () => {
  const h = await humans(),
    e = await envelope(h);
  f.issuer.unavailable = true;
  try {
    assert.equal(
      (await request("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e))
        .body.error,
      "identity_unavailable",
    );
  } finally {
    f.issuer.unavailable = false;
  }
  f.issuer.revoked.add(h.b.bearer);
  assert.equal(
    (await request("GET", "/v2/discovery/sync", h.b.bearer)).status,
    401,
  );
  assert.equal((await request("GET", "/v2/test/hooks")).status, 403);
  for (const value of ["wrong", "x".repeat(f.hook_secret.length)]) {
    const response = await fetch(f.url + "/v2/test/hooks", {
      headers: { "X-Cloud-Fixture-Secret": value },
    });
    assert.equal(response.status, 403);
  }
  const response = await fetch(f.url + `/v2/workspaces/${h.w}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Account-Id": h.a.account_id,
      "X-Role": "owner",
    },
    body: JSON.stringify(e),
  });
  assert.equal(response.status, 401);
});

test("discovery admits its full replacement while current workspace locks are held", async () => {
  const h = await humans();
  const frames: any[] = [];
  await (f.service.discovery as any)(h.b.bearer, (value: any) =>
    frames.push(value),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].workspaces[0].workspace_id, h.w);
  await ok(
    "DELETE",
    `/v2/workspaces/${h.w}/members/${h.b.account_id}`,
    h.a.bearer,
  );
  frames.length = 0;
  await (f.service.discovery as any)(h.b.bearer, (value: any) =>
    frames.push(value),
  );
  assert.deepEqual(frames, [{ workspaces: [] }]);
});

test("socket inbound aggregate is bounded while authoritative authentication stalls", async () => {
  const a = await ok("POST", "/v2/test/sign-in", undefined, {
    subject: "fictional_inbound_" + ++serial,
  });
  f.issuer.stallMs = 1000;
  const ws = new WebSocket(f.ws_url);
  const closed = new Promise<number>((r) =>
    ws.once("close", (code) => r(code)),
  );
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "authenticate", bearer: a.bearer }));
  for (let n = 0; n < 20; n++)
    ws.send(
      JSON.stringify({
        type: "invalid",
        fictional_padding: "x".repeat(100000),
      }),
    );
  const timer = setTimeout(() => ws.terminate(), 2500);
  try {
    assert.equal(await closed, 1013);
  } finally {
    clearTimeout(timer);
    f.issuer.stallMs = 0;
    ws.terminate();
  }
});

test("exact 64KiB text is admitted even when JSON escaping is six bytes per character", async () => {
  const h = await humans(),
    e = await envelope(h, h.a, "\u0000".repeat(65536));
  const accepted = await ok(
    "POST",
    `/v2/workspaces/${h.w}/messages`,
    h.a.bearer,
    e,
  );
  assert.equal(accepted.status, "accepted");
  const history = await ok(
    "GET",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/history?thread_id=${h.r.thread_id}`,
    h.b.bearer,
  );
  assert.equal(history.messages[0].text, e.text);
});

test("filtered empty replay advances decimal cursor past other-thread events without number rounding", async () => {
  const h = await humans(),
    other = "fictional_other_thread";
  await sqlAdmin(
    "INSERT INTO cloud.threads(workspace_id,room_id,thread_id) VALUES($1,$2,$3)",
    [h.w, h.r.room_id, other],
  );
  await sqlAdmin(
    "UPDATE cloud.rooms SET head=$3 WHERE workspace_id=$1 AND room_id=$2",
    [h.w, h.r.room_id, "9007199254740993"],
  );
  const s = await f.service.snapshot(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
  });
  const e = await envelope(h);
  e.thread_id = other;
  const accepted = await ok(
    "POST",
    `/v2/workspaces/${h.w}/messages`,
    h.a.bearer,
    e,
  );
  assert.equal(accepted.sequence, "9007199254740994");
  const frame = await f.service.replay(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
    cursor: s.cursor,
  });
  assert.equal(frame.type, "event_batch");
  assert.deepEqual(frame.events, []);
  assert.equal(frame.scanned_sequence, "9007199254740994");
  assert.equal(frame.live, true);
});
test("sparse read limit rejects conservatively without overwriting prior coverage", async () => {
  const h = await humans();
  await sqlAdmin(
    "UPDATE cloud.rooms SET head=1000 WHERE workspace_id=$1 AND room_id=$2",
    [h.w, h.r.room_id],
  );
  await f.service.snapshot(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
  });
  const route = `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/read`,
    intervals = Array.from({ length: 256 }, (_, n) => [
      String(2 + n * 2),
      String(2 + n * 2),
    ]);
  const before = await ok("POST", route, h.b.bearer, {
    thread_id: h.r.thread_id,
    intervals,
  });
  assert.equal(before.intervals.length, 256);
  assert.equal(
    (
      await request("POST", route, h.b.bearer, {
        thread_id: h.r.thread_id,
        intervals: [["514", "514"]],
      })
    ).body.error,
    "read_coverage_limit",
  );
  const after = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    h.b.bearer,
    { thread_id: h.r.thread_id },
  );
  assert.deepEqual(after.read, before);
});
test("oversized realtime reset closes recoverably; HTTP snapshot still recovers canonical projection", async () => {
  const h = await humans(),
    e = await envelope(h, h.a, "x".repeat(65536));
  for (let n = 0; n < 17; n++)
    await f.service.operation(h.a.bearer, h.w, {
      ...e,
      client_operation_id:
        e.client_operation_id.split(".")[0] +
        "." +
        randomBytes(16).toString("hex"),
    });
  const ws = new WebSocket(f.ws_url);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const closed = new Promise<number>((r) =>
    ws.once("close", (code) => r(code)),
  );
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "authenticate", bearer: h.b.bearer }));
  ws.send(
    JSON.stringify({
      type: "subscribe",
      workspace_id: h.w,
      room_id: h.r.room_id,
      thread_id: h.r.thread_id,
      cursor: null,
    }),
  );
  const timer = setTimeout(() => ws.terminate(), 3000);
  try {
    assert.equal(await closed, 1013);
    assert(
      frames.some(
        (v) =>
          v.type === "reset_required" && v.reason === "overflow" && !v.snapshot,
      ),
    );
  } finally {
    clearTimeout(timer);
    ws.terminate();
  }
  const snapshot = await ok(
    "POST",
    `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,
    h.b.bearer,
    { thread_id: h.r.thread_id },
  );
  assert.equal(snapshot.messages.length, 17);
});

test("startup rejects a runtime role that can bypass RLS", async () => {
  await (f.service.db as any).assertRole();
  await sqlAdmin("ALTER ROLE cloud_app BYPASSRLS");
  try {
    await assert.rejects((f.service.db as any).assertRole(), /non-owner RLS/);
  } finally {
    await sqlAdmin("ALTER ROLE cloud_app NOBYPASSRLS");
  }
});

test("reply foreign key cannot connect a different canonical thread", async () => {
  const h = await humans(),
    e = await envelope(h),
    parent = await f.service.operation(h.a.bearer, h.w, e),
    other = "fictional_reply_thread";
  await sqlAdmin(
    "INSERT INTO cloud.threads(workspace_id,room_id,thread_id) VALUES($1,$2,$3)",
    [h.w, h.r.room_id, other],
  );
  await assert.rejects(
    f.service.db.tx(h.a.account_id, h.w, (q) =>
      q.query(
        "INSERT INTO cloud.messages(workspace_id,room_id,thread_id,message_id,actor_id,client_operation_id,sequence,text,mentions,reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          h.w,
          h.r.room_id,
          other,
          "foreign_reply",
          h.a.account_id,
          "fixture_invalid_operation",
          "1000",
          JSON.stringify("fictional invalid reply"),
          "[]",
          parent.message_id,
        ],
      ),
    ),
    (e: any) => e.code === "23503",
  );
});

test("secret-gated HTTP hooks schedule admission, expiry, redelivery and epoch tests", async () => {
  const h = await humans(),
    e = await envelope(h);
  const control = async (action: string, value?: unknown, method = "POST") => {
    const response = await fetch(
      f.url + "/v2/test/hooks" + (action ? "/" + action : ""),
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Cloud-Fixture-Secret": f.hook_secret,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  await control("control", { worker_paused: true, drop_notify: true });
  try {
    await control("arm", {
      id: "http_admission",
      point: "message.send.after_admission",
      match: { client_operation_id: e.client_operation_id },
    });
    const send = ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
    await entered("http_admission");
    assert(
      (await control("", undefined, "GET")).gates.some(
        (g: any) => g.id === "http_admission" && g.entered,
      ),
    );
    await control("release", { id: "http_admission" });
    assert.equal((await send).status, "accepted");
    const rows = await control("queue-state", { workspace_id: h.w });
    assert(rows.length > 0);
    await control("control", { worker_paused: false });
    await f.service.tickWorker();
    await control("redeliver", {
      workspace_id: h.w,
      room_id: rows[0].room_id,
      event_id: rows[0].event_id,
    });
    await f.service.tickWorker();
    assert.equal(
      (await control("queue-state", { workspace_id: h.w })).length,
      rows.length,
    );
    const expired = await envelope(h);
    await control("expire-window", {
      workspace_id: h.w,
      account_id: h.a.account_id,
      window_id: expired.client_operation_id.split(".")[0],
      after_ms: 0,
    });
    assert.equal(
      (await ok("POST", `/v2/workspaces/${h.w}/messages`, h.a.bearer, expired))
        .reason,
      "operation_expired",
    );
    await control("expire-snapshot", {
      workspace_id: h.w,
      account_id: h.a.account_id,
      snapshot_id: h.s.snapshot_id,
    });
    assert.equal(
      (
        await request(
          "GET",
          `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshots/${h.s.snapshot_id}`,
          h.a.bearer,
        )
      ).body.error,
      "snapshot_expired",
    );
    const missing = await envelope(h);
    await control("rotate-epoch", { workspace_id: h.w });
    assert.equal(
      (
        await ok(
          "GET",
          `/v2/workspaces/${h.w}/operations/${missing.client_operation_id}`,
          h.a.bearer,
        )
      ).status,
      "recovery_unknown",
    );
  } finally {
    await control("control", {
      worker_paused: false,
      drop_notify: false,
      worker_fault: "none",
      issuer_unavailable: false,
      issuer_stall_ms: 0,
    });
  }
});

test("invite preview publishes under the invite authority lock and does not redeem", async () => {
  const h = await humans();
  const inv = await ok("POST", `/v2/workspaces/${h.w}/invites`, h.a.bearer, {
    role: "guest",
    room_ids: [h.r.room_id],
  });
  const viewer = await ok("POST", "/v2/test/sign-in", undefined, {
    subject: "fictional_preview_" + ++serial,
  });
  const values: any[] = [];
  await (f.service.inviteAction as any)(
    viewer.bearer,
    { token: inv.token },
    false,
    (value: any) => values.push(value),
  );
  assert.equal(values.length, 1);
  assert.equal(values[0].workspace_id, h.w);
  const redeemed = await ok("POST", "/v2/invites/redeem", viewer.bearer, {
    token: inv.token,
  });
  assert.equal(redeemed.role, "guest");
});

test("protected publication cannot outlive the validated identity assertion", async () => {
  const h = await humans(),
    s = await f.service.snapshot(h.b.bearer, h.w, h.r.room_id, {
      thread_id: h.r.thread_id,
    });
  const original = f.issuer.assertion.bind(f.issuer);
  let delivered = false;
  f.issuer.assertion = (subject) => {
    const value = original(subject);
    return { ...value, expires_at: value.validated_at + 50 };
  };
  try {
    f.hooks.arm("assertion_deadline", "realtime.publication.after_admission", {
      workspace_id: h.w,
    });
    const pending = f.service.replay(
      h.b.bearer,
      h.w,
      h.r.room_id,
      { thread_id: h.r.thread_id, cursor: s.cursor },
      () => {
        delivered = true;
      },
    );
    const result = assert.rejects(
      pending,
      (e: any) => e.code === "identity_unavailable",
    );
    await entered("assertion_deadline");
    await pause(80);
    f.hooks.release("assertion_deadline");
    await result;
    assert.equal(delivered, false);
  } finally {
    f.issuer.assertion = original;
    f.hooks.release("assertion_deadline");
  }
});

test("catch-up frontier stays pinned while new writes arrive between replay pages", async () => {
  const h = await humans(),
    s = await f.service.snapshot(h.b.bearer, h.w, h.r.room_id, {
      thread_id: h.r.thread_id,
    }),
    e = await envelope(h);
  const send = () =>
    f.service.operation(h.a.bearer, h.w, {
      ...e,
      client_operation_id:
        e.client_operation_id.split(".")[0] +
        "." +
        randomBytes(16).toString("hex"),
    });
  for (let n = 0; n < 101; n++) await send();
  const first = await f.service.replay(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
    cursor: s.cursor,
    snapshot_id: s.snapshot_id,
  });
  assert.equal(first.live, false);
  assert.equal(first.events?.length, 100);
  for (let n = 0; n < 20; n++) await send();
  const last = await f.service.replay(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
    cursor: first.cursor!,
    snapshot_id: s.snapshot_id,
  });
  assert.equal(last.frontier, first.frontier);
  assert.equal(last.events?.length, 1);
  assert.equal(last.live, true);
  const live = await f.service.replay(h.b.bearer, h.w, h.r.room_id, {
    thread_id: h.r.thread_id,
    cursor: last.cursor!,
  });
  assert.equal(live.events?.length, 20);
  assert.equal(live.live, true);
});

test("expired assertion rolls back a protected mutation before commit", async () => {
  const h = await humans(),
    original = f.issuer.assertion.bind(f.issuer);
  f.issuer.assertion = (subject) => {
    const value = original(subject);
    return { ...value, expires_at: value.validated_at + 50 };
  };
  try {
    await assert.rejects(
      f.service.protect(
        h.a.bearer,
        h.w,
        undefined,
        "room.create",
        {},
        async (q) => {
          await q.query(
            "INSERT INTO cloud.rooms(workspace_id,room_id,name) VALUES($1,$2,$3)",
            [h.w, "fictional_expired_room", "expired assertion"],
          );
          await pause(80);
          return { room_id: "fictional_expired_room" };
        },
      ),
      (e: any) => e.code === "identity_unavailable",
    );
    assert.equal(
      (
        await sqlAdmin(
          "SELECT 1 FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2",
          [h.w, "fictional_expired_room"],
        )
      ).rowCount,
      0,
    );
  } finally {
    f.issuer.assertion = original;
  }
});

test("normal fixture automatically completes persisted queue work", async () => {
  const automatic = await fixture();
  try {
    const actor = automatic.issuer.signin("fictional_automatic_worker");
    const workspace = await automatic.service.createWorkspace(actor.bearer, {
      name: "fictional automatic worker",
    });
    const room = await automatic.service.createRoom(
      actor.bearer,
      workspace.workspace_id,
      { name: "fictional room" },
    );
    const window = await automatic.service.window(
      actor.bearer,
      workspace.workspace_id,
    );
    const receipt = await automatic.service.operation(
      actor.bearer,
      workspace.workspace_id,
      {
        kind: "message.send",
        namespace: window.namespace,
        client_operation_id:
          window.window_id + "." + randomBytes(16).toString("hex"),
        window_token: window.window_token,
        room_id: room.room_id,
        thread_id: room.thread_id,
        text: "fictional automatic queue work",
        mentions: [],
        attachment_ids: [],
        reply_to_message_id: null,
        expected_policy_revision: room.policy_revision,
      },
    );
    assert.equal(receipt.status, "accepted");
    let complete = false;
    for (let n = 0; n < 100; n++) {
      const state = await automatic.service.db.tx(
        "worker",
        workspace.workspace_id,
        async (q) =>
          (await q.query("SELECT completed_at FROM cloud.work_queue")).rows,
      );
      if (state.length > 0 && state.every((row) => row.completed_at !== null)) {
        complete = true;
        break;
      }
      await pause(50);
    }
    assert.equal(complete, true);
  } finally {
    await automatic.stop();
  }
});

test('invite publication failure reaps invite, grants and transactional publication outbox', async () => {
  const h = await humans();
  const before = (await sqlAdmin('SELECT count(*)::int AS n FROM cloud.invites WHERE workspace_id=$1',[h.w])).rows[0].n;
  await assert.rejects(f.service.invite(h.a.bearer,h.w,{role:'member',room_ids:[h.r.room_id]},()=>{throw new Error('publication failed');}), /publication failed/);
  const after = (await sqlAdmin('SELECT count(*)::int AS n FROM cloud.invites WHERE workspace_id=$1',[h.w])).rows[0].n;
  assert.equal(after,before);
  assert.equal((await sqlAdmin("SELECT count(*)::int AS n FROM cloud.invite_outbox WHERE workspace_id=$1 AND publication_state='pending'",[h.w])).rows[0].n,0);
});

test('revocation between invite insertion and publication reaps pending intent without granting access', async () => {
  const h=await humans();
  f.hooks.arm('invite_publish_revoke','http.publication.before_admission',{workspace_id:h.w});
  let delivered=false;
  const pending=f.service.invite(h.a.bearer,h.w,{role:'member',room_ids:[h.r.room_id]},()=>{delivered=true;});
  const rejection=assert.rejects(pending,{code:'unauthenticated'});
  await entered('invite_publish_revoke');
  f.issuer.revoked.add(h.a.bearer);
  f.hooks.release('invite_publish_revoke');
  await rejection;
  assert.equal(delivered,false);
  assert.equal((await sqlAdmin("SELECT count(*)::int AS n FROM cloud.invite_outbox WHERE workspace_id=$1 AND publication_state='pending'",[h.w])).rows[0].n,0);
});

test('crashed invite publication is unusable and reaped by durable worker; published invites survive', async () => {
  const h=await humans();
  const invite=await f.service.invite(h.a.bearer,h.w,{role:'member',room_ids:[h.r.room_id]});
  await sqlAdmin("UPDATE cloud.invite_outbox SET publication_state='pending',created_at=clock_timestamp()-interval '16 seconds' WHERE workspace_id=$1 AND invite_id=$2",[h.w,invite.invite_id]);
  await assert.rejects(f.service.inviteAction(h.b.bearer,{token:invite.token},false),{code:'unavailable'});
  await f.service.tickWorker();
  assert.equal((await sqlAdmin('SELECT count(*)::int AS n FROM cloud.invites WHERE workspace_id=$1 AND invite_id=$2',[h.w,invite.invite_id])).rows[0].n,0);
  assert.equal((await sqlAdmin("SELECT count(*)::int AS n FROM cloud.invite_outbox WHERE workspace_id=$1 AND publication_state='published'",[h.w])).rows[0].n,1);
});

test('native bearer websocket can authenticate with ambient cookies and no browser Origin', async () => {
  const h=await humans();
  const ws=new WebSocket(f.ws_url,{headers:{cookie:'unrelated=ambient'}});
  try {
    await new Promise<void>((r,j)=>{ws.once('open',r);ws.once('error',j);});
    const response=new Promise<any>((r,j)=>{ws.once('message',raw=>r(JSON.parse(raw.toString())));ws.once('error',j);});
    ws.send(JSON.stringify({type:'authenticate',bearer:h.b.bearer}));
    assert.equal((await response).type,'heartbeat');
  } finally {ws.terminate();}
});
