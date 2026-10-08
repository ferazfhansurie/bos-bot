// Legacy attachment transfer for the serving projection. Bytes come only from
// the marked copy's owned `attachments/` tree, already hashed by the inventory;
// they land in the slice 4 object store under the same tenant-scoped key
// (`workspace|room|attachment`) and are re-read and hash-checked before a
// `ready` attachment_objects row links them to the migrated message. Nothing
// here dispatches, uploads through the send route or touches an invocation.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { LocalObjects } from "../objects.ts";
import {
  ATTACHMENT_LIMITS,
  attachmentObjectKey,
} from "../../../shared/cloud-protocol/index.ts";
import { mappedId } from "./tool.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const TYPES = new Set(ATTACHMENT_LIMITS.types);

/** Specific per-reference reasons. A message quarantines with the first one. */
export const ATTACHMENT_REASONS = [
  "attachment_unresolvable_reference",
  "attachment_outside_owned_tree",
  "attachment_missing",
  "attachment_unsafe",
  "attachment_empty",
  "attachment_too_large",
  "attachment_unsupported_type",
  "attachment_type_mismatch",
  "attachment_hash_mismatch",
  "attachment_scan_rejected",
];

export function objectStore(path) {
  if (!path) return null;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("absolute object store path required");
  // The legacy data dir is never written. Developer worktrees that happen to
  // sit under it (`task-workspaces/`) hold only disposable fixture state.
  const p = resolve(path),
    live = join(homedir(), ".bos-bot");
  if (
    p === live ||
    (p.startsWith(live + "/") && !p.startsWith(live + "/task-workspaces/"))
  )
    throw new Error("object store must not live in the legacy data dir");
  return new LocalObjects(p);
}

// Same type gate the legacy shared-attachment store applied on upload.
function matches(type, bytes) {
  if (type === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg")
    return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (type === "application/pdf")
    return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (type === "text/plain")
    return !bytes.includes(0) && bytes.subarray(0, 2).toString("latin1") !== "#!";
  return false;
}

/**
 * Legacy layout is flat: `<data dir>/attachments/<uuid>.<ext>`. A reference
 * resolves only when its parent directory is that tree; the bytes are then
 * bound by the inventory hash, never by the path's claim.
 */
export function ownedPath(reference) {
  const p = reference?.path;
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const n = posix.normalize(p.replace(/\\/g, "/"));
  const parts = n.split("/");
  const name = parts.at(-1);
  if (
    parts.length < 2 ||
    parts.at(-2) !== "attachments" ||
    !name ||
    name === "." ||
    name === ".." ||
    parts.includes("..") ||
    (!n.startsWith("/") && parts.length !== 2)
  )
    return { outside: true };
  return { rel: join("attachments", name) };
}

async function readOwned(dir, rel) {
  const path = join(dir, rel),
    st = await lstat(path);
  if (!st.isFile()) throw Object.assign(new Error("unsafe"), { unsafe: true });
  const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await h.readFile();
  } finally {
    await h.close();
  }
}

export function attachmentContext(inv, dir, store, scan) {
  const files = new Map(),
    refs = new Map();
  for (const r of inv.records) {
    if (r.type === "attachment_file") files.set(r.id, JSON.parse(r.encoded));
    if (r.type === "attachment_reference") {
      const p = JSON.parse(r.encoded),
        shared = JSON.parse(r.id)[0] === "shared",
        k = JSON.stringify([
          shared ? "shared_message" : "message",
          p.message_source_id,
        ]),
        list = refs.get(k) ?? [];
      list.push({ id: r.id, reference: p.reference });
      refs.set(k, list);
    }
  }
  for (const list of refs.values())
    list.sort((a, b) => JSON.parse(a.id).at(-1) - JSON.parse(b.id).at(-1));
  return { install: inv.source_install_id, dir, store, scan, files, refs };
}

async function check(ctx, ref) {
  const at = ownedPath(ref.reference);
  if (!at) return { reason: "attachment_unresolvable_reference" };
  if (at.outside) return { reason: "attachment_outside_owned_tree" };
  const file = ctx.files.get(at.rel);
  if (!file) return { reason: "attachment_missing" };
  if (file.unsafe) return { reason: "attachment_unsafe" };
  if (!(file.size > 0)) return { reason: "attachment_empty" };
  if (file.size > ATTACHMENT_LIMITS.bytes)
    return { reason: "attachment_too_large" };
  const type = ref.reference.mime ?? ref.reference.type;
  if (!TYPES.has(type)) return { reason: "attachment_unsupported_type" };
  let bytes;
  try {
    bytes = await readOwned(ctx.dir, at.rel);
  } catch (e) {
    if (e.unsafe || e.code === "ELOOP") return { reason: "attachment_unsafe" };
    if (e.code === "ENOENT") return { reason: "attachment_missing" };
    throw e;
  }
  if (bytes.length !== file.size || sha(bytes) !== file.checksum)
    return { reason: "attachment_hash_mismatch" };
  if (!matches(type, bytes)) return { reason: "attachment_type_mismatch" };
  // Optional operator scanner; its absence is recorded, never a pass.
  if (ctx.scan && (await ctx.scan(bytes, type)) !== "clean")
    return { reason: "attachment_scan_rejected" };
  const name =
    typeof ref.reference.name === "string" &&
    ref.reference.name.length >= 1 &&
    ref.reference.name.length <= 256
      ? ref.reference.name
      : basename(at.rel);
  return {
    ref,
    rel: at.rel,
    size: file.size,
    checksum: file.checksum,
    type,
    name,
  };
}

/**
 * Per-message verdict. `undefined` when the message has no references.
 * `reason` quarantines the message; `failed` lists per-reference reasons.
 * Deleted messages serve as tombstones without moving their bytes.
 */
export async function planAttachments(ctx, type, id, m) {
  const refs = ctx?.refs.get(JSON.stringify([type, id]));
  const n = Array.isArray(m.attachments) ? m.attachments.length : 0;
  if (!n && !refs?.length) return undefined;
  if (!ctx?.store) return { reason: "attachment_requires_verified_transfer" };
  if (!refs || refs.length !== n)
    return { reason: "attachment_unresolvable_reference" };
  if (m.deleted === true)
    return {
      items: [],
      failed: refs.map((ref) => ({ ref, reason: "attachment_of_deleted_message" })),
    };
  const items = [],
    failed = [];
  for (const ref of refs) {
    const v = await check(ctx, ref);
    if (v.reason) failed.push({ ref, reason: v.reason });
    else items.push(v);
  }
  return failed.length ? { reason: failed[0].reason, failed } : { items, failed };
}

export async function markReferences(c, w, failed) {
  for (const f of failed ?? [])
    await c.query(
      "UPDATE migration.migration_quarantine SET reason=$3 WHERE workspace_id=$1 AND source_type='attachment_reference' AND source_id=$2",
      [w, f.ref.id, f.reason],
    );
}

/** Write, re-read and verify, then insert `ready` rows linked to the message. */
export async function transferAttachments(c, ctx, w, msg, items) {
  const ids = [];
  for (const it of items) {
    const a = mappedId(ctx.install, "attachment_reference", it.ref.id),
      key = attachmentObjectKey(w, msg.room_id, a),
      bytes = await readOwned(ctx.dir, it.rel);
    // The copy is frozen; a change after inventory fails the whole projection.
    if (sha(bytes) !== it.checksum)
      throw new Error("attachment source changed; hold and reinventory");
    try {
      await ctx.store.put(key, bytes);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Rerun after a crash: an identical verified object is kept as is.
      if (sha(await ctx.store.get(key)) !== it.checksum)
        throw new Error("attachment object conflict");
    }
    const stored = await ctx.store.get(key);
    if (stored.length !== it.size || sha(stored) !== it.checksum)
      throw new Error("attachment object verification failed");
    await c.query(
      `INSERT INTO cloud.attachment_objects(workspace_id,room_id,thread_id,attachment_id,owner_id,object_key,name,size,type,checksum,state,expires_at,upload_expires_at,attached)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11::timestamptz+interval '24 hours',$11::timestamptz,true)`,
      [
        w,
        msg.room_id,
        msg.thread_id,
        a,
        msg.owner_id,
        key,
        it.name,
        it.size,
        it.type,
        it.checksum,
        msg.created_at,
      ],
    );
    await c.query("INSERT INTO cloud.message_attachments VALUES($1,$2,$3,$4)", [
      w,
      msg.room_id,
      msg.message_id,
      a,
    ]);
    for (const [type, id] of [
      ["attachment_reference", it.ref.id],
      ["attachment_file", it.rel],
    ])
      await c.query(
        "DELETE FROM migration.migration_quarantine WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3",
        [w, type, id],
      );
    ids.push(a);
  }
  if (ids.length)
    await c.query(
      "UPDATE cloud.messages SET attachment_ids=$4::jsonb WHERE workspace_id=$1 AND room_id=$2 AND message_id=$3",
      [w, msg.room_id, msg.message_id, JSON.stringify(ids)],
    );
  return ids;
}

/** Every projected object must still hash to its row. */
export async function verifyAttachmentObjects(c, w, store) {
  const rows = (
    await c.query(
      "SELECT object_key,size,checksum FROM cloud.attachment_objects WHERE workspace_id=$1 ORDER BY attachment_id",
      [w],
    )
  ).rows;
  if (rows.length && !store)
    throw new Error("object store required to verify transferred attachments");
  let bytes = 0;
  for (const r of rows) {
    let v;
    try {
      v = await store.get(r.object_key);
    } catch {
      throw new Error("attachment object missing");
    }
    if (v.length !== Number(r.size) || sha(v) !== r.checksum)
      throw new Error("attachment object integrity mismatch");
    bytes += v.length;
  }
  return { attachments: rows.length, attachment_bytes: bytes };
}

/**
 * Pre-cutover rollback: delete link/object rows and every byte stored under
 * this workspace's key prefix, including crash leftovers that never got a row.
 */
export async function rollbackAttachments(c, w, store) {
  const keys = (
    await c.query(
      "SELECT object_key FROM cloud.attachment_objects WHERE workspace_id=$1",
      [w],
    )
  ).rows.map((r) => r.object_key);
  if (keys.length && !store)
    throw new Error("object store required to roll back transferred attachments");
  await c.query("DELETE FROM cloud.message_attachments WHERE workspace_id=$1", [w]);
  await c.query("DELETE FROM cloud.attachment_objects WHERE workspace_id=$1", [w]);
  await sweepObjects(w, store, keys);
}

export async function sweepObjects(w, store, keys = []) {
  if (!store) return;
  for (const k of keys) await store.remove(k);
  const names = await readdir(store.root).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const n of names)
    if (n.startsWith(w + "|") && /^[A-Za-z0-9_-]+\|[A-Za-z0-9_-]+\|[A-Za-z0-9_-]+$/.test(n))
      await store.remove(n);
}
