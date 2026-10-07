import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export const METADATA_FILES = [
  "groups.json",
  "bots.json",
  "multiplayer-actors.json",
  "multiplayer-links.json",
  "shared-rooms.json",
  "workspace-membership.json",
  "trusted-peers.json",
  "work-runtime.json",
];
export async function scanInventory(dir) {
  const marker = JSON.parse(
    await readFile(join(dir, ".bos-migration-copy.json"), "utf8"),
  );
  if (typeof marker.source_install_id !== "string" || !marker.source_install_id)
    throw new Error("stable source_install_id required");
  const records = [],
    seen = new Map(),
    conflicts = new Set(),
    sqliteThreads = new Set(),
    pendingSharedJournals = new Set();
  let nextOrder = 0;
  const add = (type, id, payload, order = null) => {
    if (typeof id !== "string" || !id) throw new Error("source id required");
    const key = JSON.stringify([type, id]),
      encoded = JSON.stringify(payload),
      digest = hash(encoded);
    if (seen.has(key)) throw new Error("duplicate source identity");
    const r = { type, id, encoded, digest, order };
    records.push(r);
    seen.set(key, r);
    return r;
  };
  const message = (thread, m, order, origin) => {
    if (typeof m?.id !== "string" || !thread)
      throw new Error("invalid transcript identity");
    const id = JSON.stringify([thread, m.id]),
      payload = { ...m, thread_id: thread };
    const prior = seen.get(JSON.stringify(["message", id]));
    if (prior) {
      if (prior.encoded !== JSON.stringify(payload)) {
        conflicts.add(id);
        add("conflict", JSON.stringify([id, origin]), {
          message_source_id: id,
          origin,
          payload,
        });
      }
      return;
    }
    add("message", id, payload, order);
    if (origin !== "sqlite" && sqliteThreads.has(thread)) {
      conflicts.add(id);
      add("conflict", JSON.stringify([id, origin]), {
        message_source_id: id,
        origin,
        payload,
      });
    }
    if (Array.isArray(m.attachments))
      for (let n = 0; n < m.attachments.length; n++)
        add("attachment_reference", JSON.stringify([id, n]), {
          message_source_id: id,
          reference: m.attachments[n],
        });
  };
  const types = [
    "room",
    "bot",
    "actor",
    "link",
    "shared_room",
    "membership",
    "home",
    "pending_run",
  ];
  for (let n = 0; n < METADATA_FILES.length; n++) {
    const file = METADATA_FILES[n],
      p = join(dir, file);
    let value = [];
    const st = await lstat(p).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (st) {
      if (!st.isFile()) throw new Error("metadata must be a regular copy file");
      value = JSON.parse(await readFile(p, "utf8"));
    }
    add("metadata", file, value);
    if (Array.isArray(value)) {
      for (const row of value) if (row?.id) add(types[n], row.id, row);
    } else if (value?.version === 1) {
      if (file === "multiplayer-actors.json") {
        const people = new Map();
        for (const binding of value.bindings ?? []) {
          if (typeof binding.personId !== "string")
            throw new Error("invalid actor binding");
          const list = people.get(binding.personId) ?? [];
          list.push(binding);
          people.set(binding.personId, list);
        }
        for (const [personId, bindings] of people)
          add("actor", personId, { personId, bindings });
      }
      if (file === "workspace-membership.json") {
        if (typeof value.ownerId === "string")
          add("membership", value.ownerId, {
            actorId: value.ownerId,
            role: "owner",
          });
        for (const member of value.members ?? [])
          add("membership", member.actorId, member);
        for (const grant of value.roomBotGrants ?? [])
          add("bot_grant", grant.roomId, grant);
      }
      if (file === "multiplayer-links.json")
        for (const link of value.links ?? []) add("link", link.homeId, link);
      if (file === "trusted-peers.json")
        for (const session of value.sessions ?? [])
          add("home", session, { sessionId: session });
      if (file === "shared-rooms.json")
        for (const entry of value.rooms ?? []) {
          add("shared_room", entry.room.id, entry.room);
          for (const m of entry.messages ?? []) {
            const id = JSON.stringify([entry.room.id, m.id]);
            add("shared_message", id, m, nextOrder++);
            for (let i = 0; i < (m.attachments ?? []).length; i++)
              add("attachment_reference", JSON.stringify(["shared", id, i]), {
                message_source_id: id,
                reference: m.attachments[i],
              });
          }
        }
    }
  }
  const journalPath = join(dir, "shared-rooms.json.events");
  if (
    await lstat(journalPath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    })
  ) {
    if (!(await lstat(journalPath)).isFile())
      throw new Error("shared journal must be a regular copy file");
    const journal = await readFile(journalPath, "utf8");
    add("shared_room_journal", "shared-rooms.json.events", journal);
    for (const [index, line] of journal.split("\n").entries())
      if (line) {
        const entry = JSON.parse(line);
        if (typeof entry.roomId !== "string")
          throw new Error("invalid shared journal");
        pendingSharedJournals.add(entry.roomId);
        add("shared_journal_entry", String(index), entry);
      }
  }
  const dbPath = join(dir, "messages.db"),
    dbStat = await lstat(dbPath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
  if (dbStat) {
    if (!dbStat.isFile())
      throw new Error("database must be a regular copy file");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const row of db
        .prepare("SELECT thread_id,id,json FROM messages ORDER BY rowid")
        .iterate()) {
        const m = JSON.parse(row.json);
        if (m.id !== row.id)
          throw new Error("sqlite message identity mismatch");
        sqliteThreads.add(row.thread_id);
        message(row.thread_id, m, nextOrder++, "sqlite");
      }
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      );
      for (const table of ["thread_state", "chat_followups"])
        if (tables.has(table))
          for (const row of db
            .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
            .iterate())
            add(table, row.id ?? row.thread_id, row);
    } finally {
      db.close();
    }
  }
  for (const file of (await readdir(dir))
    .filter((f) => /^messages-.+\.json$/.test(f))
    .sort()) {
    const path = join(dir, file);
    if (!(await lstat(path)).isFile())
      throw new Error("transcript must be a regular copy file");
    const raw = JSON.parse(await readFile(path, "utf8")),
      thread = file.slice(9, -5),
      messages = Array.isArray(raw) ? raw : raw?.messages;
    if (!Array.isArray(messages)) throw new Error("invalid legacy transcript");
    add("transcript_file", file, raw);
    for (let n = 0; n < messages.length; n++)
      message(thread, messages[n], nextOrder++, file);
  }
  // Hash the complete owned attachment tree, including orphans and partials.
  // Symlinks are inventoried as unsafe; their targets are never read.
  async function walk(rel) {
    const st = await lstat(join(dir, rel));
    if (st.isSymbolicLink()) {
      add("attachment_file", rel, { path: rel, unsafe: "symlink" });
      return;
    }
    if (st.isDirectory()) {
      for (const name of (await readdir(join(dir, rel))).sort())
        await walk(join(rel, name));
      return;
    }
    if (!st.isFile()) {
      add("attachment_file", rel, { path: rel, unsafe: "non_regular" });
      return;
    }
    const h = createHash("sha256");
    for await (const bytes of createReadStream(join(dir, rel))) h.update(bytes);
    add("attachment_file", rel, {
      path: rel,
      size: st.size,
      checksum: h.digest("hex"),
    });
  }
  if (
    await lstat(join(dir, "attachments")).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    })
  )
    await walk("attachments");
  const threadOwners = new Map();
  for (const r of records) {
    const payload = JSON.parse(r.encoded);
    if (["room", "shared_room"].includes(r.type))
      for (const t of [
        r.type === "shared_room" ? payload.id : payload.threadId,
        ...(payload.tasks ?? []).map((t) => t.threadId),
      ].filter(Boolean)) {
        const owners = threadOwners.get(t) ?? [];
        owners.push({ type: r.type, id: r.id });
        threadOwners.set(t, owners);
      }
    if (r.type === "message" && !threadOwners.has(payload.thread_id))
      threadOwners.set(payload.thread_id, []);
    if (r.type === "shared_message" && !threadOwners.has(payload.roomId))
      threadOwners.set(payload.roomId, []);
  }
  for (const [thread_id, rooms] of threadOwners)
    add("thread", thread_id, { thread_id, rooms });
  records.sort(
    (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
  return {
    source_install_id: marker.source_install_id,
    records,
    conflicts: [...conflicts],
    pending_shared_journals: [...pendingSharedJournals],
    digest: hash(
      JSON.stringify(records.map((r) => [r.type, r.id, r.digest, r.order])),
    ),
  };
}
