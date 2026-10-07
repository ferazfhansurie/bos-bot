import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { fixture } from "../fixture.ts";
import { migrate, inventory, mappedId } from "../migrate/tool.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
async function scenario(fn) {
  const root = await mkdtemp(join(tmpdir(), "bos-serving-migration-")),
    f = await fixture(false);
  const c = new pg.Client({ connectionString: f.migration_url });
  await c.connect();
  try {
    await c.query(
      await readFile(new URL("../migrate/schema.sql", import.meta.url), "utf8"),
    );
    const install = "fictional-serving",
      w = "migration_fixture";
    await writeFile(
      join(root, ".bos-migration-copy.json"),
      JSON.stringify({ source_install_id: install }),
    );
    const room = {
      id: "legacy-room",
      name: "fictional",
      threadId: "legacy-thread",
      tasks: [{ threadId: "json-thread" }],
      peopleIds: ["fixture:person:guest"],
    };
    await writeFile(join(root, "groups.json"), JSON.stringify([room]));
    await writeFile(
      join(root, "multiplayer-actors.json"),
      JSON.stringify({
        version: 1,
        bindings: [
          {
            sessionId: "s1",
            personId: "fixture:person:alice",
            name: "fictional alice",
          },
          {
            sessionId: "s2",
            personId: "fixture:person:guest",
            name: "fictional guest",
          },
        ],
      }),
    );
    await writeFile(
      join(root, "workspace-membership.json"),
      JSON.stringify({
        version: 1,
        ownerId: "fixture:person:alice",
        members: [{ actorId: "fixture:person:guest", role: "client-guest" }],
        roomBotGrants: [],
      }),
    );
    await writeFile(
      join(root, "shared-rooms.json"),
      JSON.stringify({
        version: 1,
        rooms: [
          {
            room: {
              id: "shared-room",
              homeId: "fixture",
              name: "shared fixture",
              memberIds: ["fixture:person:alice", "fixture:person:guest"],
            },
            messages: [
              {
                id: "shared-first",
                roomId: "shared-room",
                sequence: 1,
                actor: { homeId: "fixture", kind: "person", localId: "alice" },
                text: "shared @api\n\u0000\ud800",
                at: 1000,
                sendId: "shared-send",
              },
              {
                id: "shared-deleted",
                roomId: "shared-room",
                sequence: 2,
                actor: { homeId: "fixture", kind: "person", localId: "guest" },
                text: "private deleted",
                at: 1001,
                deletedAt: 1002,
                replyTo: "shared-first",
                sendId: "shared-delete",
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      join(root, "work-runtime.json"),
      JSON.stringify([{ id: "pending-run", state: "running" }]),
    );
    const messages = [
      {
        id: "z",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:alice", name: "fictional alice" },
        text: "first\n\u0000\ud800",
        at: 300,
      },
      {
        id: "a",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:alice", name: "fictional alice" },
        text: "second",
        at: 100,
        replyToId: "z",
        version: 3,
      },
      {
        id: "tombstone",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:alice", name: "fictional alice" },
        text: "redacted",
        deleted: true,
        at: 400,
      },
      {
        id: "conflict",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:alice" },
        text: "sqlite version",
        at: 500,
      },
      {
        id: "unknown",
        role: "user",
        kind: "text",
        text: "unknown author",
        at: 600,
      },
      {
        id: "no-grant",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:guest" },
        text: "guest without room grant",
        at: 700,
      },
      {
        id: "attachment",
        role: "user",
        kind: "text",
        sender: { id: "fixture:person:alice" },
        text: "file",
        attachments: [{ path: "attachments/f.png" }],
        at: 800,
      },
      {
        id: "card",
        role: "bot",
        kind: "secret",
        text: "must remain inert",
        at: 900,
      },
    ];
    const db = new DatabaseSync(join(root, "messages.db"));
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT)");
    for (const m of messages)
      db.prepare("INSERT INTO messages VALUES(?,?,?)").run(
        room.threadId,
        m.id,
        JSON.stringify(m),
      );
    db.close();
    const only = {
      id: "json-only",
      role: "user",
      kind: "text",
      sender: { id: "fixture:person:alice" },
      text: "json only",
      at: 1000,
    };
    await writeFile(
      join(root, "messages-" + room.threadId + ".json"),
      JSON.stringify({
        messages: [
          ...messages.slice(0, 3),
          { ...messages[3], text: "conflicting JSON" },
          {
            id: "stale-extra",
            role: "user",
            kind: "text",
            sender: { id: "fixture:person:alice" },
            text: "must quarantine",
            at: 1001,
          },
        ],
        activeLeafId: "conflict",
      }),
    );
    await writeFile(
      join(root, "messages-json-thread.json"),
      JSON.stringify([only]),
    );
    await mkdir(join(root, "attachments"));
    await writeFile(join(root, "attachments", "f.png"), "fixture");
    await writeFile(join(root, "attachments", "orphan.partial"), "orphan");
    await symlink("/never-read-external", join(root, "attachments", "outside"));
    const inv = await inventory(root),
      evidence = (type, id) => {
        const r = inv.records.find((r) => r.type === type && r.id === id);
        return { type, id, digest: r.digest };
      };
    const signin = async (subject) => {
      const token = f.issuer.signin(subject).bearer;
      const me = await f.service.identify(token);
      return { ...me, token };
    };
    const alice = await signin("fictional_alice_migration"),
      guest = await signin("fictional_guest_migration");
    const plan = {
      version: 1,
      source_install_id: install,
      source_digest: inv.digest,
      reviewed_current_grants: true,
      reviewer: "fixture operator",
      name: "fictional migration",
      members: [
        {
          account_id: alice.account_id,
          role: "owner",
          evidence: evidence("membership", "fixture:person:alice"),
        },
        {
          account_id: guest.account_id,
          role: "guest",
          evidence: evidence("membership", "fixture:person:guest"),
        },
      ],
      authors: [
        {
          source_author: "human:fixture:person:alice",
          account_id: alice.account_id,
          issuer: alice.issuer,
          subject: alice.subject,
          evidence: evidence("actor", "fixture:person:alice"),
        },
        {
          source_author: "human:fixture:person:guest",
          account_id: guest.account_id,
          issuer: guest.issuer,
          subject: guest.subject,
          evidence: evidence("actor", "fixture:person:guest"),
        },
      ],
      rooms: [
        {
          source_id: room.id,
          evidence: evidence("room", room.id),
          thread_ids: [room.threadId, "json-thread"],
          grants: [],
        },
      ],
    };
    const r = mappedId(install, "room", room.id),
      t = mappedId(install, "thread", room.threadId);
    for (const action of ["inventory", "freeze", "import", "validate"])
      await migrate(c, root, w, action);
    await fn({ f, c, root, w, inv, plan, r, t, alice, guest, evidence });
  } finally {
    await c.end();
    await f.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root));
    await assert.rejects(stat(f.fixture_directory));
  }
}
test("serving migration: complete inventory, explicit identities/grants, RLS staging, exact history, cutover event and archive", async () =>
  scenario(async ({ f, c, root, w, inv, plan, r, t, alice, guest }) => {
    assert.equal(
      inv.records.filter((r) => r.type === "attachment_file").length,
      3,
    );
    assert.equal(
      inv.records.filter((r) => r.type === "transcript_file").length,
      2,
    );
    assert.equal(inv.conflicts.length, 2);
    assert.equal(inv.records.filter((r) => r.type === "message").length, 10);
    await assert.rejects(migrate(c, root, w, "cutover"), /projection/);
    const p = await migrate(c, root, w, "project", { plan });
    assert.equal(p.messages, 4);
    const repeat = await migrate(c, root, w, "project", { plan });
    assert.equal(repeat.projection_digest, p.projection_digest);
    assert.equal(repeat.idempotent, true);
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: { ...plan, reviewer: "different" },
      }),
      /conflict/,
    );
    assert.deepEqual((await f.service.discovery(alice.token)).workspaces, []);
    await assert.rejects(
      f.service.snapshot(alice.token, w, r, { thread_id: t }),
      (e) => e.code === "forbidden",
    );
    assert.equal(
      (
        await fetch(f.url + `/v2/workspaces/${w}/rooms/${r}/snapshot`, {
          method: "POST",
          headers: {
            authorization: "Bearer " + alice.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ thread_id: t }),
        })
      ).status,
      403,
    );
    assert.equal(
      await f.service.db.tx(
        alice.account_id,
        w,
        async (q) =>
          (
            await q.query(
              "SELECT * FROM cloud.messages WHERE workspace_id=$1",
              [w],
            )
          ).rowCount,
      ),
      0,
    );
    await assert.rejects(
      f.service.db.tx(alice.account_id, w, (q) =>
        q.query(
          "UPDATE cloud.migration_authority SET state='active' WHERE workspace_id=$1",
          [w],
        ),
      ),
      /permission denied/,
    );
    await assert.rejects(
      f.service.db.tx(alice.account_id, w, (q) =>
        q.query("SELECT * FROM migration.legacy_records"),
      ),
      /permission denied/,
    );
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.invocations")).rows[0].n,
      "0",
    );
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.work_queue")).rows[0].n,
      "0",
    );
    // Independent readback through a second connection, bound to the accepted digests.
    const verified = await migrate(c, root, w, "verify-projection");
    const independent = new pg.Client({ connectionString: f.migration_url });
    await independent.connect();
    try {
      const rows = (
        await independent.query(
          "SELECT text,version,deleted,reply_to_message_id FROM cloud.messages WHERE workspace_id=$1 ORDER BY sequence",
          [w],
        )
      ).rows;
      assert.deepEqual(
        rows.map((m) => m.text),
        ["first\n\u0000\ud800", "second", "", "json only"],
      );
      assert.equal(rows[1].version, 3);
      assert.ok(rows[1].reply_to_message_id);
      assert.equal(rows[2].deleted, true);
    } finally {
      await independent.end();
    }
    await assert.rejects(migrate(c, root, w, "cutover"), /acceptance/);
    const acceptance = {
      ...verified,
      reviewer: "independent fixture reader",
      evidence_digest: hash("fictional readback evidence"),
    };
    await assert.rejects(
      migrate(c, root, w, "cutover", {
        acceptance: { ...acceptance, source_digest: hash("wrong") },
      }),
      /acceptance/,
    );
    assert.equal(
      (await migrate(c, root, w, "cutover", { acceptance })).epoch,
      "2",
    );
    await migrate(c, root, w, "cutover"); // no duplicate event on retry
    assert.equal((await f.service.discovery(alice.token)).workspaces.length, 1);
    const snap = await f.service.snapshot(alice.token, w, r, { thread_id: t });
    assert.equal(snap.messages.length, 3);
    const http = await fetch(
      f.url + `/v2/workspaces/${w}/rooms/${r}/snapshot`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + alice.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ thread_id: t }),
      },
    );
    assert.equal(http.status, 200);
    assert.deepEqual(
      (await http.json()).messages.map((m) => m.text),
      ["first\n\u0000\ud800", "second", ""],
    );
    await assert.rejects(
      f.service.snapshot(guest.token, w, r, { thread_id: t }),
      (e) => e.code === "forbidden",
    );
    const cursor = f.service.verify(snap.cursor, "cursor");
    cursor.epoch = "1";
    assert.equal(
      (
        await f.service.replay(alice.token, w, r, {
          thread_id: t,
          cursor: f.service.sign(cursor),
        })
      ).type,
      "reset_required",
    );
    cursor.epoch = "2";
    cursor.sequence = "0";
    const replay = await f.service.replay(alice.token, w, r, {
      thread_id: t,
      cursor: f.service.sign(cursor),
    });
    assert.equal(replay.events.length, 1);
    assert.equal(replay.events[0].kind, "authority_changed");
    assert.deepEqual(replay.events[0].payload, {
      workspace_id: w,
      epoch: "2",
      reason: "migration_cutover",
    });
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.invocations")).rows[0].n,
      "0",
    );
    const events = await c.query("SELECT * FROM cloud.room_events");
    assert.equal(events.rowCount, 1);
    await assert.rejects(migrate(c, root, w, "rollback"), /forward repair/);
    await migrate(c, root, w, "archive");
    await migrate(c, root, w, "archive");
    assert.equal(
      JSON.parse(await readFile(join(root, "migration-archive.json"), "utf8"))
        .retained,
      true,
    );
    assert.equal(
      JSON.parse(await readFile(join(root, "cloud-authority.json"), "utf8"))
        .state,
      "legacy_archived",
    );
    assert.ok(await stat(join(root, "messages.db")));
    console.log(
      JSON.stringify({
        proof: "serving-migration",
        inventoried: inv.records.length,
        served: p.messages,
        quarantined: p.quarantine,
        projection_digest: p.projection_digest,
        acceptance: "second-connection exact readback",
        cleanup: "asserted in finally",
      }),
    );
  }));
test("projection rollback removes target and freeze, mismatched bindings and tampered serving rows fail closed", async () =>
  scenario(async ({ c, root, w, plan }) => {
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: {
          ...plan,
          authors: plan.authors.map((a) => ({ ...a, subject: "invented" })),
        },
      }),
      /issuer binding/,
    );
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.workspaces")).rows[0].n,
      "0",
    );
    await migrate(c, root, w, "project", { plan });
    await c.query(
      "UPDATE cloud.messages SET text='\"tampered\"' WHERE workspace_id=$1",
      [w],
    );
    await assert.rejects(
      migrate(c, root, w, "verify-projection"),
      /integrity mismatch/,
    );
    await migrate(c, root, w, "rollback");
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.workspaces")).rows[0].n,
      "0",
    );
    assert.equal(
      (await c.query("SELECT count(*) n FROM migration.legacy_records")).rows[0]
        .n,
      "0",
    );
    await assert.rejects(stat(join(root, "cloud-authority.json")));
    await migrate(c, root, w, "rollback"); // interrupted rollback completion is retryable
  }));
test("explicit guest grant is preserved; cutover recovers a committed database with an older frozen file", async () =>
  scenario(async ({ c, root, w, plan, alice, guest, f, r, t, inv }) => {
    const grant = {
      account_id: guest.account_id,
      evidence: plan.rooms[0].evidence,
    };
    plan.rooms[0].grants.push(grant);
    const p = await migrate(c, root, w, "project", { plan });
    assert.equal(p.messages, 5);
    const verified = await migrate(c, root, w, "verify-projection");
    const frozen = await readFile(join(root, "cloud-authority.json"));
    await migrate(c, root, w, "cutover", {
      acceptance: {
        ...verified,
        reviewer: "independent fixture reader",
        evidence_digest: hash("guest grant readback"),
      },
    });
    // Crash between DB commit and authority-file replacement remains legacy-frozen.
    await writeFile(join(root, "cloud-authority.json"), frozen);
    await migrate(c, root, w, "cutover");
    assert.equal(
      JSON.parse(await readFile(join(root, "cloud-authority.json"), "utf8"))
        .epoch,
      "2",
    );
    assert.equal(
      (await f.service.snapshot(guest.token, w, r, { thread_id: t })).messages
        .length,
      4,
    );
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.room_events")).rows[0].n,
      "1",
    );
    const before = await readFile(join(root, "groups.json"));
    await writeFile(join(root, "groups.json"), "[]");
    await assert.rejects(migrate(c, root, w, "archive"), /source changed/);
    await writeFile(join(root, "groups.json"), before);
    await migrate(c, root, w, "archive");
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.invocations")).rows[0].n,
      "0",
    );
  }));

test("legacy versioned registries and shared snapshots preserve explicit roles/grants and quarantine unconsolidated journals", async () =>
  scenario(async ({ c, root, w, plan, inv, evidence, f, alice, guest }) => {
    assert.equal(inv.records.filter((r) => r.type === "actor").length, 2);
    assert.equal(inv.records.filter((r) => r.type === "membership").length, 2);
    assert.equal(
      inv.records.filter((r) => r.type === "shared_message").length,
      2,
    );
    const source_id = "shared-room";
    const room = {
      source_type: "shared_room",
      source_id,
      evidence: evidence("shared_room", source_id),
      thread_ids: [source_id],
      grants: [
        {
          account_id: guest.account_id,
          evidence: evidence("shared_room", source_id),
        },
      ],
    };
    plan.rooms.push(room);
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: {
          ...plan,
          members: plan.members.map((m) => ({ ...m, role: "owner" })),
        },
      }),
      /role or actor binding/,
    );
    const malformed = structuredClone(plan);
    malformed.rooms[1].grants[0].evidence = plan.members[1].evidence;
    await assert.rejects(
      migrate(c, root, w, "project", { plan: malformed }),
      /grant evidence/,
    );
    const projected = await migrate(c, root, w, "project", { plan });
    assert.equal(projected.messages, 6);
    const shared = (
      await c.query(
        "SELECT text,deleted,reply_to_message_id FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 ORDER BY sequence",
        [w, mappedId(inv.source_install_id, "shared_room", source_id)],
      )
    ).rows;
    assert.deepEqual(
      shared.map((m) => m.text),
      ["shared @api\n\u0000\ud800", ""],
    );
    assert.equal(shared[1].deleted, true);
    assert.ok(shared[1].reply_to_message_id);
    assert.equal(
      (await c.query("SELECT count(*) n FROM cloud.invocations")).rows[0].n,
      "0",
    );
    await migrate(c, root, w, "rollback");
    await writeFile(
      join(root, "shared-rooms.json.events"),
      JSON.stringify({
        roomId: source_id,
        id: "journal-message",
        at: 1003,
        input: { text: "pending canonical append" },
      }) + "\n",
    );
    for (const action of ["inventory", "freeze", "import", "validate"])
      await migrate(c, root, w, action);
    const current = await inventory(root);
    plan.source_digest = current.digest;
    const quarantined = await migrate(c, root, w, "project", { plan });
    assert.equal(quarantined.messages, 4);
    assert.equal(
      (
        await c.query(
          "SELECT count(*) n FROM migration.migration_quarantine WHERE reason='shared_journal_requires_consolidation'",
        )
      ).rows[0].n,
      "2",
    );
    await migrate(c, root, w, "rollback");
  }));
