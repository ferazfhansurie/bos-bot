import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetry, writeFileAtomic } from "./atomic.ts";
import { clearRecoveryNotice, recordRecoveryNotice } from "./recovery-notices.ts";

export type CollectionFile = "bots.json" | "groups.json" | "messages.db";

export function regularFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
  catch { return false; }
}

function backupFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Encrypted exports cannot be opened without their password. Restore safety
 * copies are already plaintext, owned by workspace-backup, and can be used at
 * boot without widening the encrypted export's privacy boundary. */
export function recoveryCandidates(dataDir: string, name: CollectionFile): string[] {
  const candidates: { path: string; at: number }[] = [];
  const rolling = join(dataDir, `${name}.bak`);
  if (backupFile(rolling)) candidates.push({ path: rolling, at: lstatSync(rolling).mtimeMs });
  const root = join(dataDir, ".backups");
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return candidates.map(row => row.path);
    for (const entry of readdirSync(root)) {
      if (!/^safety-[0-9a-f-]{36}$/.test(entry)) continue;
      const directory = join(root, entry);
      try {
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() ||
          !lstatSync(join(directory, "data")).isDirectory() || lstatSync(join(directory, "data")).isSymbolicLink()) continue;
        const manifestPath = join(directory, "manifest.json");
        if (!backupFile(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const path = join(directory, "data", name);
        if (manifest.id !== entry.slice(7) || !Array.isArray(manifest.originalEntries) ||
          !manifest.originalEntries.includes(name) || !Number.isFinite(Date.parse(manifest.createdAt)) || !backupFile(path)) continue;
        candidates.push({ path, at: Date.parse(manifest.createdAt) });
      } catch (error) {
        // Invalid/incomplete metadata can be skipped. An inaccessible backup
        // must hold recovery rather than be mistaken for no backup at all.
        if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return candidates.sort((a, b) => b.at - a.at).map(row => row.path);
}

export function quarantinePath(path: string): string { return `${path}.corrupt-${Date.now()}-${randomUUID()}`; }

/** Only damage the old loader could not survive counts as unreadable: it
 * loaded any parseable array, so a stricter record check here would
 * quarantine a roster 2.1.2 read fine and hide every bot on upgrade. */
function roster(text: string, name: "bots.json" | "groups.json"): unknown[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("The saved roster must be an array.");
  for (const row of value) {
    // Only the fields the store cannot boot without: id, threadId, and a
    // room's member list.
    const item = row as { id?: unknown; threadId?: unknown; memberIds?: unknown };
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof item.id !== "string" || !item.id ||
      typeof item.threadId !== "string" || !item.threadId || (name === "groups.json" && !Array.isArray(item.memberIds))) {
      throw new Error("Invalid saved roster record.");
    }
  }
  return value;
}

export class RecoverableRoster<T> {
  private writable = false;
  private readonly file: string;
  private readonly marker: string;
  private readonly dataDir: string;
  private readonly name: "bots.json" | "groups.json";
  private readonly read: (path: string) => string;
  /** `read` is injectable for tests only: a real filesystem cannot produce a
   * transient EBUSY/EIO on demand. */
  constructor(dataDir: string, name: "bots.json" | "groups.json", read: (path: string) => string = path => readFileSync(path, "utf8")) {
    this.read = read;
    this.dataDir = dataDir;
    this.name = name;
    this.file = join(dataDir, name);
    this.marker = `${this.file}.read-only`;
  }

  private get unavailable(): string {
    return `${this.name} could not be opened right now. This collection is read-only until BOS restarts; your saved data was not changed.`;
  }

  load(): T[] {
    let missing = false;
    try {
      // lstat distinguishes a genuinely absent file from an unsafe one; the
      // latter must never become a new empty roster. A hard link is still the
      // person's real data, so only a symlink or non-file is refused here.
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The roster is not a regular file.");
      const text = this.read(this.file);
      const rows = roster(text, this.name) as T[];
      this.writable = true;
      try { unlinkSync(this.marker); } catch {}
      // A roster last saved by an older build has no rolling backup yet; seed
      // one from this good read so the first corruption is still recoverable.
      try { lstatSync(`${this.file}.bak`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try { writeFileAtomic(`${this.file}.bak`, text, { mode: 0o600 }); } catch {}
        }
      }
      clearRecoveryNotice(this.dataDir, this.name, this.unavailable);
      return rows;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EBUSY/EACCES/EPERM/EMFILE/EIO (antivirus, a sync client, a full fd
      // table) say nothing about the bytes on disk. Only a parse or shape
      // failure is damage; anything else holds this session read-only and
      // leaves the file, its name and the marker exactly as they were.
      if (typeof code === "string" && code !== "ENOENT") {
        recordRecoveryNotice(this.dataDir, { collection: this.name, status: "read-only", detail: this.unavailable });
        return [];
      }
      missing = code === "ENOENT";
    }
    let held = false;
    try { lstatSync(this.marker); held = true; } catch {}
    const detail = `${this.name} could not be read. This collection is read-only; restore a workspace backup to recover it.`;
    let candidates: string[];
    try { candidates = recoveryCandidates(this.dataDir, this.name); }
    catch {
      try { writeFileAtomic(this.marker, detail, { mode: 0o600 }); } catch {}
      recordRecoveryNotice(this.dataDir, { collection: this.name, status: "read-only", detail });
      return [];
    }
    if (missing && !held && !candidates.length) { this.writable = true; return []; }

    // Persist the hold BEFORE moving the original. Otherwise a second boot
    // could mistake the quarantined file for a brand-new installation.
    try {
      writeFileAtomic(this.marker, detail, { mode: 0o600 });
      if (!missing) renameWithRetry(this.file, quarantinePath(this.file));
    } catch {
      recordRecoveryNotice(this.dataDir, { collection: this.name, status: "read-only", detail });
      return [];
    }
    for (const candidate of candidates) {
      let text: string;
      let rows: T[];
      try { text = readFileSync(candidate, "utf8"); rows = roster(text, this.name) as T[]; }
      catch { continue; }
      try {
        writeFileAtomic(this.file, text, { mode: 0o600 });
        unlinkSync(this.marker);
        this.writable = true;
        recordRecoveryNotice(this.dataDir, { collection: this.name, status: "restored", detail: `${this.name} was recovered from the latest valid local backup.` });
        return rows;
      } catch { break; }
    }
    recordRecoveryNotice(this.dataDir, { collection: this.name, status: "read-only", detail });
    return [];
  }

  assertWritable(): void {
    if (!this.writable) throw new Error(`${this.name} is read-only because its saved data could not be recovered. Restore a workspace backup first.`);
  }

  get readOnly(): boolean { return !this.writable; }

  save(text: string): void {
    this.assertWritable();
    roster(text, this.name);
    writeFileAtomic(this.file, text, { mode: 0o600 });
    // The canonical save succeeded. A backup failure must not make callers
    // roll back in-memory state after it was already committed to disk.
    try { writeFileAtomic(`${this.file}.bak`, text, { mode: 0o600 }); }
    catch { console.warn(`[recovery] ${this.name} saved, but its rolling backup could not be refreshed.`); }
  }
}
