import { compatEnv } from "../../../electron/branding-env.cjs";
// Generate a version 1 reviewed manifest (README.md) from an inventory and the
// signed-in owner's cloud account row. Deterministic for the same inputs. It
// never invents a person or a grant:
// - the source owner (persisted ownerId) binds to the owner account;
// - every source bot binds to the owner account as bot author: live bots by
//   their bot record, deleted bots (stamped in messages, no record left) by
//   `retired_bot` evidence over the exact sorted message ids that name them;
// - each bot's legacy 1:1 threads become one private `bot_threads` room
//   (owner grant only); rooms and shared rooms stay rooms;
// - unstamped servable messages in mapped threads bind to the owner per message;
// - another human binds only from an explicit {source_actor, account_id,
//   issuer, subject} mapping whose source actor has a membership record.
//   Everyone else stays out and their history quarantines.
//
//   BOS_MIGRATION_URL=postgres://... node plan.mjs <copyDir> <ownerAccountId> \
//     --reviewer "name" [--name "workspace"] [--accounts mappings.json] > plan.json
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { connect, inventory } from "./tool.mjs";
import {
  botMessageIds,
  botThreadIds,
  payloadReason,
  retiredBotEvidence,
  servingView,
  sourceAuthor,
  threadOwners,
} from "./serving.mjs";

const validId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const parse = (r) => JSON.parse(r.encoded);
const ev = (r) => ({ type: r.type, id: r.id, digest: r.digest });
const canonicalRole = (role) => (role === "client-guest" ? "guest" : role);

function account(row, label) {
  if (
    !validId(row?.account_id) ||
    typeof row.issuer !== "string" ||
    !row.issuer ||
    typeof row.subject !== "string" ||
    !row.subject
  )
    throw new Error(label + " account row (account_id, issuer, subject) required");
  return {
    account_id: row.account_id,
    issuer: row.issuer,
    subject: row.subject,
  };
}

export function generatePlan(inv, ownerRow, options = {}) {
  const owner = account(ownerRow, "owner");
  const reviewer = typeof options.reviewer === "string" ? options.reviewer.trim() : "";
  const byType = new Map();
  for (const r of inv.records) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  const recs = (type) => byType.get(type) ?? [];
  const record = new Map(inv.records.map((r) => [JSON.stringify([r.type, r.id]), r]));
  const get = (type, id) => record.get(JSON.stringify([type, id]));

  // People: the persisted owner, then explicit mappings only.
  const owners = recs("membership").filter((r) => parse(r).role === "owner");
  if (owners.length !== 1) throw new Error("exactly one source owner membership required");
  const ownerActor = parse(owners[0]).actorId;
  if (typeof ownerActor !== "string" || !ownerActor) throw new Error("source owner actor id required");
  const bind = (source_author, acct, evidence) => ({
    source_author,
    account_id: acct.account_id,
    issuer: acct.issuer,
    subject: acct.subject,
    evidence,
  });
  const members = [{ account_id: owner.account_id, role: "owner", evidence: ev(owners[0]) }];
  const authors = new Map([["human:" + ownerActor, bind("human:" + ownerActor, owner, ev(owners[0]))]]);
  const people = new Map([[ownerActor, { account_id: owner.account_id, role: "owner" }]]);
  for (const mapping of options.accounts ?? []) {
    const acct = account(mapping, "mapped");
    const actor = mapping.source_actor;
    const membership = get("membership", actor);
    if (!membership) throw new Error("mapped human has no source membership record");
    const role = canonicalRole(parse(membership).role);
    if (
      people.has(actor) ||
      members.some((m) => m.account_id === acct.account_id) ||
      !["admin", "member", "guest"].includes(role)
    )
      throw new Error("duplicate or invalid human mapping");
    members.push({ account_id: acct.account_id, role, evidence: ev(membership) });
    const actorRecord = get("actor", actor);
    authors.set("human:" + actor, bind("human:" + actor, acct, ev(actorRecord ?? membership)));
    people.set(actor, { account_id: acct.account_id, role });
  }

  // Bots: live records, then deleted bots named only by their messages.
  const liveBots = recs("bot");
  for (const b of liveBots) authors.set("bot:" + b.id, bind("bot:" + b.id, owner, ev(b)));
  const stamped = botMessageIds(inv);
  const retired = [];
  for (const [botId, ids] of [...stamped].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
    if (!get("bot", botId)) {
      retired.push(botId);
      authors.set("bot:" + botId, bind("bot:" + botId, owner, retiredBotEvidence(botId, ids)));
    }
  // Shared-room bots of the owner's own home (same evidence rule as before).
  const ownerHome = /^([A-Za-z0-9_-]{1,128}):person:/.exec(ownerActor)?.[1];
  for (const r of recs("shared_message")) {
    const actor = parse(r).actor;
    if (actor?.kind !== "bot" || !ownerHome || actor.homeId !== ownerHome) continue;
    const contact = `${actor.homeId}:bot:${actor.localId}`;
    if (!authors.has("bot:" + contact)) authors.set("bot:" + contact, bind("bot:" + contact, owner, ev(r)));
  }

  // Rooms. A thread maps once, only under its sole owner.
  const sourceThread = new Map(recs("thread").map((r) => [r.id, threadOwners(parse(r))]));
  const botThreadCount = new Map();
  for (const b of liveBots)
    for (const t of botThreadIds(parse(b))) botThreadCount.set(t, (botThreadCount.get(t) ?? 0) + 1);
  const rooms = [];
  const skippedRooms = [];
  const grantsFor = (type, r, roster) =>
    [...people.entries()]
      .filter(([actor, p]) => p.role === "guest" && roster?.includes(actor))
      .map(([, p]) => ({ account_id: p.account_id, evidence: ev(r) }));
  for (const type of ["room", "shared_room"])
    for (const r of recs(type)) {
      const room = parse(r);
      const ids = [
        ...new Set(
          [type === "shared_room" ? room.id : room.threadId, ...(room.tasks ?? []).map((t) => t.threadId)].filter(
            (t) => typeof t === "string" && t,
          ),
        ),
      ];
      const owned = ids.filter((t) => {
        const o = sourceThread.get(t);
        return o?.length === 1 && o[0].type === type && o[0].id === r.id;
      });
      if (!owned.length) {
        skippedRooms.push({ type, id: r.id });
        continue;
      }
      rooms.push({
        source_id: r.id,
        source_type: type,
        evidence: ev(r),
        thread_ids: owned,
        grants: grantsFor(type, r, type === "shared_room" ? room.memberIds : room.peopleIds),
      });
    }
  for (const b of liveBots) {
    const owned = botThreadIds(parse(b)).filter(
      (t) => sourceThread.get(t)?.length === 0 && botThreadCount.get(t) === 1,
    );
    if (!owned.length) {
      skippedRooms.push({ type: "bot_threads", id: b.id });
      continue;
    }
    rooms.push({
      source_id: b.id,
      source_type: "bot_threads",
      evidence: ev(b),
      thread_ids: owned,
      grants: [{ account_id: owner.account_id, evidence: ev(b) }],
    });
  }
  if (
    rooms.some((r) => r.source_type === "bot_threads") &&
    members.some((m) => !["owner", "guest"].includes(m.role))
  )
    throw new Error("private bot rooms require owner and guest members only");

  // Unstamped servable messages in mapped threads are the owner's (legacy
  // stamps every remote person and every group-room bot; an unstamped user
  // row is the local owner). Unservable payloads need no binding.
  const threadRoom = new Map();
  for (const room of rooms) for (const t of room.thread_ids) threadRoom.set(t, room);
  const conflicts = new Set(inv.conflicts);
  for (const r of [...recs("message"), ...recs("shared_message")]) {
    if (conflicts.has(r.id)) continue;
    const m = servingView(r);
    const room = threadRoom.get(m.thread_id);
    if (!room || (r.type === "shared_message") !== (room.source_type === "shared_room")) continue;
    if (payloadReason(m)) continue;
    const author = sourceAuthor(m, r.id, room);
    if (author.startsWith("message:")) authors.set(author, bind(author, owner, ev(r)));
  }

  const sortedAuthors = [...authors.values()].sort((a, b) =>
    a.source_author < b.source_author ? -1 : a.source_author > b.source_author ? 1 : 0,
  );
  const plan = {
    version: 1,
    source_install_id: inv.source_install_id,
    source_digest: inv.digest,
    reviewed_current_grants: reviewer !== "",
    reviewer,
    name: options.name ?? "migrated workspace",
    members,
    authors: sortedAuthors,
    rooms,
  };
  const leftOut = recs("membership")
    .map((r) => parse(r).actorId)
    .filter((a) => !people.has(a));
  const summary = {
    members: members.length,
    humans_left_out: leftOut.length,
    authors: {
      human: sortedAuthors.filter((a) => a.source_author.startsWith("human:")).length,
      bot_live: liveBots.length,
      bot_retired: retired.length,
      bot_shared: sortedAuthors.filter((a) => a.evidence.type === "shared_message" && a.source_author.startsWith("bot:")).length,
      message: sortedAuthors.filter((a) => a.source_author.startsWith("message:")).length,
    },
    rooms: Object.fromEntries(
      ["room", "shared_room", "bot_threads"].map((t) => [t, rooms.filter((r) => r.source_type === t).length]),
    ),
    threads_mapped: threadRoom.size,
    threads_unmapped: [...sourceThread.keys()].filter((t) => !threadRoom.has(t)).length,
    rooms_skipped_no_owned_thread: skippedRooms.length,
  };
  return { plan, summary };
}

function args(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const a = args(process.argv.slice(2));
  const [dir, ownerAccountId] = a.positional;
  if (!dir || !ownerAccountId || !a.reviewer || !compatEnv.BOS_MIGRATION_URL)
    throw new Error(
      "usage: BOS_MIGRATION_URL=... plan.mjs <copyDir> <ownerAccountId> --reviewer name [--name ws] [--accounts mappings.json]",
    );
  const c = await connect(compatEnv.BOS_MIGRATION_URL);
  try {
    const row = async (id) =>
      (await c.query("SELECT account_id,issuer,subject FROM cloud.accounts WHERE account_id=$1", [id])).rows[0];
    const owner = await row(ownerAccountId);
    if (!owner) throw new Error("owner account must already exist from verified sign-in");
    const accounts = a.accounts ? JSON.parse(await readFile(a.accounts, "utf8")) : [];
    for (const m of accounts) {
      const r = await row(m.account_id);
      if (!r || r.issuer !== m.issuer || r.subject !== m.subject)
        throw new Error("mapped account must exist with the same verified issuer and subject");
    }
    const { plan, summary } = generatePlan(await inventory(dir), owner, {
      reviewer: a.reviewer,
      name: a.name,
      accounts,
    });
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    process.stderr.write(JSON.stringify(summary) + "\n");
  } finally {
    await c.end();
  }
}
