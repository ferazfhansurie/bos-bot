import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { quarantinePath, recoveryCandidates, regularFile } from "./data-recovery.ts";
import { recordRecoveryNotice } from "./recovery-notices.ts";
import { renameWithRetry, writeFileAtomic } from "./atomic.ts";

class CorruptDatabase extends Error {}

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

function quickCheck(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new CorruptDatabase("Message database integrity check failed.");
}

function corrupt(error: unknown): boolean {
  // SQLITE_CORRUPT / SQLITE_NOTADB. A busy database, permissions failure or
  // I/O error is not evidence of corruption and must never trigger a reset.
  const code = (error as { errcode?: number })?.errcode;
  return error instanceof CorruptDatabase || (typeof code === "number" && [11, 26].includes(code & 0xff));
}

function checkedOpen(path: string, readOnly = false): DatabaseSync {
  if (!readOnly && !existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path, { readOnly });
  try { quickCheck(db); return db; }
  catch (error) { db.close(); throw error; }
}

function removeIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function hasCoreTables(db: DatabaseSync): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'thread_state')").all().length === 2;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Index-only damage is common and REINDEX rebuilds every index from the
 * table rows, losing nothing. Runs on a private copy: the quarantine itself
 * is never written. Leaves a checked database at `staged` on success. */
function reindexCopy(copy: string, staged: string): boolean {
  const db = new DatabaseSync(copy);
  try {
    db.exec("REINDEX");
    quickCheck(db);
    if (!hasCoreTables(db)) return false;
    closeSync(openSync(staged, "wx", 0o600));
    db.prepare("VACUUM INTO ?").run(staged);
  } finally { db.close(); }
  checkedOpen(staged).close();
  return true;
}

/** Last resort before an empty database: copy every readable row of every
 * ordinary table into a new file, keeping rowids so the external-content
 * FTS indexes rebuild against the same rows. A table that fails mid-scan
 * keeps the rows read before the damaged page. */
function copyRows(copy: string, staged: string): { messages: number; complete: boolean } {
  const source = new DatabaseSync(copy, { readOnly: true });
  closeSync(openSync(staged, "wx", 0o600));
  const target = new DatabaseSync(staged);
  try {
    const schema = source.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; tbl_name: string; sql: string }[];
    if (!schema.some(row => row.type === "table" && row.name === "messages") || !schema.some(row => row.type === "table" && row.name === "thread_state")) return { messages: 0, complete: false };
    const virtual = schema.filter(row => row.type === "table" && /^\s*CREATE\s+VIRTUAL\s/i.test(row.sql));
    const shadow = (name: string) => virtual.some(row => name.startsWith(`${row.name}_`));
    let messages = 0;
    let complete = true;
    target.exec("BEGIN");
    for (const table of schema.filter(row => row.type === "table" && !virtual.includes(row) && !shadow(row.name))) {
      target.exec(table.sql);
      const columns = (source.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as { name: string; type: string; pk: number }[]);
      // An INTEGER PRIMARY KEY already is the rowid; naming both is an error.
      const keyed = columns.filter(column => column.pk > 0);
      const alias = keyed.length === 1 && /^integer$/i.test(keyed[0].type);
      const names = alias ? columns.map(column => column.name) : ["rowid", ...columns.map(column => column.name)];
      const insert = target.prepare(`INSERT OR IGNORE INTO ${quote(table.name)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`);
      // NOT INDEXED: a covering index may be the damaged part; read the table.
      const select = source.prepare(`SELECT ${alias ? "" : "rowid AS \"__salvage_rowid\", "}${columns.map(column => quote(column.name)).join(",")} FROM ${quote(table.name)} NOT INDEXED`);
      select.setReturnArrays(true);
      try {
        for (const row of select.iterate() as Iterable<unknown[]>) {
          insert.run(...(row as never[]));
          if (table.name === "messages") messages += 1;
        }
      } catch (error) { if (!corrupt(error)) throw error; complete = false; }
    }
    for (const row of schema.filter(row => row.type === "index")) { try { target.exec(row.sql); } catch {} }
    for (const row of virtual) {
      try { target.exec(row.sql); target.exec(`INSERT INTO ${quote(row.name)}(${quote(row.name)}) VALUES ('rebuild')`); }
      catch { try { target.exec(`DROP TABLE IF EXISTS ${quote(row.name)}`); } catch {} }
    }
    for (const row of schema.filter(row => row.type === "trigger" || row.type === "view")) { try { target.exec(row.sql); } catch {} }
    target.exec("COMMIT");
    return { messages, complete };
  } finally {
    if (target.isTransaction) target.exec("ROLLBACK");
    target.close();
    source.close();
  }
}

/** Works on a copy of the quarantine (and its WAL) so a crash or a failed
 * attempt never touches the preserved original. Any failure means "nothing
 * salvaged"; the caller still has the quarantine on disk. */
function salvage(quarantine: string, staged: string, mode: "reindex" | "complete-rows" | "rows"): string | null {
  const copy = `${quarantine}.salvage`;
  const clean = () => { for (const file of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) removeIfPresent(file); };
  try {
    clean();
    if (!regularFile(quarantine) || lstatSync(quarantine).size === 0) return null;
    copyFileSync(quarantine, copy, constants.COPYFILE_EXCL);
    chmodSync(copy, 0o600);
    if (regularFile(`${quarantine}-wal`)) copyFileSync(`${quarantine}-wal`, `${copy}-wal`, constants.COPYFILE_EXCL);
    if (mode === "reindex") {
      if (reindexCopy(copy, staged)) return "Conversation history was repaired after a damaged index was rebuilt.";
    } else {
      const rows = copyRows(copy, staged);
      if (rows.messages > 0 && (rows.complete || mode === "rows")) {
        checkedOpen(staged).close();
        return rows.complete
          ? "Conversation history was rebuilt from the damaged database. The damaged files were kept for recovery."
          : "Conversation history was partly recovered from the damaged database. Some messages may be missing; the damaged files were kept for recovery.";
      }
    }
    removeIfPresent(staged);
    return null;
  } catch {
    try { removeIfPresent(staged); } catch {}
    return null;
  } finally { try { clean(); } catch {} }
}

/** Checked before migrations and before any WAL mode change. No handle to a
 * quarantined database or its old sidecars is reused by the replacement. */
export function openRecoverableMessageDb(directory: string): DatabaseSync {
  // The journal stores a bare file name; a trailing slash or relative data
  // dir must not change how that name is derived or read back.
  const dataDir = resolve(directory);
  const path = join(dataDir, "messages.db");
  const pending = `${path}.recovery-pending`;
  let quarantine = quarantinePath(path);
  if (existsSync(pending)) {
    if (!regularFile(pending)) throw new Error("The message recovery journal could not be read safely.");
    const name = readFileSync(pending, "utf8");
    if (!/^messages\.db\.corrupt-[\d]+-[\da-f-]{36}$/.test(name)) throw new Error("The message recovery journal could not be read safely.");
    quarantine = join(dataDir, name);
  }
  if (existsSync(path) && !regularFile(path)) throw new Error("The message database must be a private regular file.");
  // If the journal already owns the quarantined original, a zero-byte
  // canonical can only be an unfinished replacement. Keep the original and
  // retry recovery instead of getting stuck behind our own safety check.
  if (existsSync(pending) && regularFile(quarantine) && existsSync(path) && lstatSync(path).size === 0) unlinkSync(path);
  try {
    if (existsSync(path)) {
      if (lstatSync(path).size === 0) throw new CorruptDatabase("The message database was truncated.");
      const probe = checkedOpen(path, true);
      probe.close();
    }
    if (!existsSync(path) && !existsSync(pending)) {
      // A -wal/-shm left behind by a main file that is gone would be paired
      // with the new empty database and replayed into it. Keep it aside.
      for (const suffix of SIDECARS) {
        if (existsSync(`${path}${suffix}`)) {
          const aside = quarantinePath(`${path}${suffix}`);
          renameWithRetry(`${path}${suffix}`, aside);
          console.warn(`[recovery] messages.db was missing; kept its stale ${suffix} as ${basename(aside)}.`);
        }
      }
    }
    if (existsSync(path) || !existsSync(pending)) {
      const database = checkedOpen(path);
      if (existsSync(pending)) {
        recordRecoveryNotice(dataDir, { collection: "messages.db", status: "restored", detail: "Conversation history recovery finished after an interrupted restart." });
        unlinkSync(pending);
      }
      return database;
    }
  }
  catch (error) { if (!corrupt(error)) throw error; }

  if (!existsSync(pending)) writeFileAtomic(pending, basename(quarantine), { mode: 0o600 });
  if (existsSync(path)) {
    if (existsSync(quarantine)) throw new Error("Message recovery is held to preserve an existing quarantine.");
    renameWithRetry(path, quarantine);
  }
  for (const suffix of SIDECARS) {
    if (existsSync(`${path}${suffix}`)) {
      const destination = existsSync(`${quarantine}${suffix}`) ? quarantinePath(`${path}${suffix}`) : `${quarantine}${suffix}`;
      renameWithRetry(`${path}${suffix}`, destination);
    }
  }
  const staged = `${quarantine}.restore`;
  // A process can die after VACUUM finishes but before the atomic promotion.
  // This is our disposable copy; the selected backup is still untouched.
  try { unlinkSync(staged); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const promote = (detail: string) => {
    renameWithRetry(staged, path);
    const database = checkedOpen(path);
    recordRecoveryNotice(dataDir, { collection: "messages.db", status: "restored", detail });
    unlinkSync(pending);
    return database;
  };
  // Lossless first: damage confined to indexes, or to pages no table needs,
  // keeps every message, including ones newer than any backup.
  for (const mode of ["reindex", "complete-rows"] as const) {
    const repaired = salvage(quarantine, staged, mode);
    if (repaired) return promote(repaired);
    removeIfPresent(staged);
  }
  for (const candidate of recoveryCandidates(dataDir, "messages.db")) {
    let source: DatabaseSync | undefined;
    try {
      source = new DatabaseSync(candidate, { readOnly: true });
      quickCheck(source);
      const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'thread_state')").all();
      if (tables.length !== 2) continue;
      // VACUUM INTO copies committed WAL records as well as the main file.
      // A filesystem copy of messages.db alone can lose the latest messages.
      closeSync(openSync(staged, "wx", 0o600));
      source.prepare("VACUUM INTO ?").run(staged);
      const check = checkedOpen(staged);
      check.close();
      chmodSync(staged, 0o600);
    } catch (error) {
      try { unlinkSync(staged); } catch {}
      if (corrupt(error)) continue;
      throw new Error("Conversation recovery is paused because a backup could not be read. Close other BOS processes and check disk access, then retry.", { cause: error });
    } finally { source?.close(); }
    return promote("Conversation history was recovered from the latest valid local backup.");
  }
  // No usable backup: keep whatever rows the damaged file still yields
  // rather than replacing it with an empty database.
  const rebuilt = salvage(quarantine, staged, "rows");
  if (rebuilt) return promote(rebuilt);
  removeIfPresent(staged);
  // A zero-byte file with no sidecars never held a committed row (a crash
  // between creating the file and writing its schema): nothing was lost, so
  // start clean without a scary notice and without keeping the empty shell.
  if (regularFile(quarantine) && lstatSync(quarantine).size === 0 && !SIDECARS.some(suffix => existsSync(`${quarantine}${suffix}`))) {
    const database = checkedOpen(path);
    unlinkSync(quarantine);
    unlinkSync(pending);
    return database;
  }
  const database = checkedOpen(path);
  recordRecoveryNotice(dataDir, { collection: "messages.db", status: "fresh", detail: "Conversation history could not be recovered. BOS started a new message database; the damaged files were kept for recovery." });
  unlinkSync(pending);
  return database;
}
