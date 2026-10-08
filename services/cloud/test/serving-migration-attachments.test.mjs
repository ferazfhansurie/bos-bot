import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  mkdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { fixture } from "../fixture.ts";
import { migrate, inventory, mappedId } from "../migrate/tool.mjs";
import {
  attachmentContext,
  objectStore,
  ownedPath,
  planAttachments,
} from "../migrate/attachments.mjs";
import { LocalObjects } from "../objects.ts";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("fictional png body"),
]);
const TXT = Buffer.from("fictional text attachment\n");
const BIG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(10485760 - 7),
]);
const install = "fictional-attachments",
  w = "attachment_fixture";
const legacyDir = "/fictional/home/.openmausbot/attachments/";
const img = (name, mime = "image/png") => ({
  kind: "image",
  path: legacyDir + name,
  mime,
});
const MESSAGES = [
  ["served", { attachments: [img("a.png"), { path: "attachments/b.txt", mime: "text/plain" }] }],
  ["missing", { attachments: [img("a.png"), img("gone.png")] }],
  ["symlink", { attachments: [img("link.png")] }],
  ["outside", { attachments: [{ kind: "image", path: "/fictional/elsewhere/a.png", mime: "image/png" }] }],
  ["traversal", { attachments: [{ kind: "image", path: "attachments/../a.png", mime: "image/png" }] }],
  ["mismatch", { attachments: [img("a.png", "image/jpeg")] }],
  ["gif", { attachments: [img("a.png", "image/gif")] }],
  ["big", { attachments: [img("big.png")] }],
  ["empty", { attachments: [img("empty.png")] }],
  ["deleted", { attachments: [img("a.png")], deleted: true }],
  ["plain", {}],
];
const EXPECTED = {
  missing: "attachment_missing",
  symlink: "attachment_unsafe",
  outside: "attachment_outside_owned_tree",
  traversal: "attachment_outside_owned_tree",
  mismatch: "attachment_type_mismatch",
  gif: "attachment_unsupported_type",
  big: "attachment_too_large",
  empty: "attachment_empty",
};

async function scenario(fn) {
  const root = await mkdtemp(join(tmpdir(), "bos-attachment-migration-")),
    f = await fixture(false);
  const c = new pg.Client({ connectionString: f.migration_url });
  await c.connect();
  try {
    await c.query(
      await readFile(new URL("../migrate/schema.sql", import.meta.url), "utf8"),
    );
    await writeFile(
      join(root, ".bos-migration-copy.json"),
      JSON.stringify({ source_install_id: install }),
    );
    const room = { id: "legacy-room", name: "fictional", threadId: "legacy-thread" };
    await writeFile(join(root, "groups.json"), JSON.stringify([room]));
    await writeFile(
      join(root, "multiplayer-actors.json"),
      JSON.stringify({
        version: 1,
        bindings: [{ sessionId: "s1", personId: "fixture:person:alice", name: "fictional alice" }],
      }),
    );
    await writeFile(
      join(root, "workspace-membership.json"),
      JSON.stringify({ version: 1, ownerId: "fixture:person:alice", members: [], roomBotGrants: [] }),
    );
    const db = new DatabaseSync(join(root, "messages.db"));
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT)");
    MESSAGES.forEach(([id, extra], n) =>
      db.prepare("INSERT INTO messages VALUES(?,?,?)").run(
        room.threadId,
        id,
        JSON.stringify({
          id,
          role: "user",
          kind: "text",
          sender: { id: "fixture:person:alice" },
          text: "fictional " + id,
          at: 1000 + n,
          ...extra,
        }),
      ),
    );
    db.close();
    const a = join(root, "attachments");
    await mkdir(a);
    await writeFile(join(a, "a.png"), PNG);
    await writeFile(join(a, "b.txt"), TXT);
    await writeFile(join(a, "big.png"), BIG);
    await writeFile(join(a, "empty.png"), "");
    await symlink(join(a, "a.png"), join(a, "link.png"));
    const inv = await inventory(root),
      evidence = (type, id) => ({
        type,
        id,
        digest: inv.records.find((r) => r.type === type && r.id === id).digest,
      });
    const token = f.issuer.signin("fictional_alice_attachments").bearer,
      alice = { ...(await f.service.identify(token)), token };
    const plan = {
      version: 1,
      source_install_id: install,
      source_digest: inv.digest,
      reviewed_current_grants: true,
      reviewer: "fixture operator",
      name: "fictional attachment migration",
      members: [
        { account_id: alice.account_id, role: "owner", evidence: evidence("membership", "fixture:person:alice") },
      ],
      authors: [
        {
          source_author: "human:fixture:person:alice",
          account_id: alice.account_id,
          issuer: alice.issuer,
          subject: alice.subject,
          evidence: evidence("actor", "fixture:person:alice"),
        },
      ],
      rooms: [{ source_id: room.id, evidence: evidence("room", room.id), thread_ids: [room.threadId], grants: [] }],
    };
    const objects = join(f.fixture_directory, "objects");
    for (const action of ["inventory", "freeze", "import", "validate"])
      await migrate(c, root, w, action);
    await fn({
      f,
      c,
      root,
      plan,
      alice,
      objects,
      r: mappedId(install, "room", room.id),
      t: mappedId(install, "thread", room.threadId),
      message: (id) => mappedId(install, "message", JSON.stringify([room.threadId, id])),
      ref: (id, n) => JSON.stringify([JSON.stringify([room.threadId, id]), n]),
    });
  } finally {
    await c.end();
    await f.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root));
    await assert.rejects(stat(f.fixture_directory));
  }
}

async function reasons(c, type) {
  return Object.fromEntries(
    (
      await c.query(
        "SELECT source_id,reason FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type=$2",
        [w, type],
      )
    ).rows.map((r) => [r.source_id, r.reason]),
  );
}
const stored = async (dir) =>
  (await readdir(dir).catch(() => [])).filter((n) => n.startsWith(w + "|")).sort();

test("legacy references resolve only inside the owned flat attachments tree", () => {
  assert.deepEqual(ownedPath({ path: legacyDir + "x.png" }), { rel: "attachments/x.png" });
  assert.deepEqual(ownedPath({ path: "attachments/x.png" }), { rel: "attachments/x.png" });
  for (const path of [
    "/fictional/x.png",
    "attachments/../x.png",
    "nested/attachments/x.png",
    legacyDir + "../x.png",
    "/fictional/attachments/sub/x.png",
  ])
    assert.deepEqual(ownedPath({ path }), { outside: true }, path);
  for (const v of [undefined, {}, { path: "" }, { path: "a\0b" }]) assert.equal(ownedPath(v), null);
  assert.equal(objectStore(undefined), null);
  assert.throws(() => objectStore("relative/objects"), /absolute/);
  for (const p of ["", "/attachments", "/objects", "/../.bos-bot/x"])
    assert.throws(() => objectStore(join(homedir(), ".bos-bot") + p), /legacy data dir/);
});

test("a byte change after inventory is a hash mismatch, never a guess", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bos-attachment-hash-"));
  try {
    await mkdir(join(dir, "attachments"));
    await writeFile(join(dir, "attachments", "a.png"), PNG);
    const reference = img("a.png");
    const inv = {
      source_install_id: install,
      records: [
        { type: "attachment_file", id: "attachments/a.png", encoded: JSON.stringify({ path: "attachments/a.png", size: PNG.length, checksum: "0".repeat(64) }) },
        { type: "attachment_reference", id: JSON.stringify(["m", 0]), encoded: JSON.stringify({ message_source_id: "m", reference }) },
      ],
    };
    const store = new LocalObjects(join(dir, "objects"));
    const verdict = await planAttachments(attachmentContext(inv, dir, store), "message", "m", { attachments: [reference] });
    assert.equal(verdict.reason, "attachment_hash_mismatch");
    const rejected = await planAttachments(
      attachmentContext({ ...inv, records: [{ ...inv.records[0], encoded: JSON.stringify({ path: "attachments/a.png", size: PNG.length, checksum: sha(PNG) }) }, inv.records[1]] }, dir, store, async () => "rejected"),
      "message",
      "m",
      { attachments: [reference] },
    );
    assert.equal(rejected.reason, "attachment_scan_rejected");
    assert.equal((await planAttachments(attachmentContext(inv, dir, null), "message", "m", { attachments: [reference] })).reason, "attachment_requires_verified_transfer");
    await assert.rejects(stat(join(dir, "objects")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment transfer: verified ready objects bound to the message, specific quarantine, idempotent rerun, rollback removes bytes, readback after cutover", async () =>
  scenario(async ({ f, c, root, plan, alice, objects, r, t, message, ref }) => {
    // Without a configured store nothing is transferred (unchanged behavior).
    const none = await migrate(c, root, w, "project", { plan });
    assert.equal((await reasons(c, "message"))[JSON.stringify(["legacy-thread", "served"])], "attachment_requires_verified_transfer");
    assert.equal(none.messages, 1); // only the message without references
    await migrate(c, root, w, "rollback");
    for (const action of ["inventory", "freeze", "import", "validate"])
      await migrate(c, root, w, action);

    const p = await migrate(c, root, w, "project", { plan, objectStorePath: objects });
    assert.equal(p.messages, 3); // served + deleted tombstone + plain
    const quarantined = await reasons(c, "message");
    for (const [id, reason] of Object.entries(EXPECTED))
      assert.equal(quarantined[JSON.stringify(["legacy-thread", id])], reason, id);
    const refs = await reasons(c, "attachment_reference");
    assert.equal(refs[ref("served", 0)], undefined);
    assert.equal(refs[ref("served", 1)], undefined);
    assert.equal(refs[ref("missing", 0)], "inert_source_requires_review");
    assert.equal(refs[ref("missing", 1)], "attachment_missing");
    assert.equal(refs[ref("deleted", 0)], "attachment_of_deleted_message");
    const files = await reasons(c, "attachment_file");
    assert.equal(files["attachments/a.png"], undefined);
    assert.equal(files["attachments/link.png"], "inert_source_requires_review");

    const rows = (await c.query("SELECT * FROM cloud.attachment_objects WHERE workspace_id=$1 ORDER BY name", [w])).rows;
    assert.deepEqual(
      rows.map((v) => [v.name, v.type, Number(v.size), v.checksum, v.state, v.attached, v.room_id, v.thread_id, v.owner_id]),
      [
        ["a.png", "image/png", PNG.length, sha(PNG), "ready", true, r, t, alice.account_id],
        ["b.txt", "text/plain", TXT.length, sha(TXT), "ready", true, r, t, alice.account_id],
      ],
    );
    const ids = [mappedId(install, "attachment_reference", ref("served", 0)), mappedId(install, "attachment_reference", ref("served", 1))];
    for (const v of rows) assert.equal(v.object_key, `${w}|${r}|${v.attachment_id}`);
    const servedRow = (await c.query("SELECT attachment_ids FROM cloud.messages WHERE workspace_id=$1 AND message_id=$2", [w, message("served")])).rows[0];
    assert.deepEqual(servedRow.attachment_ids, ids);
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.message_attachments WHERE workspace_id=$1 AND message_id=$2", [w, message("served")])).rows[0].n, 2);
    const deleted = (await c.query("SELECT text,deleted,attachment_ids FROM cloud.messages WHERE workspace_id=$1 AND message_id=$2", [w, message("deleted")])).rows[0];
    assert.deepEqual([deleted.text, deleted.deleted, deleted.attachment_ids], ["", true, []]);
    const keys = await stored(objects);
    assert.deepEqual(keys, rows.map((v) => v.object_key).sort());
    for (const v of rows) assert.equal(sha(await readFile(join(objects, v.object_key))), v.checksum);

    const repeat = await migrate(c, root, w, "project", { plan, objectStorePath: objects });
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.projection_digest, p.projection_digest);
    assert.equal(repeat.attachments, 2);
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.attachment_objects")).rows[0].n, 2);
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.invocations")).rows[0].n, 0);
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.work_queue")).rows[0].n, 0);

    // Bytes are verified, not trusted: tampering or a missing store fails closed.
    await assert.rejects(migrate(c, root, w, "verify-projection"), /object store required/);
    await writeFile(join(objects, rows[0].object_key), "tampered");
    await assert.rejects(migrate(c, root, w, "verify-projection", { objectStorePath: objects }), /integrity mismatch/);
    await assert.rejects(migrate(c, root, w, "project", { plan, objectStorePath: objects }), /integrity mismatch/);

    // Pre-cutover rollback removes rows and every byte under the workspace prefix,
    // including a crash leftover that never got a row.
    await writeFile(join(objects, `${w}|${r}|crash-leftover`), "orphan");
    await writeFile(join(objects, `other_workspace|${r}|kept`), "other tenant");
    await assert.rejects(migrate(c, root, w, "rollback"), /object store required/);
    await migrate(c, root, w, "rollback", { objectStorePath: objects });
    assert.deepEqual(await stored(objects), []);
    assert.ok(await stat(join(objects, `other_workspace|${r}|kept`)));
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.attachment_objects")).rows[0].n, 0);

    // A second import is identical: same ids, keys, digests.
    for (const action of ["inventory", "freeze", "import", "validate"])
      await migrate(c, root, w, action);
    // An identical object left behind by an interrupted projection is reused.
    await mkdir(objects, { recursive: true });
    await writeFile(join(objects, rows[1].object_key), TXT);
    const again = await migrate(c, root, w, "project", { plan, objectStorePath: objects });
    assert.equal(again.idempotent, false);
    assert.equal(again.projection_digest, p.projection_digest);
    assert.equal(again.quarantine_digest, p.quarantine_digest);
    assert.deepEqual(await stored(objects), keys);

    // Still invisible before cutover, downloadable by the owner after it.
    await assert.rejects(f.service.attachments.metadata(alice.token, w, ids[0]));
    const verified = await migrate(c, root, w, "verify-projection", { objectStorePath: objects });
    assert.equal(verified.attachments, 2);
    assert.equal(verified.attachment_bytes, PNG.length + TXT.length);
    await migrate(c, root, w, "cutover", {
      acceptance: { ...verified, reviewer: "independent fixture reader", evidence_digest: sha("fictional readback") },
    });
    const snap = await f.service.snapshot(alice.token, w, r, { thread_id: t });
    assert.deepEqual(snap.messages.find((m) => m.message_id === message("served")).attachment_ids, ids);
    for (const [id, bytes] of [[ids[0], PNG], [ids[1], TXT]]) {
      const res = await fetch(f.url + `/v2/workspaces/${w}/attachments/${id}/download`, {
        headers: { authorization: "Bearer " + alice.token },
      });
      assert.equal(res.status, 200);
      assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(bytes));
    }
    // Attached migrated objects never expire as orphans.
    await f.service.db.tx(alice.account_id, w, (q) => f.service.attachments.expire(q, w));
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.attachment_objects WHERE state='ready'")).rows[0].n, 2);
    await assert.rejects(migrate(c, root, w, "rollback", { objectStorePath: objects }), /forward repair/);
    assert.deepEqual(await stored(objects), keys);
    assert.equal((await c.query("SELECT count(*)::int n FROM cloud.invocations")).rows[0].n, 0);
  }));
