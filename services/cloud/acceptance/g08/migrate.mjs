// G08 native: run api's serving migration end to end on the copy made by
// copy.mjs, against the throwaway stack printed by services/cloud/local.ts.
//
//   node migrate.mjs <copyDir> <local.ts state.json> <outDir>
//
// The owner signs in through the local issuer (owner@example.test), which
// creates the cloud account the plan binds to. This is a rehearsal plan, not
// api's reviewed manifest: the owner is the only human; unstamped user
// messages and every bot are attributed to the owner's account; other people
// and their messages stay quarantined. Writes expected.json (per room: served
// count, newest 50 message ids in order) for the native UI test, and
// counts.json (source vs served vs quarantined, ids/hashes only).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { inventory, mappedId, migrate } from "../../migrate/tool.mjs";

const [copy, statePath, out] = process.argv.slice(2);
if (!copy || !statePath || !out) throw new Error("usage: migrate.mjs <copyDir> <state.json> <outDir>");
const state = JSON.parse(await readFile(statePath, "utf8"));
const sha = (v) => createHash("sha256").update(v).digest("hex");
const W = "g08_native";
const EMAIL = "owner@example.test";

async function signIn(email) {
  const post = (path, body) => fetch(state.issuer_url + path, {
    method: "POST", headers: { "content-type": "application/json", origin: state.issuer_url }, body: JSON.stringify(body),
  });
  const sent = await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (!sent.ok) throw new Error("otp send " + sent.status);
  const otp = await (await fetch(`${state.otp_url}?email=${encodeURIComponent(email)}`)).json();
  const code = otp.otp ?? otp.code;
  const signed = await post("/api/auth/sign-in/email-otp", { email, otp: code, name: email.split("@")[0] });
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
  const account = (await c.query("SELECT account_id,issuer,subject FROM cloud.accounts")).rows;
  if (account.length !== 1) throw new Error("expected exactly the owner's account, got " + account.length);
  const acct = account[0];
  const inv = await inventory(copy);
  const recs = (type) => inv.records.filter((r) => r.type === type);
  const parse = (r) => JSON.parse(r.encoded);
  const ev = (r) => ({ type: r.type, id: r.id, digest: r.digest });
  const ownerMembership = recs("membership").find((r) => parse(r).role === "owner");
  if (!ownerMembership) throw new Error("no owner membership in the copy");
  const ownerActor = parse(ownerMembership).actorId ?? parse(ownerMembership).id;
  const bind = (source_author, evidence) => ({ source_author, account_id: acct.account_id, issuer: acct.issuer, subject: acct.subject, evidence });
  const authors = [bind("human:" + ownerActor, ev(ownerMembership))];
  for (const b of recs("bot")) authors.push(bind("bot:" + b.id, ev(b)));
  // Rooms whose every thread is owned by that room alone.
  const threadOwners = new Map(recs("thread").map((r) => [r.id, parse(r).rooms ?? []]));
  const rooms = [];
  for (const type of ["room", "shared_room"]) {
    for (const r of recs(type)) {
      const room = parse(r);
      const ids = [type === "shared_room" ? room.id : room.threadId, ...(room.tasks ?? []).map((t) => t.threadId)].filter(Boolean);
      const owned = [...new Set(ids)].filter((t) => {
        const o = threadOwners.get(t);
        return o && o.length === 1 && o[0].type === type && o[0].id === r.id;
      });
      if (owned.length) rooms.push({ source_id: r.id, source_type: type, evidence: ev(r), thread_ids: owned, grants: [] });
    }
  }
  const mappedThreads = new Set(rooms.flatMap((r) => r.thread_ids));
  // Unstamped user messages in mapped threads: the single-human install's owner.
  for (const r of recs("message")) {
    const m = parse(r);
    if (!mappedThreads.has(m.thread_id)) continue;
    if ((m.role === "user" && !m.sender?.id) || (m.role === "bot" && !m.from?.botId)) authors.push(bind("message:" + r.id, ev(r)));
  }
  const plan = {
    version: 1, source_install_id: inv.source_install_id, source_digest: inv.digest, reviewed_current_grants: true,
    reviewer: "mobile g08 rehearsal", name: "g08 native rehearsal",
    members: [{ account_id: acct.account_id, role: "owner", evidence: ev(ownerMembership) }], authors, rooms,
  };
  const steps = {};
  for (const action of ["inventory", "freeze", "import", "validate"]) steps[action] = await migrate(c, copy, W, action);
  steps.project = await migrate(c, copy, W, "project", { plan });
  const verified = await migrate(c, copy, W, "verify-projection");
  // Independent readback on a second connection before acceptance.
  const reader = new pg.Client({ connectionString: state.migration_url });
  await reader.connect();
  const served = (await reader.query(
    "SELECT room_id,thread_id,message_id,sequence FROM cloud.messages WHERE workspace_id=$1 ORDER BY room_id,sequence", [W])).rows;
  await reader.end();
  const acceptance = { ...verified, reviewer: "mobile g08 independent readback", evidence_digest: sha(JSON.stringify(served)) };
  steps.cutover = await migrate(c, copy, W, "cutover", { acceptance });
  steps.archive = await migrate(c, copy, W, "archive");
  const quarantine = (await c.query(
    "SELECT reason,count(*)::int n FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type IN ('message','shared_message') GROUP BY 1 ORDER BY 1", [W])).rows;

  // Source order per mapped room, from the inventory, for the same eligible set.
  const servedIds = new Set(served.map((m) => m.message_id));
  const perRoom = [];
  for (const room of rooms) {
    const roomId = mappedId(inv.source_install_id, "room", room.source_id);
    const src = inv.records
      .filter((r) => (r.type === "message" || r.type === "shared_message") && room.thread_ids.includes(parse(r).thread_id ?? parse(r).roomId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const srcServed = src.map((r) => mappedId(inv.source_install_id, "message", r.id)).filter((id) => servedIds.has(id));
    const rows = served.filter((m) => m.room_id === roomId);
    perRoom.push({
      source_type: room.source_type, room_id: roomId, threads: room.thread_ids.map((t) => mappedId(inv.source_install_id, "thread", t)),
      source_messages: src.length, served: rows.length,
      order_matches: JSON.stringify(rows.map((m) => m.message_id)) === JSON.stringify(srcServed),
      newest: rows.slice(-50).map((m) => ({ id: m.message_id, thread: m.thread_id, sequence: Number(m.sequence) })),
    });
  }
  const counts = {
    source_records: inv.records.length, source_messages: recs("message").length + recs("shared_message").length,
    served_messages: served.length, quarantine, rooms: perRoom.map(({ newest, ...r }) => r),
    states: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v?.state ?? v?.epoch ?? null])),
    authority_flag: JSON.parse(await readFile(join(copy, "cloud-authority.json"), "utf8")),
  };
  await writeFile(join(out, "counts.json"), JSON.stringify(counts, null, 2));
  await writeFile(join(out, "expected.json"), JSON.stringify({ workspace_id: W, email: EMAIL, rooms: perRoom.filter((r) => r.served) }, null, 2));
  await writeFile(join(out, "owner-bearer"), owner.bearer, { mode: 0o600 });
  console.log(JSON.stringify(counts, null, 2));
} finally {
  await c.end();
}
