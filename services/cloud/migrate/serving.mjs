import { createHash } from "node:crypto";
import { readFile, writeFile, rename, open } from "node:fs/promises";
import { join } from "node:path";
import { mappedId } from "./tool.mjs";
import {
  attachmentContext,
  markReferences,
  objectStore,
  planAttachments,
  rollbackAttachments,
  sweepObjects,
  transferAttachments,
  verifyAttachmentObjects,
} from "./attachments.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const key = (type, id) => JSON.stringify([type, id]);
const validId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const parse = (r) => JSON.parse(r.encoded);
// Room mapping source types. "bot_threads" maps one source bot record to a
// private room holding that bot's legacy 1:1 threads (bot.threadId + tasks).
const ROOM_SOURCES = {
  room: { record: "room", messages: "message" },
  shared_room: { record: "shared_room", messages: "shared_message" },
  bot_threads: { record: "bot", messages: "message" },
};
// Kinds whose `text` is the complete, human-readable message: routine/goal
// run notices carry a designated plain-text fallback. Only that text serves;
// structured cards stay operator-only in staging.
const TEXT_KINDS = new Set(["text", "markdown", "routine.run", "goal.run"]);
// Executable, approval, credential or derived-receipt payloads never serve.
const QUARANTINED_KINDS = {
  activity: "legacy_tool_activity",
  options: "legacy_approval_card",
  secret: "legacy_secret_request",
  screen: "legacy_screen_capture",
  digest: "legacy_turn_receipt",
  compaction: "legacy_turn_receipt",
};
const EXECUTABLE_FIELDS = ["tool", "card", "secret", "png", "comm"];
/** Null when the source message is plain text that may serve, else the quarantine reason. */
export function payloadReason(m) {
  if (!["user", "bot"].includes(m.role)) return "unsupported_legacy_payload";
  const kind = m.kind ?? "text";
  if (Object.hasOwn(QUARANTINED_KINDS, kind)) return QUARANTINED_KINDS[kind];
  if (!TEXT_KINDS.has(kind) || typeof m.text !== "string")
    return "unsupported_legacy_payload";
  if (EXECUTABLE_FIELDS.some((f) => m[f] !== undefined))
    return "legacy_executable_payload";
  return null;
}
/** Owners of a source thread, without the duplicate a room's own thread gets when it is also listed in its tasks. */
export function threadOwners(thread) {
  const seen = new Map();
  for (const o of thread.rooms ?? []) seen.set(key(o.type, o.id), o);
  return [...seen.values()];
}
/** Source threads of a bot record: its 1:1 thread and its task threads. */
export function botThreadIds(bot) {
  return [
    ...new Set(
      [bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)].filter(
        (t) => typeof t === "string" && t,
      ),
    ),
  ];
}
/** Inventory message ids (sorted) whose stamped author is a bot ID. */
export function botMessageIds(inv) {
  const out = new Map();
  for (const r of inv.records)
    if (r.type === "message") {
      const botId = parse(r).from?.botId;
      if (typeof botId === "string" && botId) {
        const list = out.get(botId) ?? [];
        list.push(r.id);
        out.set(botId, list);
      }
    }
  for (const list of out.values()) list.sort();
  return out;
}
/** Evidence for a bot that has messages but no surviving bot record. */
export function retiredBotEvidence(id, messageIds) {
  return { type: "retired_bot", id, digest: hash(JSON.stringify(messageIds)) };
}
async function transaction(c, fn) {
  await c.query("BEGIN");
  try {
    const v = await fn();
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
async function quarantine(c, w, type, id, reason) {
  await c.query(
    "INSERT INTO migration.migration_quarantine VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,source_type,source_id) DO UPDATE SET reason=excluded.reason",
    [w, type, id, reason],
  );
}
async function digests(c, w) {
  const rows = {};
  for (const [table, order] of [
    ["workspaces", "workspace_id"],
    ["members", "account_id"],
    ["rooms", "room_id"],
    ["threads", "room_id,thread_id"],
    ["room_grants", "room_id,account_id"],
    ["messages", "room_id,sequence"],
    ["attachment_objects", "attachment_id"],
    ["message_attachments", "message_id,attachment_id"],
  ])
    rows[table] = (
      await c.query(
        `SELECT * FROM cloud.${table} WHERE workspace_id=$1 ORDER BY ${order}`,
        [w],
      )
    ).rows;
  const quarantine = (
    await c.query(
      "SELECT source_type,source_id,reason FROM migration.migration_quarantine WHERE workspace_id=$1 ORDER BY source_type,source_id",
      [w],
    )
  ).rows;
  return {
    projection_digest: hash(JSON.stringify(rows)),
    quarantine_digest: hash(JSON.stringify(quarantine)),
    messages: rows.messages.length,
    quarantine: quarantine.length,
  };
}
async function assertFreeze(dir, run) {
  const f = JSON.parse(
    await readFile(join(dir, "cloud-authority.json"), "utf8"),
  );
  const previousFrozen =
    run.state === "cloud_active" &&
    f.state === "validated" &&
    String(f.epoch) === String(BigInt(run.epoch) - 1n);
  if (
    f.workspace_id !== run.workspace_id ||
    (!previousFrozen && String(f.epoch) !== String(run.epoch)) ||
    !["validated", "cloud_active", "legacy_archived"].includes(f.state)
  )
    throw new Error("validated authority flag required");
}
async function assertStaging(c, run, inv) {
  const expected = new Map(inv.records.map((r) => [key(r.type, r.id), r]));
  const stored = (
    await c.query(
      "SELECT source_type,source_id,payload::text AS encoded FROM migration.legacy_records WHERE workspace_id=$1",
      [run.workspace_id],
    )
  ).rows;
  if (stored.length !== expected.size)
    throw new Error("source staging count mismatch");
  for (const row of stored) {
    const r = expected.get(key(row.source_type, row.source_id));
    if (!r || hash(row.encoded) !== r.digest)
      throw new Error("source staging payload mismatch");
  }
  const mappings = (
    await c.query(
      "SELECT * FROM migration.migration_mappings WHERE workspace_id=$1",
      [run.workspace_id],
    )
  ).rows;
  if (mappings.length !== expected.size)
    throw new Error("source mapping count mismatch");
  for (const row of mappings) {
    const r = expected.get(key(row.source_type, row.source_id));
    if (
      !r ||
      row.digest !== r.digest ||
      row.cloud_id !== mappedId(inv.source_install_id, r.type, r.id)
    )
      throw new Error("source mapping integrity mismatch");
  }
}
function planInputs(plan, inv) {
  if (
    plan.source_digest !== inv.digest ||
    plan.source_install_id !== inv.source_install_id ||
    plan.version !== 1 ||
    plan.reviewed_current_grants !== true ||
    typeof plan.reviewer !== "string" ||
    !plan.reviewer.trim()
  )
    throw new Error("reviewed explicit identity/grant plan required");
  if (
    !Array.isArray(plan.members) ||
    !Array.isArray(plan.authors) ||
    !Array.isArray(plan.rooms)
  )
    throw new Error("explicit mapping arrays required");
  const records = new Map(inv.records.map((r) => [key(r.type, r.id), r]));
  const evidence = (e) => {
    const r = records.get(key(e?.type, e?.id));
    if (!r || r.digest !== e.digest)
      throw new Error("mapping evidence mismatch");
    return parse(r);
  };
  // A deleted bot leaves only its stamped messages: the evidence binds the
  // exact sorted set of messages that name it, and no bot record may exist.
  let stamped;
  const retired = (e) => {
    stamped ??= botMessageIds(inv);
    const ids = stamped.get(e?.id);
    if (
      typeof e?.id !== "string" ||
      records.has(key("bot", e.id)) ||
      !ids?.length ||
      retiredBotEvidence(e.id, ids).digest !== e.digest
    )
      throw new Error("retired bot evidence mismatch");
    return { id: e.id, retired: true };
  };
  const botThreads = new Map();
  for (const r of inv.records)
    if (r.type === "bot")
      for (const t of botThreadIds(parse(r)))
        botThreads.set(t, [...(botThreads.get(t) ?? []), r.id]);
  const members = new Map(),
    authors = new Map(),
    threads = new Map(),
    rooms = new Set();
  for (const m of plan.members ?? []) {
    if (
      !validId(m.account_id) ||
      !["owner", "admin", "member", "guest"].includes(m.role) ||
      members.has(m.account_id)
    )
      throw new Error("invalid or duplicate member");
    evidence(m.evidence);
    members.set(m.account_id, m);
  }
  if (![...members.values()].some((m) => m.role === "owner"))
    throw new Error("explicit owner required");
  for (const a of plan.authors ?? []) {
    if (
      typeof a.source_author !== "string" ||
      authors.has(a.source_author) ||
      !validId(a.account_id) ||
      typeof a.issuer !== "string" ||
      typeof a.subject !== "string"
    )
      throw new Error("invalid or duplicate author");
    const source =
      a.evidence?.type === "retired_bot"
        ? retired(a.evidence)
        : evidence(a.evidence);
    const sourceContact = source.actor
      ? `${source.actor.homeId}:${source.actor.kind}:${source.actor.localId}`
      : null;
    if (
      a.source_author.startsWith("human:") &&
      !(
        (a.evidence.type === "actor" &&
          (source.id ?? source.personId) === a.source_author.slice(6)) ||
        (a.evidence.type === "membership" &&
          source.actorId === a.source_author.slice(6)) ||
        (a.evidence.type === "shared_message" &&
          source.actor?.kind === "person" &&
          sourceContact === a.source_author.slice(6))
      )
    )
      throw new Error("human source evidence mismatch");
    if (
      a.source_author.startsWith("bot:") &&
      !(
        (a.evidence.type === "bot" && source.id === a.source_author.slice(4)) ||
        (a.evidence.type === "retired_bot" &&
          source.id === a.source_author.slice(4)) ||
        (a.evidence.type === "shared_message" &&
          source.actor?.kind === "bot" &&
          sourceContact === a.source_author.slice(4))
      )
    )
      throw new Error("bot source evidence mismatch");
    if (
      a.source_author.startsWith("message:") &&
      (a.evidence.type !== "message" ||
        a.evidence.id !== a.source_author.slice(8))
    )
      throw new Error("message source evidence mismatch");
    if (!/^(human:|bot:|message:)/.test(a.source_author))
      throw new Error("unknown source author kind");
    authors.set(a.source_author, a);
  }
  for (const m of members.values()) {
    if (m.evidence?.type !== "membership")
      throw new Error("member role evidence required");
    const source = evidence(m.evidence),
      actor = source.actorId ?? source.id;
    if (
      (source.role === "client-guest" ? "guest" : source.role) !== m.role ||
      authors.get("human:" + actor)?.account_id !== m.account_id
    )
      throw new Error("member role or actor binding mismatch");
    members.set(m.account_id, { ...m, source_actor_id: actor });
  }
  for (const r of plan.rooms ?? []) {
    const sourceType = r.source_type ?? "room";
    if (!Object.hasOwn(ROOM_SOURCES, sourceType))
      throw new Error("unsupported source room type");
    const recordType = ROOM_SOURCES[sourceType].record;
    const source = records.get(key(recordType, r.source_id));
    if (!source || rooms.has(key(sourceType, r.source_id)))
      throw new Error("unknown or duplicate room");
    rooms.add(key(sourceType, r.source_id));
    if (
      r.evidence?.type !== recordType ||
      r.evidence.id !== r.source_id ||
      !Array.isArray(r.thread_ids) ||
      !Array.isArray(r.grants)
    )
      throw new Error("room evidence mismatch");
    evidence(r.evidence);
    const original = parse(source),
      allowedThreads = new Set(
        sourceType === "bot_threads"
          ? botThreadIds(original)
          : [
              sourceType === "shared_room" ? original.id : original.threadId,
              ...(original.tasks ?? []).map((t) => t.threadId),
            ].filter(Boolean),
      );
    for (const t of r.thread_ids ?? []) {
      if (typeof t !== "string" || !allowedThreads.has(t) || threads.has(t))
        throw new Error("unowned or duplicate source thread");
      const sourceThread = records.get(key("thread", t));
      const owners = sourceThread && threadOwners(parse(sourceThread));
      if (
        !sourceThread ||
        (sourceType === "bot_threads"
          ? owners.length !== 0 || botThreads.get(t)?.length !== 1
          : owners.length !== 1 ||
            owners[0].type !== sourceType ||
            owners[0].id !== r.source_id)
      )
        throw new Error("ambiguous thread ownership");
      threads.set(t, r);
    }
    const grants = new Set();
    for (const g of r.grants ?? []) {
      if (!members.has(g.account_id) || grants.has(g.account_id))
        throw new Error("unknown or duplicate grant");
      evidence(g.evidence);
      if (sourceType === "bot_threads") {
        // A legacy 1:1 bot thread was the owner's alone.
        if (
          members.get(g.account_id).role !== "owner" ||
          g.evidence.type !== "bot" ||
          g.evidence.id !== r.source_id
        )
          throw new Error("room grant evidence mismatch");
        grants.add(g.account_id);
        continue;
      }
      if (
        g.evidence.type !== sourceType ||
        g.evidence.id !== r.source_id ||
        !(
          sourceType === "shared_room" ? original.memberIds : original.peopleIds
        )?.includes(members.get(g.account_id).source_actor_id)
      )
        throw new Error("room grant evidence mismatch");
      grants.add(g.account_id);
    }
  }
  // The cloud service has no per-room privacy for non-guests: owner-only 1:1
  // bot history may not be projected into a workspace other members can read.
  if (
    plan.rooms.some((r) => r.source_type === "bot_threads") &&
    [...members.values()].some((m) => !["owner", "guest"].includes(m.role))
  )
    throw new Error("private bot rooms require owner and guest members only");
  return { members, authors, threads, records };
}
/** Source author key of a serving view; a 1:1 bot thread's unstamped bot replies are its bot's. */
export function sourceAuthor(m, id, room) {
  if (m.role === "bot")
    return m.from?.botId
      ? "bot:" + m.from.botId
      : room?.source_type === "bot_threads"
        ? "bot:" + room.source_id
        : "message:" + id;
  if (m.role === "user")
    return m.sender?.id ? "human:" + m.sender.id : "message:" + id;
  return null;
}
export function servingView(r) {
  const m = parse(r);
  if (r.type === "message") return m;
  const actor = m.actor;
  const valid =
    actor &&
    /^[A-Za-z0-9_-]{1,128}$/.test(actor.homeId ?? "") &&
    /^[A-Za-z0-9_-]{1,128}$/.test(actor.localId ?? "") &&
    ["person", "bot"].includes(actor.kind);
  const actorId = valid
    ? `${actor.homeId}:${actor.kind}:${actor.localId}`
    : null;
  return {
    ...m,
    thread_id: m.roomId,
    role:
      actor?.kind === "person" ? "user" : actor?.kind === "bot" ? "bot" : null,
    sender: actorId && actor.kind === "person" ? { id: actorId } : undefined,
    from: actorId && actor.kind === "bot" ? { botId: actorId } : undefined,
    deleted: m.deletedAt !== undefined,
    replyToId: m.replyTo,
  };
}
async function project(c, run, inv, plan, dir, options) {
  const w = run.workspace_id,
    inputs = planInputs(plan, inv),
    planDigest = hash(JSON.stringify(plan)),
    store = objectStore(options.objectStorePath),
    attachments = attachmentContext(inv, dir, store, options.scan);
  const old = (
    await c.query(
      "SELECT * FROM migration.serving_projections WHERE workspace_id=$1",
      [w],
    )
  ).rows[0];
  if (old) {
    if (old.plan_digest !== planDigest)
      throw new Error("projection plan conflict");
    const actual = await digests(c, w);
    if (
      actual.projection_digest !== old.projection_digest ||
      actual.quarantine_digest !== old.quarantine_digest
    )
      throw new Error("projection integrity mismatch");
    return {
      ...actual,
      ...(await verifyAttachmentObjects(c, w, store)),
      state: "projected",
      idempotent: true,
    };
  }
  if (
    (await c.query("SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1", [w]))
      .rowCount
  )
    throw new Error("target workspace must be empty");
  // Binding only existing issuer-verified accounts prevents invented identities.
  for (const a of inputs.authors.values()) {
    const row = (
      await c.query("SELECT * FROM cloud.accounts WHERE account_id=$1", [
        a.account_id,
      ])
    ).rows[0];
    if (!row || row.issuer !== a.issuer || row.subject !== a.subject)
      throw new Error("author issuer binding mismatch");
  }
  for (const m of inputs.members.values())
    if (
      !(
        await c.query("SELECT 1 FROM cloud.accounts WHERE account_id=$1", [
          m.account_id,
        ])
      ).rowCount
    )
      throw new Error("member account must already exist");
  await c.query("INSERT INTO cloud.workspaces VALUES($1,$2,$3)", [
    w,
    plan.name ?? "migrated workspace",
    String(run.epoch),
  ]);
  await c.query("INSERT INTO cloud.migration_authority VALUES($1,'staged')", [
    w,
  ]);
  for (const m of inputs.members.values())
    await c.query("INSERT INTO cloud.members VALUES($1,$2,$3)", [
      w,
      m.account_id,
      m.role,
    ]);
  const roomIds = new Map();
  for (const r of plan.rooms) {
    const id = mappedId(
      inv.source_install_id,
      r.source_type ?? "room",
      r.source_id,
    );
    roomIds.set(key(r.source_type ?? "room", r.source_id), id);
    await c.query(
      "INSERT INTO cloud.rooms(workspace_id,room_id,name) VALUES($1,$2,$3)",
      [
        w,
        id,
        parse(
          inputs.records.get(
            key(ROOM_SOURCES[r.source_type ?? "room"].record, r.source_id),
          ),
        ).name ?? r.source_id,
      ],
    );
    for (const t of r.thread_ids)
      await c.query("INSERT INTO cloud.threads VALUES($1,$2,$3,false)", [
        w,
        id,
        mappedId(inv.source_install_id, "thread", t),
      ]);
    for (const g of r.grants)
      await c.query("INSERT INTO cloud.room_grants VALUES($1,$2,$3)", [
        w,
        id,
        g.account_id,
      ]);
  }
  const eligible = new Map(),
    conflicts = new Set(inv.conflicts);
  for (const r of inv.records.filter((r) =>
    ["message", "shared_message"].includes(r.type),
  )) {
    const m = servingView(r),
      room = inputs.threads.get(m.thread_id),
      a = inputs.authors.get(sourceAuthor(m, r.id, room)),
      member = a && inputs.members.get(a.account_id);
    let reason, attach;
    if (
      r.type === "shared_message" &&
      inv.pending_shared_journals.includes(m.thread_id)
    )
      reason = "shared_journal_requires_consolidation";
    else if (conflicts.has(r.id)) reason = "conflicting_copy";
    else if (
      !room ||
      ROOM_SOURCES[room.source_type ?? "room"].messages !== r.type
    )
      reason = "unmapped_room_or_thread";
    // Payload before author: tool calls, approvals and receipts never serve,
    // whoever wrote them.
    else if (payloadReason(m)) reason = payloadReason(m);
    else if (!a) reason = "unknown_author";
    else if (
      !member ||
      (member.role === "guest" &&
        !room.grants.some((g) => g.account_id === a.account_id))
    )
      reason = "missing_current_grant";
    else if (
      (attach = await planAttachments(attachments, r.type, r.id, m))?.reason
    )
      reason = attach.reason;
    else if (
      !Number.isFinite(m.at) ||
      !Number.isFinite(new Date(m.at).getTime()) ||
      !Number.isSafeInteger(m.version ?? 1) ||
      (m.version ?? 1) < 1 ||
      (m.deleted !== undefined && typeof m.deleted !== "boolean")
    )
      reason = "invalid_source_version_or_time";
    if (reason) {
      await quarantine(c, w, r.type, r.id, reason);
      await markReferences(c, w, attach?.failed);
      continue;
    }
    eligible.set(r.id, { r, m, a, room, attach });
  }
  // A missing/conflicting quoted message never gets a fabricated reply target.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, v] of eligible) {
      if (
        v.m.replyToId &&
        !eligible.has(JSON.stringify([v.m.thread_id, v.m.replyToId]))
      ) {
        eligible.delete(id);
        await quarantine(c, w, v.r.type, id, "unmapped_reply");
        changed = true;
      }
    }
  }
  const heads = new Map();
  for (const v of [...eligible.values()].sort(
    (a, b) => a.r.order - b.r.order || a.r.id.localeCompare(b.r.id),
  )) {
    const { r, m, a, room, attach } = v,
      roomId = roomIds.get(key(room.source_type ?? "room", room.source_id)),
      threadId = mappedId(inv.source_install_id, "thread", m.thread_id),
      seq = (heads.get(roomId) ?? 0) + 1;
    heads.set(roomId, seq);
    // Mentions remain inert; original chips and attribution stay in the private
    // provenance ledger. History never passes through send or a work queue.
    await c.query(
      `INSERT INTO cloud.messages(workspace_id,room_id,thread_id,message_id,actor_id,client_operation_id,sequence,version,text,mentions,deleted,created_at,bot_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::json,'[]',$10,$11,$12)`,
      [
        w,
        roomId,
        threadId,
        mappedId(inv.source_install_id, r.type, r.id),
        a.account_id,
        "migration." + mappedId(inv.source_install_id, r.type, r.id),
        seq,
        m.version ?? 1,
        JSON.stringify(m.deleted ? "" : m.text),
        m.deleted === true,
        new Date(m.at).toISOString(),
        sourceAuthor(m, r.id, room).startsWith("bot:")
          ? mappedId(
              inv.source_install_id,
              "bot",
              sourceAuthor(m, r.id, room).slice(4),
            )
          : null,
      ],
    );
    await c.query(
      "DELETE FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3",
      [w, r.type, r.id],
    );
    if (attach) {
      await markReferences(c, w, attach.failed);
      await transferAttachments(
        c,
        attachments,
        w,
        {
          room_id: roomId,
          thread_id: threadId,
          message_id: mappedId(inv.source_install_id, r.type, r.id),
          owner_id: a.account_id,
          created_at: new Date(m.at).toISOString(),
        },
        attach.items,
      );
    }
  }
  for (const v of eligible.values())
    if (v.m.replyToId)
      await c.query(
        "UPDATE cloud.messages SET reply_to_message_id=$3 WHERE workspace_id=$1 AND message_id=$2",
        [
          w,
          mappedId(inv.source_install_id, v.r.type, v.r.id),
          mappedId(
            inv.source_install_id,
            eligible.get(JSON.stringify([v.m.thread_id, v.m.replyToId])).r.type,
            JSON.stringify([v.m.thread_id, v.m.replyToId]),
          ),
        ],
      );
  for (const [r, head] of heads)
    await c.query(
      "UPDATE cloud.rooms SET head=$3 WHERE workspace_id=$1 AND room_id=$2",
      [w, r, head],
    );
  const resolved = new Set();
  for (const m of inputs.members.values())
    resolved.add(key(m.evidence.type, m.evidence.id));
  for (const a of inputs.authors.values())
    if (["actor", "bot", "membership"].includes(a.evidence.type))
      resolved.add(key(a.evidence.type, a.evidence.id));
  for (const r of plan.rooms) {
    resolved.add(key(ROOM_SOURCES[r.source_type ?? "room"].record, r.source_id));
    for (const t of r.thread_ids) resolved.add(key("thread", t));
  }
  for (const entry of resolved) {
    const [type, id] = JSON.parse(entry);
    await c.query(
      "DELETE FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3",
      [w, type, id],
    );
  }
  const actual = await digests(c, w);
  await c.query(
    "INSERT INTO migration.serving_projections(workspace_id,plan,plan_digest,projection_digest,quarantine_digest) VALUES($1,$2::json,$3,$4,$5)",
    [
      w,
      JSON.stringify(plan),
      planDigest,
      actual.projection_digest,
      actual.quarantine_digest,
    ],
  );
  await c.query(
    "UPDATE migration.migration_runs SET projection_verified=false WHERE workspace_id=$1",
    [w],
  );
  return { ...actual, state: "projected", idempotent: false };
}
export async function rollbackProjection(c, w, store = null) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM migration.serving_projections WHERE workspace_id=$1",
        [w],
      )
    ).rowCount
  )
    return sweepObjects(w, store);
  await transaction(c, async () => {
    const authority = (
      await c.query(
        "SELECT * FROM cloud.migration_authority WHERE workspace_id=$1 FOR UPDATE",
        [w],
      )
    ).rows[0];
    if (!authority) return;
    if (authority.state !== "staged") throw new Error("forward repair only");
    await rollbackAttachments(c, w, store);
    for (const table of [
      "messages",
      "room_grants",
      "threads",
      "members",
      "rooms",
      "migration_authority",
      "workspaces",
    ])
      await c.query(`DELETE FROM cloud.${table} WHERE workspace_id=$1`, [w]);
  });
}
export async function servingAction(c, dir, run, inv, action, options, flag) {
  const w = run.workspace_id;
  await assertFreeze(dir, run);
  if (!["validated", "cloud_active", "legacy_archived"].includes(run.state))
    throw new Error("validate source first");
  await assertStaging(c, run, inv);
  if (action === "project") {
    if (run.state !== "validated")
      throw new Error("projection frozen after cutover");
    if (!options.plan) throw new Error("explicit plan required");
    return transaction(c, () => project(c, run, inv, options.plan, dir, options));
  }
  const projection = (
    await c.query(
      "SELECT * FROM migration.serving_projections WHERE workspace_id=$1",
      [w],
    )
  ).rows[0];
  if (
    projection &&
    hash(JSON.stringify(projection.plan)) !== projection.plan_digest
  )
    throw new Error("projection plan integrity mismatch");
  if (!projection)
    throw new Error(
      "serving projection and independent acceptance required before cutover",
    );
  if (action === "verify-projection") {
    if (run.state !== "validated") throw new Error("verify before cutover");
    const actual = await digests(c, w);
    if (
      actual.projection_digest !== projection.projection_digest ||
      actual.quarantine_digest !== projection.quarantine_digest
    )
      throw new Error("projection integrity mismatch");
    const objects = await verifyAttachmentObjects(
      c,
      w,
      objectStore(options.objectStorePath),
    );
    await c.query(
      "UPDATE migration.migration_runs SET projection_verified=true WHERE workspace_id=$1",
      [w],
    );
    return {
      ...actual,
      ...objects,
      state: "projection_verified",
      source_digest: inv.digest,
      plan_digest: projection.plan_digest,
    };
  }
  if (action === "cutover") {
    if (run.state === "legacy_archived") throw new Error("already archived");
    if (run.state === "validated")
      await transaction(c, async () => {
        // Same authority lock used by all serving writes and publication.
        await c.query(
          "SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE",
          [w],
        );
        const actual = await digests(c, w),
          a = options.acceptance;
        if (
          !run.projection_verified ||
          !a ||
          typeof a.reviewer !== "string" ||
          !a.reviewer.trim() ||
          a.reviewer === projection.plan.reviewer ||
          a.source_digest !== inv.digest ||
          a.plan_digest !== projection.plan_digest ||
          a.projection_digest !== actual.projection_digest ||
          a.projection_digest !== projection.projection_digest ||
          a.quarantine_digest !== actual.quarantine_digest ||
          a.quarantine_digest !== projection.quarantine_digest ||
          !/^[a-f0-9]{64}$/.test(a.evidence_digest ?? "")
        )
          throw new Error("independent digest-bound acceptance required");
        const epoch = String(BigInt(run.epoch) + 1n);
        await c.query(
          "UPDATE cloud.workspaces SET epoch=$2 WHERE workspace_id=$1",
          [w, epoch],
        );
        await c.query(
          "UPDATE cloud.migration_authority SET state='active' WHERE workspace_id=$1",
          [w],
        );
        const rooms = (
          await c.query(
            "SELECT room_id,head FROM cloud.rooms WHERE workspace_id=$1 ORDER BY room_id",
            [w],
          )
        ).rows;
        for (const room of rooms) {
          const event = mappedId(inv.source_install_id, "authority_changed", w),
            sequence = String(BigInt(room.head) + 1n);
          await c.query(
            "INSERT INTO cloud.room_events VALUES($1,$2,$3,$4,NULL,'authority_changed',$5::json)",
            [
              w,
              room.room_id,
              event,
              sequence,
              JSON.stringify({
                workspace_id: w,
                epoch,
                reason: "migration_cutover",
              }),
            ],
          );
          await c.query(
            "UPDATE cloud.rooms SET head=$3,policy_revision=policy_revision+1 WHERE workspace_id=$1 AND room_id=$2",
            [w, room.room_id, sequence],
          );
          await c.query("INSERT INTO cloud.outbox VALUES($1,$2,$3)", [
            w,
            room.room_id,
            event,
          ]);
          await c.query(
            "INSERT INTO cloud.work_queue(workspace_id,room_id,event_id) VALUES($1,$2,$3)",
            [w, room.room_id, event],
          );
        }
        await c.query(
          "UPDATE migration.serving_projections SET acceptance=$2::json WHERE workspace_id=$1",
          [w, JSON.stringify(a)],
        );
        await c.query(
          "UPDATE migration.migration_runs SET state='cloud_active',epoch=$2 WHERE workspace_id=$1",
          [w, epoch],
        );
        run.epoch = epoch;
      });
    // Database first: a crash leaves the legacy writer frozen, never dual-active.
    const current = (
      await c.query(
        "SELECT * FROM migration.migration_runs WHERE workspace_id=$1",
        [w],
      )
    ).rows[0];
    await flag(dir, current, "cloud_active");
    return { state: "cloud_active", epoch: String(current.epoch) };
  }
  if (action === "archive") {
    if (!["cloud_active", "legacy_archived"].includes(run.state))
      throw new Error("cutover before archive");
    const archive = {
      workspace_id: w,
      epoch: String(run.epoch),
      source_digest: inv.digest,
      records: inv.records.length,
      retained: true,
    };
    const file = join(dir, "migration-archive.json");
    await writeFile(file + ".tmp", JSON.stringify(archive), { mode: 0o600 });
    const handle = await open(file + ".tmp", "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(file + ".tmp", file);
    await c.query(
      "UPDATE migration.serving_projections SET archive=$2::json WHERE workspace_id=$1",
      [w, JSON.stringify(archive)],
    );
    await c.query(
      "UPDATE migration.migration_runs SET state='legacy_archived' WHERE workspace_id=$1",
      [w],
    );
    await flag(dir, run, "legacy_archived");
    return { state: "legacy_archived", ...archive };
  }
  throw new Error("unknown serving action");
}
