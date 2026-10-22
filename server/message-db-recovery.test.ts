import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, writeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, insertMessage, readThread, recallMessages } from "./message-db.ts";
import { openRecoverableMessageDb } from "./message-db-recovery.ts";
import { recoveryNotices } from "./recovery-notices.ts";

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
const file = () => join(DATA_DIR, "messages.db");
const read = () => readThread("fixture-thread", join(DATA_DIR, "missing-legacy.json")).messages;
function backup() {
  insertMessage("fixture-thread", { id: "message", at: 1, role: "user", kind: "text", text: "Keep my conversation" });
  closeMessageDb();
  copyFileSync(file(), `${file()}.bak`);
}

describe("message database recovery", () => {
  it("restores a zero-byte truncated database instead of accepting SQLite's empty-file quick_check", () => {
    backup();
    writeFileSync(file(), "");
    expect(read().map(message => message.text)).toEqual(["Keep my conversation"]);
    expect(recoveryNotices(DATA_DIR)[0].status).toBe("restored");
  });
  it("holds recovery for a locked good backup and retries it on the next open", () => {
    backup();
    writeFileSync(file(), "corrupted canonical");
    const source = new DatabaseSync(`${file()}.bak`);
    try {
      source.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      expect(read).toThrow(/recovery.*paused/i);
      expect(existsSync(file())).toBe(false);
      expect(existsSync(`${file()}.recovery-pending`)).toBe(true);
    } finally { source.exec("ROLLBACK"); source.close(); }
    expect(read().map(message => message.text)).toEqual(["Keep my conversation"]);
  });
  it("quarantines a corrupt database and restores committed messages from a valid backup", () => {
    backup();
    writeFileSync(file(), "deliberately corrupted database");
    expect(read().map(message => message.text)).toEqual(["Keep my conversation"]);
    const quarantine = readdirSync(DATA_DIR).find(name => name.startsWith("messages.db.corrupt-"));
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(DATA_DIR, quarantine!), "utf8")).toBe("deliberately corrupted database");
    expect(recoveryNotices(DATA_DIR)).toContainEqual(expect.objectContaining({ collection: "messages.db", status: "restored" }));
    closeMessageDb();
    expect(read()).toHaveLength(1);
  });
  it("starts fresh with a visible notice when there is no valid backup", () => {
    writeFileSync(file(), "deliberately corrupted database");
    writeFileSync(`${file()}.bak`, "also corrupt");
    expect(read()).toEqual([]);
    expect(recoveryNotices(DATA_DIR)).toContainEqual(expect.objectContaining({ collection: "messages.db", status: "fresh" }));
    insertMessage("fixture-thread", { id: "new", at: 2, role: "user", kind: "text", text: "New conversation" });
    closeMessageDb();
    expect(read()).toHaveLength(1);
  });
  it("recovers WAL commits from workspace-backup safety copies and never pairs old sidecars with the replacement", () => {
    const id = "7b271374-51fb-4fe9-8147-844f83550dd5";
    const safety = join(DATA_DIR, ".backups", `safety-${id}`);
    mkdirSync(join(safety, "data"), { recursive: true });
    writeFileSync(join(safety, "manifest.json"), JSON.stringify({ id, createdAt: new Date().toISOString(), originalEntries: ["messages.db"] }));
    const source = join(safety, "data", "messages.db");
    const db = new DatabaseSync(source);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
      db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run("fixture-thread", "kept", 1, "user", "text", "WAL commit", JSON.stringify({ id: "kept", at: 1, role: "user", kind: "text", text: "WAL commit" }));
      writeFileSync(file(), "corrupt main");
      writeFileSync(`${file()}-wal`, "stale wal");
      writeFileSync(`${file()}-shm`, "stale shm");
      expect(read().map(message => message.text)).toEqual(["WAL commit"]);
      expect(readdirSync(DATA_DIR).some(name => name.startsWith("messages.db.corrupt-") && name.endsWith("-wal"))).toBe(true);
      expect(readFileSync(`${source}-wal`).byteLength).toBeGreaterThan(0);
    } finally { db.close(); }
  });
  it("does not quarantine a database just because another process holds a lock", () => {
    backup();
    const database = new DatabaseSync(file());
    try {
      database.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      expect(read).toThrow(/locked/i);
      expect(readdirSync(DATA_DIR).some(name => name.startsWith("messages.db.corrupt-"))).toBe(false);
      expect(existsSync(file())).toBe(true);
    } finally { database.exec("ROLLBACK"); database.close(); }
  });
  it("finishes an interrupted quarantine before opening a new database", () => {
    const name = "messages.db.corrupt-123-7b271374-51fb-4fe9-8147-844f83550dd5";
    writeFileSync(join(DATA_DIR, name), "preserved broken database");
    writeFileSync(`${file()}-wal`, "old wal");
    writeFileSync(`${file()}.recovery-pending`, name);
    expect(read()).toEqual([]);
    expect(readFileSync(join(DATA_DIR, `${name}-wal`), "utf8")).toBe("old wal");
    expect(existsSync(`${file()}.recovery-pending`)).toBe(false);
    expect(recoveryNotices(DATA_DIR)[0].status).toBe("fresh");
  });
  it("retries a pending recovery interrupted while creating the replacement", () => {
    backup();
    const name = "messages.db.corrupt-123-7b271374-51fb-4fe9-8147-844f83550dd5";
    writeFileSync(join(DATA_DIR, name), "preserved original database");
    writeFileSync(`${file()}.recovery-pending`, name);
    writeFileSync(file(), "");
    expect(read().map(message => message.text)).toEqual(["Keep my conversation"]);
    expect(readFileSync(join(DATA_DIR, name), "utf8")).toBe("preserved original database");
    expect(existsSync(`${file()}.recovery-pending`)).toBe(false);
  });
  for (const [label, spell] of [
    ["a trailing-slash", (dir: string) => `${dir}${sep}`],
    ["a relative", (dir: string) => relative(process.cwd(), dir)],
  ] as const) {
    it(`journals the full quarantine name for ${label} data dir and finishes after a reboot`, () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-recovery-path-"));
      try {
        const bak = join(dir, "messages.db.bak");
        const seed = new DatabaseSync(bak);
        seed.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY); INSERT INTO messages VALUES ('t','kept');");
        seed.close();
        writeFileSync(join(dir, "messages.db"), "corrupted canonical");
        const lock = new DatabaseSync(bak);
        try {
          lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
          expect(() => openRecoverableMessageDb(spell(dir))).toThrow(/recovery.*paused/i);
        } finally { lock.exec("ROLLBACK"); lock.close(); }
        const journal = readFileSync(join(dir, "messages.db.recovery-pending"), "utf8");
        expect(journal).toMatch(/^messages\.db\.corrupt-\d+-[\da-f-]{36}$/);
        expect(readFileSync(join(dir, journal), "utf8")).toBe("corrupted canonical");
        const db = openRecoverableMessageDb(spell(dir));
        try { expect(db.prepare("SELECT id FROM messages").all()).toEqual([{ id: "kept" }]); }
        finally { db.close(); }
        expect(existsSync(join(dir, "messages.db.recovery-pending"))).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  const say = (id: string, text: string, at: number) => insertMessage("fixture-thread", { id, at, role: "user", kind: "text", text });
  /** Folds the WAL into the main file so byte-level damage hits real pages. */
  function settle(sql = "") {
    closeMessageDb();
    const db = new DatabaseSync(file());
    db.exec(`PRAGMA journal_mode=DELETE; ${sql}`);
    const info = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='messages_thread'").get() as { rootpage: number };
    const size = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    db.close();
    return { offset: (info.rootpage - 1) * size };
  }
  it("rebuilds a mismatched index instead of falling back to an older backup", () => {
    backup();
    say("newer", "Newer than the backup", 2);
    // A partial index whose WHERE clause is blanked out on disk: the pages
    // are sound but the index is missing a row, so quick_check fails.
    settle("CREATE INDEX salvage_probe ON messages(thread_id) WHERE id != 'message';");
    const bytes = readFileSync(file());
    const clause = Buffer.from(" WHERE id != 'message'");
    bytes.fill(0x20, bytes.indexOf(clause), bytes.indexOf(clause) + clause.length);
    writeFileSync(file(), bytes);
    expect(read().map(message => message.text)).toEqual(["Keep my conversation", "Newer than the backup"]);
    expect(recoveryNotices(DATA_DIR)[0]).toMatchObject({ status: "restored", detail: expect.stringMatching(/index was rebuilt/) });
    expect(readdirSync(DATA_DIR).some(name => name.startsWith("messages.db.corrupt-"))).toBe(true);
  });
  it("copies every row out of a database whose index pages are destroyed", () => {
    say("first", "First message", 1);
    say("second", "Second message", 2);
    const { offset } = settle();
    const fd = openSync(file(), "r+");
    try { writeSync(fd, Buffer.from([0x00, 0xff, 0xff, 0xff]), 0, 4, offset); } finally { closeSync(fd); }
    expect(read().map(message => message.text)).toEqual(["First message", "Second message"]);
    expect(recoveryNotices(DATA_DIR)[0]).toMatchObject({ status: "restored", detail: expect.stringMatching(/rebuilt from the damaged/) });
    // The external-content recall index is rebuilt against the same rowids.
    expect(recallMessages("Second", ["fixture-thread"]).length).toBe(1);
    expect(readdirSync(DATA_DIR).filter(name => /\.(salvage|restore)(-wal|-shm|-journal)?$/.test(name))).toEqual([]);
    say("third", "Third message", 3);
    closeMessageDb();
    expect(read()).toHaveLength(3);
  });
  it("opens a zero-byte database with no sidecars fresh, without a notice or an empty quarantine", () => {
    writeFileSync(file(), "");
    expect(read()).toEqual([]);
    expect(recoveryNotices(DATA_DIR)).toEqual([]);
    expect(readdirSync(DATA_DIR).filter(name => name.startsWith("messages.db.corrupt-") || name.endsWith(".recovery-pending"))).toEqual([]);
  });
  it("keeps a zero-byte database with a WAL as a visible recovery case", () => {
    writeFileSync(file(), "");
    writeFileSync(`${file()}-wal`, "committed frames");
    expect(read()).toEqual([]);
    expect(recoveryNotices(DATA_DIR)[0].status).toBe("fresh");
    expect(readdirSync(DATA_DIR).some(name => name.startsWith("messages.db.corrupt-") && name.endsWith("-wal"))).toBe(true);
  });
  it("moves a stale WAL aside when the main database file is gone", () => {
    say("old", "Old message", 1);
    closeMessageDb();
    const db = new DatabaseSync(file());
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('fixture-thread','wal',2,'user','text','In WAL','{\"id\":\"wal\",\"at\":2,\"role\":\"user\",\"kind\":\"text\",\"text\":\"In WAL\"}')");
    const wal = readFileSync(`${file()}-wal`);
    db.close();
    rmSync(file());
    writeFileSync(`${file()}-wal`, wal);
    expect(read()).toEqual([]);
    expect(readdirSync(DATA_DIR).some(name => /^messages\.db-wal\.corrupt-/.test(name))).toBe(true);
    say("new", "New message", 3);
    closeMessageDb();
    expect(read().map(message => message.text)).toEqual(["New message"]);
  });
});
