// Real-copy attachment transfer measurement, on the copy made by copy.mjs and
// the throwaway stack printed by services/cloud/local.ts. Same rehearsal plan
// as migrate.mjs (owner is the only human; bots and unstamped messages bind to
// the owner). Never dispatches, never uses the send route.
//
//   node attach.mjs <copyDir> <local.ts state.json> <outDir>
//
// Run A: the g08 rehearsal plan as is, projected and rolled back.
// Run B: the copy gains one rehearsal room (groups.json) owning the bot
// threads that hold attachment references, so those messages become
// servable. Projected, rolled back, re-imported and compared, projected again
// (no-op), cut over, then every object is downloaded over HTTP as the owner.
// Writes attach.json: counts, sizes and sha256 only, no content.
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { inventory, migrate } from "../../migrate/tool.mjs";

const [copy, statePath, out] = process.argv.slice(2);
if (!copy || !statePath || !out) throw new Error("usage: attach.mjs <copyDir> <state.json> <outDir>");
const state = JSON.parse(await readFile(statePath, "utf8"));
const objects = join(state.fixture_directory, "objects");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const W = "g08_attach";
const EMAIL = "owner@example.test";
const SHIM = "rehearsal-attachment-room";
const PRE = ["inventory", "freeze", "import", "validate"];

async function signIn(email) {
  const post = (path, body) => fetch(state.issuer_url + path, {
    method: "POST", headers: { "content-type": "application/json", origin: state.issuer_url }, body: JSON.stringify(body),
  });
  if (!(await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).ok) throw new Error("otp send");
  const otp = await (await fetch(`${state.otp_url}?email=${encodeURIComponent(email)}`)).json();
  const signed = await post("/api/auth/sign-in/email-otp", { email, otp: otp.otp ?? otp.code, name: email.split("@")[0] });
  const bearer = signed.headers.get("set-auth-token");
  if (!signed.ok || !bearer) throw new Error("sign-in " + signed.status);
  // First /v2/me creates the cloud account the plan binds to.
  if (!(await fetch(state.url + "/v2/me", { headers: { authorization: "Bearer " + bearer } })).ok) throw new Error("/v2/me");
  return bearer;
}

// Same rehearsal plan as migrate.mjs.
function rehearsalPlan(inv, acct) {
  const recs = (type) => inv.records.filter((r) => r.type === type);
  const parse = (r) => JSON.parse(r.encoded);
  const ev = (r) => ({ type: r.type, id: r.id, digest: r.digest });
  const ownerMembership = recs("membership").find((r) => parse(r).role === "owner");
  const ownerActor = parse(ownerMembership).actorId ?? parse(ownerMembership).id;
  const bind = (source_author, evidence) => ({ source_author, account_id: acct.account_id, issuer: acct.issuer, subject: acct.subject, evidence });
  const authors = [bind("human:" + ownerActor, ev(ownerMembership))];
  for (const b of recs("bot")) authors.push(bind("bot:" + b.id, ev(b)));
  const threadOwners = new Map(recs("thread").map((r) => [r.id, parse(r).rooms ?? []]));
  const rooms = [];
  for (const type of ["room", "shared_room"])
    for (const r of recs(type)) {
      const room = parse(r);
      const ids = [type === "shared_room" ? room.id : room.threadId, ...(room.tasks ?? []).map((t) => t.threadId)].filter(Boolean);
      const owned = [...new Set(ids)].filter((t) => {
        const o = threadOwners.get(t);
        return o && o.length === 1 && o[0].type === type && o[0].id === r.id;
      });
      if (owned.length) rooms.push({ source_id: r.id, source_type: type, evidence: ev(r), thread_ids: owned, grants: [] });
    }
  const mapped = new Set(rooms.flatMap((r) => r.thread_ids));
  for (const r of recs("message")) {
    const m = parse(r);
    if (!mapped.has(m.thread_id)) continue;
    if ((m.role === "user" && !m.sender?.id) || (m.role === "bot" && !m.from?.botId)) authors.push(bind("message:" + r.id, ev(r)));
  }
  return {
    version: 1, source_install_id: inv.source_install_id, source_digest: inv.digest, reviewed_current_grants: true,
    reviewer: "mig-attach rehearsal", name: "g08 attachment rehearsal",
    members: [{ account_id: acct.account_id, role: "owner", evidence: ev(ownerMembership) }], authors, rooms,
  };
}

const q = async (c, sql, args = [W]) => (await c.query(sql, args)).rows;
async function snapshot(c) {
  const rows = await q(c, "SELECT attachment_id,room_id,object_key,size,checksum,type,state,attached FROM cloud.attachment_objects WHERE workspace_id=$1 ORDER BY attachment_id");
  const refs = await q(c, "SELECT reason,count(*)::int n FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type='attachment_reference' GROUP BY 1 ORDER BY 1");
  const msgs = await q(c, "SELECT count(*)::int n FROM cloud.messages WHERE workspace_id=$1 AND jsonb_array_length(attachment_ids)>0");
  const files = (await readdir(objects).catch(() => [])).filter((n) => n.startsWith(W + "|")).sort();
  let bytes = 0;
  for (const n of files) bytes += (await stat(join(objects, n))).size;
  return {
    transferred: rows.length, ready_attached: rows.filter((r) => r.state === "ready" && r.attached).length,
    transferred_bytes: rows.reduce((s, r) => s + Number(r.size), 0), messages_with_attachments: msgs[0].n,
    reference_quarantine: refs, store_files: files.length, store_bytes: bytes,
    objects: rows.map((r) => ({ attachment_id: r.attachment_id, type: r.type, size: Number(r.size), sha256: r.checksum })),
    keys_digest: sha(JSON.stringify(rows.map((r) => r.object_key))),
  };
}
async function messageReasons(c, inv) {
  const unique = [...new Set(inv.records.filter((r) => r.type === "attachment_reference").map((r) => JSON.parse(r.encoded).message_source_id))];
  const rows = await q(c, "SELECT reason,count(*)::int n FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type='message' AND source_id=ANY($2) GROUP BY 1 ORDER BY 1", [W, unique]);
  return { attachment_messages: unique.length, quarantined: rows };
}

const bearer = await signIn(EMAIL);
const c = new pg.Client({ connectionString: state.migration_url });
await c.connect();
const result = {};
try {
  await c.query(await readFile(new URL("../../migrate/schema.sql", import.meta.url), "utf8"));
  const [acct] = await q(c, "SELECT account_id,issuer,subject FROM cloud.accounts", []);
  const opts = { objectStorePath: objects };

  // Run A: g08 rehearsal plan unchanged.
  let inv = await inventory(copy);
  for (const a of PRE) await migrate(c, copy, W, a);
  const a = await migrate(c, copy, W, "project", { plan: rehearsalPlan(inv, acct), ...opts });
  result.run_a = { messages: a.messages, ...(await messageReasons(c, inv)), ...(await snapshot(c)) };
  await migrate(c, copy, W, "rollback", opts);
  result.run_a.after_rollback = (await snapshot(c)).store_files;

  // Run B: rehearsal room owning the bot threads that hold references.
  const parse = (r) => JSON.parse(r.encoded);
  const refMsgs = new Set(inv.records.filter((r) => r.type === "attachment_reference").map((r) => parse(r).message_source_id));
  const threads = [...new Set(inv.records.filter((r) => r.type === "message" && refMsgs.has(r.id)).map((r) => parse(r).thread_id))].sort();
  const groups = JSON.parse(await readFile(join(copy, "groups.json"), "utf8"));
  if (!groups.some((g) => g.id === SHIM)) {
    groups.push({ id: SHIM, name: "rehearsal attachment room", threadId: threads[0], memberIds: [], createdAt: 0,
      tasks: threads.slice(1).map((t) => ({ threadId: t, title: "rehearsal", createdAt: 0 })) });
    await writeFile(join(copy, "groups.json"), JSON.stringify(groups));
  }
  result.shim_threads = threads.length;
  inv = await inventory(copy);
  const plan = rehearsalPlan(inv, acct);
  for (const s of PRE) await migrate(c, copy, W, s);
  const t0 = Date.now();
  const b1 = await migrate(c, copy, W, "project", { plan, ...opts });
  const first = { ms: Date.now() - t0, messages: b1.messages, projection_digest: b1.projection_digest, quarantine_digest: b1.quarantine_digest, ...(await messageReasons(c, inv)), ...(await snapshot(c)) };
  await migrate(c, copy, W, "rollback", opts);
  const rolled = await snapshot(c);
  result.run_b = { first, after_rollback: { rows: rolled.transferred, store_files: rolled.store_files } };
  for (const s of PRE) await migrate(c, copy, W, s);
  const b2 = await migrate(c, copy, W, "project", { plan, ...opts });
  const second = await snapshot(c);
  const b3 = await migrate(c, copy, W, "project", { plan, ...opts });
  result.run_b.second_import = {
    projection_digest_equal: b2.projection_digest === b1.projection_digest,
    quarantine_digest_equal: b2.quarantine_digest === b1.quarantine_digest,
    objects_equal: JSON.stringify(second.objects) === JSON.stringify(first.objects),
    keys_equal: second.keys_digest === first.keys_digest,
    reproject_idempotent: b3.idempotent === true && b3.projection_digest === b1.projection_digest,
    reproject_store_files: (await snapshot(c)).store_files,
  };
  const verified = await migrate(c, copy, W, "verify-projection", opts);
  result.run_b.verify = { attachments: verified.attachments, attachment_bytes: verified.attachment_bytes };
  const served = await q(c, "SELECT room_id,message_id,attachment_ids FROM cloud.messages WHERE workspace_id=$1 ORDER BY room_id,sequence");
  await migrate(c, copy, W, "cutover", { acceptance: { ...verified, reviewer: "mig-attach independent readback", evidence_digest: sha(JSON.stringify(served)) } });

  // Owner readback over HTTP after cutover.
  const inventoryHash = new Map(inv.records.filter((r) => r.type === "attachment_file").map((r) => [parse(r).checksum, true]));
  let ok = 0, bytes = 0;
  for (const o of second.objects) {
    const res = await fetch(`${state.url}/v2/workspaces/${W}/attachments/${o.attachment_id}/download`, { headers: { authorization: "Bearer " + bearer } });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 200 && sha(body) === o.sha256 && inventoryHash.has(sha(body))) { ok++; bytes += body.length; }
  }
  const msgIds = served.filter((m) => m.attachment_ids.length).map((m) => m.message_id);
  result.run_b.http_download = { requested: second.objects.length, sha_matches_inventory: ok, bytes };
  result.run_b.served_messages_with_attachments = msgIds.length;
  result.run_b.invocations = (await q(c, "SELECT count(*)::int n FROM cloud.invocations WHERE workspace_id=$1"))[0].n;
  result.store_bytes = (await snapshot(c)).store_bytes;
  await writeFile(join(out, "attach.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await c.end();
}
