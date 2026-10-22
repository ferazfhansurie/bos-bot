// Image attachments: pasted/dropped images become files under
// ~/.openmausbot/attachments so every CLI engine can open them by path —
// the app never ships image bytes through the prompt itself.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** The spec's ceiling: a screenshot bigger than this is rejected before it
 * is ever buffered, matching the composer's existing size discipline. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Shared documents are deliberately smaller than Cloudflare's transport
 * ceiling. This is a local inbox, not unbounded remote storage. */
export const FILE_MAX_BYTES = 90 * 1024 * 1024;

/** Quota pressure may reclaim old orphan uploads, never retained references. */
export const ATTACHMENTS_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Uploaded composer drafts have not necessarily reached the server's
 * transcript yet. Give them a full day before considering them orphans. */
export const ATTACHMENT_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Interrupted streamed uploads use private partial files. A crash can leave
 * one behind, so future uploads remove only our stale partials — never a
 * committed attachment that a transcript may still reference. */
export const ATTACHMENT_PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

const PARTIAL_NAME = /^\.bos-upload-[0-9a-f-]+-[0-9a-f-]+\.partial$/i;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activePartials = new Set<string>();
const uploadLocks = new Map<string, Promise<void>>();
let reservedAttachmentBytes = 0;
const STREAM_RESERVATION_INCREMENT_BYTES = 1024 * 1024;

/** Cached total of on-disk bytes that count against the quota: committed
 * attachments plus any partial file this process did not itself write (a
 * crash leftover, until it is cleaned up). `null` means a fresh scan is needed
 * after cold start or a cleanup failure. Every normal commit
 * and delete after that updates it in place instead of rescanning, which is
 * what makes reservation growth O(1) rather than O(directory size).
 *
 * This is single-process, in-memory state: it does not see files another
 * process adds or removes in ATTACHMENTS_DIR. That is an accepted limit
 * (the app runs one server per data dir; uploadLocks already assumes the
 * same), not a design gap this fix covers. */
let committedAttachmentBytes: number | null = null;
// An async link can finish while another upload invalidates or refreshes the
// cache. Its bytes must not be added again if a scan may already include it.
let attachmentAccountingVersion = 0;

/** Force a fresh disk total and invalidate any in-flight commit's snapshot. */
function invalidateAttachmentAccounting(): void {
  committedAttachmentBytes = null;
  attachmentAccountingVersion += 1;
}

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename. */
const IMAGE_MIMES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Useful document, audio and video formats accepted by the upload endpoint.
 * Generic archives, binaries, HTML, SVG, and executable/script mimes stay
 * out. Office/OpenDocument packages are allowed because they are documents,
 * despite using ZIP internally. The claimed mime determines the extension;
 * an attacker-controlled filename never does. */
const FILE_MIMES: Readonly<Record<string, string>> = {
  "audio/opus": ".opus",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/webm": ".webm",
  // Phone videos stream from app-owned files; oversized exports fit this ceiling.
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-m4v": ".m4v",
  "video/webm": ".webm",
  "text/plain": ".txt",
  "text/vtt": ".vtt",
  "application/x-subrip": ".srt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
};

/** The mime a shared file with this extension is uploaded as (the first
 * FILE_MIMES entry for it), or null when the extension is not a shared file. */
export function fileMimeForExtension(extension: string): string | null {
  const wanted = extension.toLowerCase();
  return Object.entries(FILE_MIMES).find(([, ext]) => ext === wanted)?.[0] ?? null;
}

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return IMAGE_MIMES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function ensureAttachmentsDir(): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

export function validateAttachmentUploadId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!UPLOAD_ID.test(normalized)) {
    throw statusError(400, "uploadId must be a UUID");
  }
  return normalized;
}

/** The one full directory walk. Run from cold or invalidated accounting,
 * or from an explicit cleanup sweep — never
 * from the per-reservation hot path, which is what made PERF-03 quadratic. */
function scanAttachmentUsageAndCleanup(now = Date.now()): { bytes: number; removed: number } {
  ensureAttachmentsDir();
  let bytes = 0;
  let removed = 0;
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    // A live partial is represented by its in-memory reservation. A fresh
    // orphan from a crashed process still occupies disk and therefore counts
    // until this same scan is allowed to remove it.
    if (PARTIAL_NAME.test(entry.name) && activePartials.has(path)) continue;
    try {
      const stat = statSync(path);
      if (PARTIAL_NAME.test(entry.name) && now - stat.mtimeMs >= ATTACHMENT_PARTIAL_MAX_AGE_MS) {
        unlinkSync(path);
        removed += 1;
      } else {
        bytes += stat.size;
      }
    } catch {
      // A concurrent cleanup or manual removal made this entry consume zero.
    }
  }
  return { bytes, removed };
}

/** Return cached usage, initializing it from disk after cold start or
 * invalidation. Reservations must use this rather than trusting a cold cache. */
function committedBytes(): number {
  if (committedAttachmentBytes === null) {
    committedAttachmentBytes = scanAttachmentUsageAndCleanup().bytes;
    attachmentAccountingVersion += 1;
  }
  return committedAttachmentBytes;
}

/** A newly committed file (saveFile/saveImage success path only — never the
 * idempotent-retry branches, which reuse bytes already counted) adds to the
 * cache. If accounting changed during an async link, a scan may already have
 * counted that file. Let the next reservation rescan instead of adding twice. */
function addCommittedBytes(delta: number, version = attachmentAccountingVersion): void {
  if (version !== attachmentAccountingVersion || committedAttachmentBytes === null) {
    invalidateAttachmentAccounting();
    return;
  }
  committedAttachmentBytes += delta;
}

/** Remove only abandoned temporary uploads, and refresh the cached usage
 * total from the same fresh scan. Outside accounting recovery, this is the
 * only full directory walk after start-up; nothing on the upload path calls it
 * per byte or per chunk anymore, so callers that want stale partials
 * reclaimed promptly should invoke it on their own schedule. */
export function cleanupStaleAttachmentPartials(now = Date.now()): number {
  const { bytes, removed } = scanAttachmentUsageAndCleanup(now);
  committedAttachmentBytes = bytes;
  attachmentAccountingVersion += 1;
  return removed;
}

/** Delete a committed attachment (e.g. a generated image whose owning
 * message/turn was retired) and keep the quota cache in sync. Every caller
 * outside this module that removes a file saveImage/saveFile created must
 * route through here instead of a raw unlink, or the cache will overcount
 * forever and eventually reject uploads that should fit. */
export function deleteAttachment(path: string): void {
  try {
    // Only bother sizing it if the cache is already warm — if it isn't, the
    // eventual first scan just won't see this file, which is correct.
    const size = committedAttachmentBytes !== null ? statSync(path).size : 0;
    unlinkSync(path);
    if (committedAttachmentBytes !== null) {
      committedAttachmentBytes = Math.max(0, committedAttachmentBytes - size);
    }
  } catch {
    // Already gone, or never existed — nothing to reconcile.
  }
}

/** Test-only: force the next quota check to rescan the directory instead of
 * trusting the cache. Needed because tests mutate ATTACHMENTS_DIR directly
 * (truncateSync, rmSync, writeFileSync) to simulate quota states, which the
 * cache can't observe. */
export function __resetAttachmentAccountingForTests(): void {
  invalidateAttachmentAccounting();
}

/** A retry owns the same UUID namespace as the interrupted attempt. Once it
 * holds that UUID's in-process lock, any inactive partial with the prefix is
 * from a crashed/failed process and can be replaced immediately instead of
 * consuming quota for an hour. */
function cleanupAttachmentPartialsForUpload(uploadId: string): void {
  ensureAttachmentsDir();
  const prefix = `.bos-upload-${uploadId}-`;
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !PARTIAL_NAME.test(entry.name)) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    if (activePartials.has(path)) continue;
    try {
      // Only bother sizing it if the cache is already warm — if it isn't,
      // the eventual first scan runs after this unlink and simply never
      // sees the file, so there is nothing to reconcile.
      const size = committedAttachmentBytes !== null ? statSync(path).size : 0;
      unlinkSync(path);
      if (committedAttachmentBytes !== null) {
        committedAttachmentBytes = Math.max(0, committedAttachmentBytes - size);
      }
    } catch {
      // A concurrent cleanup already removed the abandoned attempt.
    }
  }
}

class AttachmentReservation {
  private held = 0;
  private released = false;

  reserve(bytes: number): void {
    if (this.released || bytes <= 0) return;
    this.reserveAtLeast(bytes, bytes);
  }

  private reserveAtLeast(required: number, preferred: number): void {
    let available = ATTACHMENTS_MAX_BYTES - committedBytes() - reservedAttachmentBytes;
    if (available < required) {
      reclaimUnreferencedAttachments(required - available);
      available = ATTACHMENTS_MAX_BYTES - committedBytes() - reservedAttachmentBytes;
    }
    if (available < required) {
      throw statusError(
        507,
        "Attachments storage is full (2 GiB limit). Remove unneeded conversations or scheduled attachment references, then retry. Referenced files and uploads from the last 24 hours are kept.",
      );
    }
    // Unknown-length HTTP bodies reserve in bounded chunks. Taking whatever
    // remains below the preferred increment avoids falsely rejecting a small
    // final upload near the quota while still bounding directory scans.
    const granted = Math.min(preferred, available);
    reservedAttachmentBytes += granted;
    this.held += granted;
  }

  ensure(bytes: number): void {
    if (bytes <= this.held) return;
    const required = bytes - this.held;
    const remainingPerFileCapacity = FILE_MAX_BYTES - this.held;
    const preferred = Math.min(
      Math.max(required, STREAM_RESERVATION_INCREMENT_BYTES),
      remainingPerFileCapacity,
    );
    this.reserveAtLeast(required, preferred);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    reservedAttachmentBytes -= this.held;
    this.held = 0;
  }
}

async function withUploadLock<T>(uploadId: string | undefined, operation: () => Promise<T>): Promise<T> {
  if (!uploadId) return operation();
  const previous = uploadLocks.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  uploadLocks.set(uploadId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (uploadLocks.get(uploadId) === current) uploadLocks.delete(uploadId);
  }
}

/** Every committed attachment name is `${uuid}${extension}` for one of these
 * fixed extensions — saveFile/saveImage never write any other suffix — so
 * whether a given upload ID is already committed, and under which content
 * type, can be answered with a handful of direct stats instead of a scan
 * over every file in the directory. */
const KNOWN_ATTACHMENT_EXTENSIONS = Array.from(
  new Set([...Object.values(IMAGE_MIMES), ...Object.values(FILE_MIMES)]),
);

const RECOVERY_COPY = /^(?:messages\.db|bots\.json|groups\.json)\.(?:bak|corrupt-.+)$/;

/** Chunked so a large quarantined database never sits in memory whole; the
 * overlap keeps a name that straddles two chunks. latin1 maps bytes 1:1. */
function collectRaw(path: string, collect: (value: string) => void): void {
  const chunk = Buffer.alloc(1 << 20);
  const overlap = 128;
  const fd = openSync(path, "r");
  try {
    let carry = "";
    for (let position = 0; ; ) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (!read) break;
      position += read;
      const text = carry + chunk.toString("latin1", 0, read);
      collect(text);
      carry = text.slice(-overlap);
    }
  } finally { closeSync(fd); }
}

/** Scan authoritative persisted references only under quota pressure. Include
 * every SQLite row, not a history page or active branch; top-level JSON also
 * covers legacy transcripts, profiles, routine/call snapshots and handoffs.
 * Conservative filename matches retain extra files rather than risk deleting
 * one. A missing DB is a fresh workspace; an unreadable store fails closed. */
function retainedAttachmentNames(): Set<string> {
  const names = new Set<string>();
  const collect = (value: string) => {
    for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+/gi)) {
      names.add(match[0].toLowerCase());
    }
  };
  for (const entry of readdirSync(DATA_DIR, { withFileTypes: true })) {
    // Quarantined and backup copies of the stores are what recovery restores
    // from; their attachments must outlive them. They may not parse or open,
    // so scan their raw bytes instead (SQLite stores TEXT as plain UTF-8).
    if (entry.isFile() && RECOVERY_COPY.test(entry.name)) { collectRaw(join(DATA_DIR, entry.name), collect); continue; }
    if (!entry.isFile() || !/\.json(?:\.imported)?$/.test(entry.name)) continue;
    const text = readFileSync(join(DATA_DIR, entry.name), "utf8");
    // Parsing also validates that reference enumeration did not silently
    // accept a truncated/corrupt persistence file.
    collect(JSON.stringify(JSON.parse(text)));
  }
  const dbPath = join(DATA_DIR, "messages.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
      if (!tables.has("messages")) throw new Error("Missing transcript table");
      for (const row of db.prepare("SELECT json FROM messages").iterate()) collect(JSON.stringify(JSON.parse(String(row.json))));
      if (tables.has("chat_followups")) {
        for (const row of db.prepare("SELECT payload FROM chat_followups").iterate()) collect(JSON.stringify(JSON.parse(String(row.payload))));
      }
    } finally {
      db.close();
    }
  }
  return names;
}

function reclaimUnreferencedAttachments(requiredBytes: number): void {
  const cutoff = Date.now() - ATTACHMENT_PRUNE_MIN_AGE_MS;
  const candidates: { path: string; name: string; bytes: number; mtimeMs: number }[] = [];
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // never follow links or touch unknown files
    const extension = extname(entry.name);
    const id = entry.name.slice(0, -extension.length);
    if (!UPLOAD_ID.test(id) || !KNOWN_ATTACHMENT_EXTENSIONS.includes(extension) || uploadLocks.has(id)) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    const stat = statSync(path);
    if (stat.mtimeMs > cutoff) continue;
    candidates.push({ path, name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (!candidates.length) return;
  let references: Set<string>;
  try {
    references = retainedAttachmentNames();
  } catch {
    throw statusError(507, "Attachments storage is full, and cleanup could not verify saved references. No attachments were removed. Repair the workspace storage, then retry.");
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let reclaimed = 0;
  for (const candidate of candidates) {
    if (references.has(candidate.name.toLowerCase())) continue;
    try {
      unlinkSync(candidate.path);
      if (committedAttachmentBytes !== null) committedAttachmentBytes = Math.max(0, committedAttachmentBytes - candidate.bytes);
      reclaimed += candidate.bytes;
    } catch {
      // A locked file is retained; its bytes continue to count toward quota.
    }
    if (reclaimed >= requiredBytes) break;
  }
}

/** Missing or unreadable candidates count as absent here; the atomic link
 * still detects a collision if a file exists when an upload commits. */
function statSizeIfFile(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Find an idempotent retry without listing the directory, rejecting an ID
 * already committed under a different accepted content type. */
function committedPathForUpload(uploadId: string, extension: string): string | null {
  ensureAttachmentsDir();
  const exactPath = join(ATTACHMENTS_DIR, `${uploadId}${extension}`);
  if (statSizeIfFile(exactPath) !== null) return exactPath;
  for (const other of KNOWN_ATTACHMENT_EXTENSIONS) {
    if (other === extension) continue;
    if (statSizeIfFile(join(ATTACHMENTS_DIR, `${uploadId}${other}`)) !== null) {
      throw statusError(409, "uploadId was already used for another content type");
    }
  }
  return null;
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

export interface SavedFile extends SavedAttachment {
  /** Safe display name derived from the shared filename. The on-disk name is
   * always the UUID at the end of `path`. */
  name: string;
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function normalizedMime(mime: string | undefined): string | null {
  const value = mime?.split(";")[0]?.trim().toLowerCase();
  return value || null;
}

export function extensionForFileMime(mime: string | undefined): string | null {
  const value = normalizedMime(mime);
  return value ? FILE_MIMES[value] ?? null : null;
}

/** Strip platform-reserved characters and replace any sender-provided
 * extension with the canonical one for the accepted mime. Separators and
 * encoded separators are rejected rather than massaged so traversal attempts
 * remain visible as bad requests. */
export function sanitizeSharedFileName(name: string, mime: string): string {
  const extension = extensionForFileMime(mime);
  if (!extension) throw statusError(400, "content-type must be a supported document, audio or video type");

  const normalized = name.normalize("NFKC").trim();
  if (!normalized) throw statusError(400, "name is required");
  if (normalized.length > 512) throw statusError(400, "name is too long");
  if (/[\\/]/.test(normalized) || /%(?:00|2f|5c)/i.test(normalized)) {
    throw statusError(400, "name must be a filename, not a path");
  }

  const dot = normalized.lastIndexOf(".");
  const withoutExtension = dot > 0 ? normalized.slice(0, dot) : normalized;
  const safeCharacters = Array.from(withoutExtension, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || "<>:\"|?*".includes(character) ? "_" : character;
  }).join("");
  const stem = safeCharacters
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const boundedStem = Array.from(stem).slice(0, 180).join("");
  if (!boundedStem) throw statusError(400, "name must contain visible characters");
  return `${boundedStem}${extension}`;
}

/** Stream one shared document to a generated file without ever collecting
 * the request in memory. A failed, empty, or oversized upload leaves no
 * partial file behind. */
export async function saveFile(
  chunks: AsyncIterable<Uint8Array>,
  originalName: string,
  mime: string,
  options: { uploadId?: string; expectedBytes?: number } = {},
): Promise<SavedFile> {
  const normalized = normalizedMime(mime);
  if (!normalized || !extensionForFileMime(normalized)) {
    throw statusError(400, "content-type must be a supported document, audio or video type");
  }
  const name = sanitizeSharedFileName(originalName, normalized);
  const extension = extensionForFileMime(normalized)!;
  const uploadId = validateAttachmentUploadId(options.uploadId);
  const expectedBytes = options.expectedBytes;
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw statusError(400, "content-length must be a non-negative integer");
  }
  if (expectedBytes !== undefined && expectedBytes > FILE_MAX_BYTES) {
    throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
  }

  return withUploadLock(uploadId, async () => {
    ensureAttachmentsDir();
    if (uploadId) cleanupAttachmentPartialsForUpload(uploadId);
    const existing = uploadId ? committedPathForUpload(uploadId, extension) : null;
    if (existing) {
      const incomingHash = createHash("sha256");
      let bytes = 0;
      for await (const value of chunks) {
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (chunk.byteLength === 0) continue;
        if (bytes + chunk.byteLength > FILE_MAX_BYTES) {
          throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
        }
        incomingHash.update(chunk);
        bytes += chunk.byteLength;
      }
      if (bytes === 0) throw statusError(400, "empty file");
      if (statSync(existing).size !== bytes || await digestFile(existing) !== incomingHash.digest("hex")) {
        throw statusError(409, "uploadId was already used for different file bytes");
      }
      return { path: existing, name, mime: normalized, bytes };
    }

    const id = uploadId ?? randomUUID();
    const path = join(ATTACHMENTS_DIR, `${id}${extension}`);
    const partialPath = join(ATTACHMENTS_DIR, `.bos-upload-${id}-${randomUUID()}.partial`);
    const reservation = new AttachmentReservation();
    if (expectedBytes) reservation.reserve(expectedBytes);
    activePartials.add(partialPath);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let bytes = 0;
    let closed = false;
    let partialCleanupFailed = false;

    try {
      file = await open(partialPath, "wx", 0o600);
      for await (const value of chunks) {
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (chunk.byteLength === 0) continue;
        if (bytes + chunk.byteLength > FILE_MAX_BYTES) {
          throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
        }
        reservation.ensure(bytes + chunk.byteLength);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (result.bytesWritten === 0) throw new Error("file write made no progress");
          offset += result.bytesWritten;
        }
        bytes += chunk.byteLength;
      }
      if (bytes === 0) throw statusError(400, "empty file");
      await file.close();
      closed = true;
      try {
        const accountingVersion = attachmentAccountingVersion;
        await link(partialPath, path);
        addCommittedBytes(bytes, accountingVersion);
        await unlink(partialPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (statSync(path).size !== bytes || await digestFile(path) !== await digestFile(partialPath)) {
          throw statusError(409, "uploadId was already used for different file bytes");
        }
        await unlink(partialPath);
      }
      return { path, name, mime: normalized, bytes };
    } catch (error) {
      if (file && !closed) await file.close().catch(() => undefined);
      await unlink(partialPath).catch(() => { partialCleanupFailed = true; });
      throw error;
    } finally {
      activePartials.delete(partialPath);
      // A leftover partial was excluded from the cache while active. Rescan
      // after releasing it so a retry cannot subtract bytes never counted.
      if (partialCleanupFailed) invalidateAttachmentAccounting();
      reservation.release();
    }
  });
}

/** Persist one image and return its path. The UUID filename means the name
 * is never attacker-controlled and never collides; the extension preserves
 * the format the sender claimed. */
export function saveImage(bytes: Buffer, mime: string, requestedUploadId?: string): SavedAttachment {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported image type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty image"), { status: 400 });
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`), { status: 413 });
  }
  const uploadId = validateAttachmentUploadId(requestedUploadId);
  ensureAttachmentsDir();
  const existing = uploadId ? committedPathForUpload(uploadId, ext) : null;
  if (existing) {
    const saved = readFileSync(existing);
    if (!saved.equals(bytes)) {
      throw statusError(409, "uploadId was already used for different image bytes");
    }
    return { path: existing, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
  }

  const reservation = new AttachmentReservation();
  reservation.reserve(bytes.byteLength);
  const id = uploadId ?? randomUUID();
  const name = `${id}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  const partialPath = join(ATTACHMENTS_DIR, `.bos-upload-${id}-${randomUUID()}.partial`);
  activePartials.add(partialPath);
  let partialCleanupFailed = false;
  try {
    writeFileSync(partialPath, bytes, { mode: 0o600, flag: "wx" });
    try {
      linkSync(partialPath, path);
      addCommittedBytes(bytes.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const saved = readFileSync(path);
      if (!saved.equals(bytes)) {
        throw statusError(409, "uploadId was already used for different image bytes");
      }
    }
    unlinkSync(partialPath);
    return { path, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
  } catch (error) {
    try {
      unlinkSync(partialPath);
    } catch {
      partialCleanupFailed = true;
    }
    throw error;
  } finally {
    activePartials.delete(partialPath);
    if (partialCleanupFailed) invalidateAttachmentAccounting();
    reservation.release();
  }
}

/** HTTP uploads take the same per-ID lock as streamed files. saveImage stays
 * synchronous for generated avatars, while this wrapper prevents an image
 * and a document using the same caller-supplied UUID from committing with
 * different extensions at the same time. */
export async function saveImageUpload(
  bytes: Buffer,
  mime: string,
  requestedUploadId?: string,
): Promise<SavedAttachment> {
  const uploadId = validateAttachmentUploadId(requestedUploadId);
  return withUploadLock(uploadId, async () => {
    if (uploadId) cleanupAttachmentPartialsForUpload(uploadId);
    return saveImage(bytes, mime, uploadId);
  });
}

/** Existence check with the same name discipline as readAttachment, without
 * reading up to 10MB of pixels just to learn the file is there. */
export function attachmentExists(name: string): boolean {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return false;
  try {
    return statSync(join(ATTACHMENTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir. */
export function readAttachment(name: string): { bytes: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) return null;
  const path = join(ATTACHMENTS_DIR, name);
  if (extname(path) === ".jpeg") return null; // saved as .jpg; .jpeg is not a name we write
  try {
    return { bytes: readFileSync(path), mime: mimeForExt(extname(path)) };
  } catch {
    return null;
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data
