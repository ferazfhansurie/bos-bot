// Real migration on a copy: the generated reviewed manifest (migrate/plan.mjs)
// end to end, against the throwaway stack printed by services/cloud/local.ts.
//
//   node run.mjs <copyDir> <local.ts state.json> <outDir>
//
// Adapted from ../g08/migrate.mjs, with plan.mjs instead of the hand-written
// rehearsal plan. The owner signs in through the local issuer, which creates
// the only cloud account; nobody else is mapped, so other people's history
// quarantines. Determinism check before cutover: import twice (staging digest
// unchanged), project twice (idempotent), then roll back and redo
// inventory..project from scratch and require the same projection and
// quarantine digests. Writes counts.json (ids/hashes/counts only, no text).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { inventory, mappedId, migrate } from "../../migrate/tool.mjs";
import { generatePlan } from "../../migrate/plan.mjs";

const [copy, statePath, out] = process.argv.slice(2);
if (!copy || !statePath || !out) throw new Error("usage: run.mjs <copyDir> <state.json> <outDir>");
const state = JSON.parse(await readFile(statePath, "utf8"));
const sha = (v) => createHash("sha256").update(v).digest("hex");
const W = "real_migration";
const EMAIL = "owner@example.test";
const batch = 1000;
// Attachments transfer into the stack's own object store, like slice 4 uploads.
const objects = join(state.fixture_directory, "objects");
const t0 = Date.now();
const log = (step, extra = {}) => console.error(JSON.stringify({ step, s: Math.round((Date.now() - t0) / 1000), ...extra }));

async function signIn(email) {
  const post = (path, body) => fetch(state.issuer_url + path, {
    method: "POST", headers: { "content-type": "application/json", origin: state.issuer_url }, body: JSON.stringify(body),
  });
  const sent = await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (!sent.ok) throw new Error("otp send " + sent.status);
  const otp = await (await fetch(`${state.otp_url}?email=${encodeURIComponent(email)}`)).json();
  const signed = await post("/api/auth/sign-in/email-otp", { email, otp: otp.otp ?? otp.code, name: email.split("@")[0] });
  const bearer = signed.headers.get("set-auth-token");
  if (!signed.ok || !bearer) throw new Error("sign-in " + signed.status);
  const me = await fetch(state.url + "/v2/me", { headers: { authorization: "Bearer " + bearer } });
  if (!me.ok) throw new Error("/v2/me " + me.status);
  return { bearer, me: await me.json() };
}

const owner = await signIn(EMAIL);
const c = new pg.Client({ connectionString: state.migration_url });
await c.connect();
try {
  await c.query(await readFile(new URL("../../migrate/schema.sql", import.meta.url), "utf8"));
  const accounts = (await c.query("SELECT account_id,issuer,subject FROM cloud.accounts")).rows;
  if (accounts.length !== 1) throw new Error("expected exactly the owner's account, got " + accounts.length);
  const staging = async () => {
    const m = (await c.query("SELECT source_type,source_id,cloud_id,digest FROM migration.migration_mappings WHERE workspace_id=$1 ORDER BY source_type,source_id", [W])).rows;
    const l = (await c.query("SELECT count(*)::int n FROM migration.legacy_records WHERE workspace_id=$1", [W])).rows[0].n;
    const q = (await c.query("SELECT source_type,source_id,reason FROM migration.migration_quarantine WHERE workspace_id=$1 ORDER BY source_type,source_id", [W])).rows;
    return { mappings: m.length, legacy_records: l, quarantine: q.length, digest: sha(JSON.stringify([m, l, q])) };
  };
  const reasons = async () => Object.fromEntries((await c.query(
    "SELECT reason,count(*)::int n FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type IN ('message','shared_message') GROUP BY 1 ORDER BY 2 DESC,1", [W])).rows.map((r) => [r.reason, r.n]));

  const inv = await inventory(copy);
  const { plan, summary } = generatePlan(inv, accounts[0], { reviewer: "real migration plan (generated)", name: "BOS migrated workspace" });
  await writeFile(join(out, "plan.json"), JSON.stringify(plan), { mode: 0o600 });
  log("plan", { summary });

  const steps = {};
  const pass = async (label) => {
    for (const action of ["inventory", "freeze"]) steps[action] = await migrate(c, copy, W, action, { batch, objectStorePath: objects });
    steps.import = await migrate(c, copy, W, "import", { batch, objectStorePath: objects });
    const first = await staging();
    log(label + ":import", first);
    await migrate(c, copy, W, "import", { batch, objectStorePath: objects });
    const second = await staging();
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("second import changed staging");
    steps.validate = await migrate(c, copy, W, "validate", { batch, objectStorePath: objects });
    steps.project = await migrate(c, copy, W, "project", { plan, objectStorePath: objects });
    const again = await migrate(c, copy, W, "project", { plan, objectStorePath: objects });
    if (!again.idempotent || again.projection_digest !== steps.project.projection_digest) throw new Error("projection not idempotent");
    log(label + ":project", { messages: steps.project.messages, quarantine: steps.project.quarantine });
    return { import_first: first, import_second: second, projection_digest: steps.project.projection_digest, quarantine_digest: steps.project.quarantine_digest, served: steps.project.messages, reasons: await reasons() };
  };
  const runA = await pass("A");
  await migrate(c, copy, W, "rollback", { objectStorePath: objects });
  log("rollback");
  const runB = await pass("B");
  for (const k of ["projection_digest", "quarantine_digest", "served"])
    if (runA[k] !== runB[k]) throw new Error("rerun from scratch differs: " + k);
  if (runA.import_first.digest !== runB.import_first.digest) throw new Error("rerun staging differs");

  const verified = await migrate(c, copy, W, "verify-projection", { objectStorePath: objects });
  const reader = new pg.Client({ connectionString: state.migration_url });
  await reader.connect();
  const served = (await reader.query(
    "SELECT room_id,thread_id,message_id,sequence FROM cloud.messages WHERE workspace_id=$1 ORDER BY room_id,sequence", [W])).rows;
  await reader.end();
  const acceptance = { ...verified, reviewer: "real migration independent readback", evidence_digest: sha(JSON.stringify(served)) };
  steps.cutover = await migrate(c, copy, W, "cutover", { acceptance, objectStorePath: objects });
  steps.archive = await migrate(c, copy, W, "archive", { objectStorePath: objects });
  log("archived");

  const servedIds = new Set(served.map((m) => m.message_id));
  const parse = (r) => JSON.parse(r.encoded);
  const byThread = new Map();
  for (const r of inv.records)
    if (r.type === "message" || r.type === "shared_message") {
      const t = parse(r).thread_id ?? parse(r).roomId;
      byThread.set(t, [...(byThread.get(t) ?? []), r]);
    }
  const perRoom = [];
  for (const room of plan.rooms) {
    const roomId = mappedId(inv.source_install_id, room.source_type, room.source_id);
    const src = room.thread_ids.flatMap((t) => byThread.get(t) ?? []).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const srcServed = src.map((r) => mappedId(inv.source_install_id, r.type, r.id)).filter((id) => servedIds.has(id));
    const rows = served.filter((m) => m.room_id === roomId);
    perRoom.push({
      source_type: room.source_type, room_id: roomId, threads: room.thread_ids.length,
      source_messages: src.length, served: rows.length,
      order_matches: JSON.stringify(rows.map((m) => m.message_id)) === JSON.stringify(srcServed),
      seq_contiguous: rows.every((m, i) => Number(m.sequence) === i + 1),
    });
  }
  const grants = (await c.query("SELECT room_id,account_id FROM cloud.room_grants WHERE workspace_id=$1 ORDER BY 1,2", [W])).rows;
  const counts = {
    source_digest: inv.digest, plan_digest: verified.plan_digest, plan_summary: summary,
    source_records: inv.records.length,
    source_messages: inv.records.filter((r) => r.type === "message" || r.type === "shared_message").length,
    served_messages: served.length, quarantine: await reasons(),
    projection_digest: verified.projection_digest, quarantine_digest: verified.quarantine_digest,
    determinism: { runA, runB: { ...runB, reasons: undefined } },
    members: (await c.query("SELECT role,count(*)::int n FROM cloud.members WHERE workspace_id=$1 GROUP BY 1", [W])).rows,
    room_grants: { rows: grants.length, all_owner: grants.every((g) => g.account_id === accounts[0].account_id) },
    no_dispatch: {
      invocations: Number((await c.query("SELECT count(*) n FROM cloud.invocations")).rows[0].n),
      work_queue_non_authority: Number((await c.query("SELECT count(*) n FROM cloud.work_queue q JOIN cloud.room_events e USING(workspace_id,room_id,event_id) WHERE e.kind<>'authority_changed'")).rows[0].n),
    },
    rooms: perRoom,
    states: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v?.state ?? v?.epoch ?? null])),
    authority_flag: JSON.parse(await readFile(join(copy, "cloud-authority.json"), "utf8")),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  await writeFile(join(out, "counts.json"), JSON.stringify(counts, null, 2));
  await writeFile(join(out, "owner-bearer"), owner.bearer, { mode: 0o600 });
  console.log(JSON.stringify(counts, null, 2));
} finally {
  await c.end();
}
