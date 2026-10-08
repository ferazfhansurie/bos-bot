// Generated reviewed manifest (migrate/plan.mjs) on a fictional install:
// owner/bot/retired-bot binding, private 1:1 bot rooms, payload classification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { fixture } from "../fixture.ts";
import { migrate, inventory, mappedId } from "../migrate/tool.mjs";
import { generatePlan } from "../migrate/plan.mjs";
import { payloadReason, retiredBotEvidence } from "../migrate/serving.mjs";

const OWNER = "home1:person:owner",
  PAT = "home1:person:pat",
  GUS = "home2:person:gus";
const msg = (id, extra) => ({ id, at: 1000 + id.length, kind: "text", ...extra });
const THREADS = {
  "bt-main": [
    msg("u1", { role: "user", text: "owner asks" }),
    msg("b1", { role: "bot", text: "live bot answers" }),
    msg("act", { role: "bot", kind: "activity", tool: { name: "Write", input: "{}" } }),
    msg("opt", { role: "bot", kind: "options", card: { title: "approve?" } }),
    msg("dig", { role: "bot", kind: "digest", text: "[digest] tools: Write", digest: { tools: [] } }),
    msg("rr", { role: "bot", kind: "routine.run", text: "routine completed", routineRun: { status: "completed" } }),
    msg("sec", { role: "bot", kind: "secret", text: "enter key", secret: { label: "key" } }),
  ],
  "bt-task": [msg("gone1", { role: "bot", text: "retired bot spoke", from: { botId: "bot-gone" } })],
  "room-thread": [
    msg("ru", { role: "user", text: "owner in room", sender: { id: OWNER } }),
    msg("rb", { role: "bot", text: "live in room", from: { botId: "bot-live" } }),
    msg("rg", { role: "bot", text: "retired in room", from: { botId: "bot-gone" } }),
    msg("rp", { role: "user", text: "pat in room", sender: { id: PAT } }),
    msg("rgus", { role: "user", text: "gus in room", sender: { id: GUS } }),
  ],
  "room-task": [
    msg("goal", { role: "bot", kind: "goal.run", text: "goal done", from: { botId: "bot-live" }, goalRun: { status: "done" } }),
    msg("exe", { role: "bot", text: "text with a tool", from: { botId: "bot-live" }, tool: { name: "Bash" } }),
  ],
  orphan: [msg("o1", { role: "user", text: "nobody owns this thread" })],
};
const servedText = [
  "owner asks",
  "live bot answers",
  "routine completed",
  "retired bot spoke",
  "owner in room",
  "live in room",
  "retired in room",
  "goal done",
  "shared by owner",
];

async function scenario(fn) {
  const root = await mkdtemp(join(tmpdir(), "bos-migration-plan-")),
    f = await fixture(false);
  const c = new pg.Client({ connectionString: f.migration_url });
  await c.connect();
  try {
    await c.query(await readFile(new URL("../migrate/schema.sql", import.meta.url), "utf8"));
    const install = "fictional-plan",
      w = "migration_plan_fixture";
    const put = (name, value) => writeFile(join(root, name), JSON.stringify(value));
    await put(".bos-migration-copy.json", { source_install_id: install });
    await put("bots.json", [
      {
        id: "bot-live",
        name: "fictional helper",
        threadId: "bt-main",
        tasks: [{ threadId: "bt-main" }, { threadId: "bt-task" }],
      },
      { id: "bot-idle", name: "fictional idle", threadId: "bt-empty", tasks: [] },
    ]);
    await put("groups.json", [
      {
        id: "room-1",
        name: "fictional room",
        threadId: "room-thread",
        tasks: [{ threadId: "room-thread" }, { threadId: "room-task" }],
        peopleIds: [GUS],
      },
    ]);
    await put("multiplayer-actors.json", {
      version: 1,
      bindings: [
        { sessionId: "s1", personId: PAT, name: "fictional pat" },
        { sessionId: "s2", personId: GUS, name: "fictional gus" },
      ],
    });
    await put("workspace-membership.json", {
      version: 1,
      ownerId: OWNER,
      members: [
        { actorId: PAT, role: "member" },
        { actorId: GUS, role: "client-guest" },
      ],
      roomBotGrants: [],
    });
    await put("shared-rooms.json", {
      version: 1,
      rooms: [
        {
          room: { id: "shared-1", homeId: "home1", name: "fictional shared", memberIds: [OWNER, PAT] },
          messages: [
            { id: "s1", roomId: "shared-1", actor: { homeId: "home1", kind: "person", localId: "owner" }, text: "shared by owner", at: 2000 },
            { id: "s2", roomId: "shared-1", actor: { homeId: "home1", kind: "person", localId: "pat" }, text: "shared by pat", at: 2001 },
          ],
        },
      ],
    });
    const db = new DatabaseSync(join(root, "messages.db"));
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT)");
    for (const [thread, list] of Object.entries(THREADS))
      for (const m of list) db.prepare("INSERT INTO messages VALUES(?,?,?)").run(thread, m.id, JSON.stringify(m));
    db.close();
    const signin = async (subject) => {
      const token = f.issuer.signin(subject).bearer;
      return { ...(await f.service.identify(token)), token };
    };
    const owner = await signin("fictional_owner_plan");
    const ownerRow = (await c.query("SELECT account_id,issuer,subject FROM cloud.accounts WHERE account_id=$1", [owner.account_id])).rows[0];
    for (const action of ["inventory", "freeze", "import", "validate"]) await migrate(c, root, w, action);
    const inv = await inventory(root);
    await fn({ f, c, root, w, inv, install, owner, ownerRow, signin });
  } finally {
    await c.end();
    await f.stop();
    await rm(root, { recursive: true, force: true });
  }
}

const reasons = async (c, w) =>
  Object.fromEntries(
    (
      await c.query(
        "SELECT reason,count(*)::int n FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type IN ('message','shared_message') GROUP BY 1 ORDER BY 1",
        [w],
      )
    ).rows.map((r) => [r.reason, r.n]),
  );

test("payload classification serves only plain text and keeps executable payloads out", () => {
  assert.equal(payloadReason({ role: "user", kind: "text", text: "x" }), null);
  assert.equal(payloadReason({ role: "bot", text: "x" }), null);
  assert.equal(payloadReason({ role: "bot", kind: "markdown", text: "x" }), null);
  assert.equal(payloadReason({ role: "bot", kind: "routine.run", text: "x", routineRun: {} }), null);
  assert.equal(payloadReason({ role: "bot", kind: "goal.run", text: "x", goalRun: {} }), null);
  assert.equal(payloadReason({ role: "bot", kind: "activity", tool: {} }), "legacy_tool_activity");
  assert.equal(payloadReason({ role: "bot", kind: "options", card: {} }), "legacy_approval_card");
  assert.equal(payloadReason({ role: "bot", kind: "secret", text: "x" }), "legacy_secret_request");
  assert.equal(payloadReason({ role: "bot", kind: "screen", png: "" }), "legacy_screen_capture");
  assert.equal(payloadReason({ role: "bot", kind: "digest", text: "x" }), "legacy_turn_receipt");
  assert.equal(payloadReason({ role: "bot", kind: "compaction" }), "legacy_turn_receipt");
  assert.equal(payloadReason({ role: "bot", kind: "text", text: "x", tool: {} }), "legacy_executable_payload");
  assert.equal(payloadReason({ role: "bot", kind: "routine.run", text: "x", card: {} }), "legacy_executable_payload");
  assert.equal(payloadReason({ role: "bot", kind: "connector", text: "x" }), "unsupported_legacy_payload");
  assert.equal(payloadReason({ role: "bot", kind: "text" }), "unsupported_legacy_payload");
  assert.equal(payloadReason({ role: "system", kind: "text", text: "x" }), "unsupported_legacy_payload");
  assert.equal(payloadReason({ role: null, text: "x" }), "unsupported_legacy_payload");
});

test("generated plan binds owner, live and retired bots, maps 1:1 bot threads to private rooms, and projects idempotently", async () =>
  scenario(async ({ c, root, w, inv, install, owner, ownerRow }) => {
    const { plan, summary } = generatePlan(inv, ownerRow, { reviewer: "fixture reviewer", name: "fictional" });
    // Deterministic: same inventory, same manifest.
    assert.deepEqual(generatePlan(await inventory(root), ownerRow, { reviewer: "fixture reviewer", name: "fictional" }).plan, plan);
    assert.deepEqual(summary.rooms, { room: 1, shared_room: 1, bot_threads: 1 });
    assert.equal(summary.authors.bot_live, 2);
    assert.equal(summary.authors.bot_retired, 1);
    assert.equal(summary.humans_left_out, 2);
    assert.equal(summary.threads_unmapped, 1);
    assert.deepEqual(plan.members.map((m) => m.role), ["owner"]);
    assert.ok(plan.authors.every((a) => a.account_id === owner.account_id));
    const retired = plan.authors.find((a) => a.source_author === "bot:bot-gone");
    assert.deepEqual(
      retired.evidence,
      retiredBotEvidence("bot-gone", [JSON.stringify(["bt-task", "gone1"]), JSON.stringify(["room-thread", "rg"])]),
    );
    const botRoom = plan.rooms.find((r) => r.source_type === "bot_threads");
    assert.equal(botRoom.source_id, "bot-live");
    assert.deepEqual(botRoom.thread_ids, ["bt-main", "bt-task"]);
    assert.deepEqual(botRoom.grants.map((g) => g.account_id), [owner.account_id]);
    // The room's own thread listed again in its tasks is not ambiguous.
    assert.deepEqual(plan.rooms.find((r) => r.source_type === "room").thread_ids, ["room-thread", "room-task"]);
    // Only the unstamped servable owner message needs a per-message binding.
    assert.deepEqual(
      plan.authors.filter((a) => a.source_author.startsWith("message:")).map((a) => a.source_author),
      ["message:" + JSON.stringify(["bt-main", "u1"])],
    );

    const p = await migrate(c, root, w, "project", { plan });
    assert.equal(p.messages, servedText.length);
    const again = await migrate(c, root, w, "project", { plan });
    assert.equal(again.idempotent, true);
    assert.equal(again.projection_digest, p.projection_digest);
    assert.deepEqual(await reasons(c, w), {
      legacy_approval_card: 1,
      legacy_executable_payload: 1,
      legacy_secret_request: 1,
      legacy_tool_activity: 1,
      legacy_turn_receipt: 1,
      unknown_author: 3,
      unmapped_room_or_thread: 1,
    });
    const served = (
      await c.query("SELECT room_id,thread_id,message_id,text,bot_id,actor_id FROM cloud.messages WHERE workspace_id=$1 ORDER BY room_id,sequence", [w])
    ).rows;
    assert.deepEqual(served.map((m) => m.text).sort(), [...servedText].sort());
    assert.ok(served.every((m) => m.actor_id === owner.account_id));
    const roomId = mappedId(install, "bot_threads", "bot-live");
    const room = (await c.query("SELECT name FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2", [w, roomId])).rows[0];
    assert.equal(room.name, "fictional helper");
    assert.deepEqual(
      (await c.query("SELECT account_id FROM cloud.room_grants WHERE workspace_id=$1 AND room_id=$2", [w, roomId])).rows.map((r) => r.account_id),
      [owner.account_id],
    );
    const byId = (thread, id) => served.find((m) => m.message_id === mappedId(install, "message", JSON.stringify([thread, id])));
    // Unstamped reply in the bot's own 1:1 thread carries that bot's provenance.
    assert.equal(byId("bt-main", "b1").bot_id, mappedId(install, "bot", "bot-live"));
    assert.equal(byId("bt-main", "b1").room_id, roomId);
    assert.equal(byId("bt-task", "gone1").bot_id, mappedId(install, "bot", "bot-gone"));
    assert.equal(byId("bt-main", "u1").bot_id, null);
    assert.equal(byId("bt-main", "rr").text, "routine completed");
    for (const table of ["invocations", "work_queue", "outbox", "room_events"])
      assert.equal((await c.query(`SELECT count(*) n FROM cloud.${table}`)).rows[0].n, "0");
    // Import is idempotent on the same copy.
    assert.deepEqual(await migrate(c, root, w, "import"), await migrate(c, root, w, "import"));
  }));

test("retired bot evidence, bot room ownership and private bot room grants fail closed", async () =>
  scenario(async ({ c, root, w, inv, ownerRow, signin }) => {
    const { plan } = generatePlan(inv, ownerRow, { reviewer: "fixture reviewer" });
    const edit = (fn) => {
      const p = structuredClone(plan);
      fn(p);
      return p;
    };
    const author = (p, id) => p.authors.find((a) => a.source_author === id);
    await assert.rejects(
      migrate(c, root, w, "project", { plan: edit((p) => (author(p, "bot:bot-gone").evidence.digest = "0".repeat(64))) }),
      /retired bot evidence/,
    );
    // A bot that still has a record cannot be claimed as retired.
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: edit((p) => (author(p, "bot:bot-live").evidence = retiredBotEvidence("bot-live", [JSON.stringify(["room-thread", "rb"])]))),
      }),
      /retired bot evidence/,
    );
    // A bot room cannot claim a room's thread, nor grant anyone but the owner.
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: edit((p) => {
          p.rooms = p.rooms.filter((r) => r.source_type !== "room");
          p.rooms.find((r) => r.source_type === "bot_threads").thread_ids.push("room-thread");
        }),
      }),
      /unowned or duplicate source thread/,
    );
    const pat = await signin("fictional_pat_plan");
    const patRow = { source_actor: PAT, account_id: pat.account_id, issuer: pat.issuer, subject: pat.subject };
    // A non-guest member would see the owner's private bot rooms: refused.
    assert.throws(() => generatePlan(inv, ownerRow, { reviewer: "r", accounts: [patRow] }), /private bot rooms/);
    const withPat = edit((p) => {
      p.members.push({ account_id: pat.account_id, role: "member", evidence: plan.members[0].evidence });
    });
    withPat.members[1].evidence = (() => {
      const r = inv.records.find((r) => r.type === "membership" && r.id === PAT);
      return { type: "membership", id: PAT, digest: r.digest };
    })();
    withPat.authors.push({ source_author: "human:" + PAT, account_id: pat.account_id, issuer: pat.issuer, subject: pat.subject, evidence: withPat.members[1].evidence });
    await assert.rejects(migrate(c, root, w, "project", { plan: withPat }), /private bot rooms/);
    // An explicitly mapped guest binds and gets only the grants their roster proves.
    const gus = await signin("fictional_gus_plan");
    const guestPlan = generatePlan(inv, ownerRow, {
      reviewer: "r",
      accounts: [{ source_actor: GUS, account_id: gus.account_id, issuer: gus.issuer, subject: gus.subject }],
    }).plan;
    assert.deepEqual(guestPlan.members.map((m) => m.role), ["owner", "guest"]);
    assert.deepEqual(
      guestPlan.rooms.filter((r) => r.grants.some((g) => g.account_id === gus.account_id)).map((r) => r.source_id),
      ["room-1"],
    );
    await assert.rejects(
      migrate(c, root, w, "project", {
        plan: edit((p) => p.rooms.find((r) => r.source_type === "bot_threads").grants.push({ account_id: gus.account_id, evidence: p.rooms[0].evidence })),
      }),
      /unknown or duplicate grant/,
    );
    // Unmapped humans never bind; no plan is generated without a reviewer.
    assert.equal(generatePlan(inv, ownerRow).plan.reviewed_current_grants, false);
    assert.throws(() => generatePlan(inv, { account_id: "x" }), /account row/);
    assert.equal((await c.query("SELECT count(*) n FROM cloud.workspaces")).rows[0].n, "0");
    const p = await migrate(c, root, w, "project", { plan: guestPlan });
    assert.equal(p.messages, servedText.length + 1);
    const guestRooms = await c.query(
      "SELECT room_id FROM cloud.room_grants WHERE workspace_id=$1 AND account_id=$2",
      [w, gus.account_id],
    );
    assert.equal(guestRooms.rowCount, 1);
  }));
