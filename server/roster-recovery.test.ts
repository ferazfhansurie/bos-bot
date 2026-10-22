import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { recoveryNotices } from "./recovery-notices.ts";
import { RecoverableRoster } from "./data-recovery.ts";

const selection = () => ({ instanceId: "claude", model: "fixture" });
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

describe.each(["bots.json", "groups.json"] as const)("%s recovery", (name) => {
  const makeGood = () => {
    const store = new Store(selection);
    if (name === "bots.json") store.createBot({ name: "Saved bot" }, { seedMessages: false });
    else store.createGroup("Saved group", []);
    return readFileSync(join(DATA_DIR, name), "utf8");
  };
  const records = (store: Store) => name === "bots.json" ? store.bots : store.groups;
  const create = (store: Store) => name === "bots.json"
    ? store.createBot({ name: "New" }, { seedMessages: false }) : store.createGroup("New", []);
  for (const [kind, text] of [["corrupt", "not json"], ["truncated", '[{"id":"lost"'], ["empty", ""], ["wrong shape", "{}"]]) {
    it(`quarantines ${kind} data and restores the last successful save`, () => {
      const good = makeGood();
      expect(readFileSync(join(DATA_DIR, `${name}.bak`), "utf8")).toBe(good);
      writeFileSync(join(DATA_DIR, name), text);
      const restored = new Store(selection);
      expect(records(restored)).toHaveLength(1);
      const quarantines = readdirSync(DATA_DIR).filter(file => file.startsWith(`${name}.corrupt-`));
      expect(quarantines).toHaveLength(1);
      expect(readFileSync(join(DATA_DIR, quarantines[0]), "utf8")).toBe(text);
      expect(JSON.parse(readFileSync(join(DATA_DIR, name), "utf8"))).toHaveLength(1);
      create(restored);
      expect(records(new Store(selection))).toHaveLength(2);
      expect(recoveryNotices(DATA_DIR).some(notice => notice.collection === name && notice.status === "restored")).toBe(true);
    });
    it(`keeps ${kind} data read-only without a backup, including after restart`, () => {
      writeFileSync(join(DATA_DIR, name), text);
      for (let boot = 0; boot < 2; boot++) {
        const store = new Store(selection);
        store.seedIfEmpty();
        expect(() => create(store)).toThrow(/read.only/i);
        expect(records(store)).toHaveLength(0);
        expect(existsSync(join(DATA_DIR, name))).toBe(false);
        expect(existsSync(join(DATA_DIR, `${name}.bak`))).toBe(false);
        // The independent collection remains usable.
        if (name === "bots.json") store.createGroup("Independent", []);
        else store.createBot({ name: "Independent" }, { seedMessages: false });
      }
      expect(recoveryNotices(DATA_DIR).some(notice => notice.collection === name && notice.status === "read-only")).toBe(true);
    });
  }
  for (const code of ["EBUSY", "EACCES", "EPERM", "EMFILE", "EIO"]) {
    it(`holds a ${code} read error read-only for the session without quarantining or marking it`, () => {
      const good = makeGood();
      const roster = new RecoverableRoster(DATA_DIR, name, () => { throw Object.assign(new Error(code), { code }); });
      expect(roster.load()).toEqual([]);
      expect(roster.readOnly).toBe(true);
      expect(() => roster.save(good)).toThrow(/read.only/i);
      expect(readFileSync(join(DATA_DIR, name), "utf8")).toBe(good);
      expect(readdirSync(DATA_DIR).some(file => file.startsWith(`${name}.corrupt-`))).toBe(false);
      expect(existsSync(join(DATA_DIR, `${name}.read-only`))).toBe(false);
      expect(recoveryNotices(DATA_DIR).some(notice => notice.collection === name && notice.status === "read-only")).toBe(true);
      // The next boot reads the untouched file and drops the transient notice.
      expect(records(new Store(selection))).toHaveLength(1);
      expect(recoveryNotices(DATA_DIR).some(notice => notice.collection === name)).toBe(false);
    });
  }
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves an unreadable roster in place and loads it once permissions return", () => {
    makeGood();
    chmodSync(join(DATA_DIR, name), 0o000);
    try {
      const store = new Store(selection);
      expect(records(store)).toHaveLength(0);
      expect(() => create(store)).toThrow(/read.only/i);
      expect(existsSync(join(DATA_DIR, name))).toBe(true);
      expect(readdirSync(DATA_DIR).some(file => file.startsWith(`${name}.corrupt-`) || file === `${name}.read-only`)).toBe(false);
    } finally { chmodSync(join(DATA_DIR, name), 0o600); }
    expect(records(new Store(selection))).toHaveLength(1);
  });
  it("allows a genuinely missing collection on a new install", () => {
    const store = new Store(selection);
    create(store);
    expect(records(new Store(selection))).toHaveLength(1);
    expect(readdirSync(DATA_DIR).some(file => file.startsWith(`${name}.corrupt-`))).toBe(false);
  });
  it("loads a roster any older build could read, without quarantining it", () => {
    const legacy = JSON.stringify([{ id: "legacy.bot:1", threadId: "legacy.thread:1", name: "Old", memberIds: [] }, { id: "legacy.bot:2", threadId: "legacy.thread:2", name: "Second", memberIds: [] }]);
    writeFileSync(join(DATA_DIR, name), legacy);
    linkSync(join(DATA_DIR, name), join(DATA_DIR, `${name}.hardlink`));
    expect(records(new Store(selection))).toHaveLength(2);
    expect(readdirSync(DATA_DIR).some(file => file.startsWith(`${name}.corrupt-`))).toBe(false);
    expect(JSON.parse(readFileSync(join(DATA_DIR, name), "utf8")).map((row: { id: string }) => row.id)).toEqual(["legacy.bot:1", "legacy.bot:2"]);
  });
  it("seeds a rolling backup from a good pre-2.1.3 roster before any save", () => {
    const good = makeGood();
    rmSync(join(DATA_DIR, `${name}.bak`));
    new Store(selection);
    expect(readFileSync(join(DATA_DIR, `${name}.bak`), "utf8")).toBe(good);
    writeFileSync(join(DATA_DIR, name), '[{"id":"lost"');
    expect(records(new Store(selection))).toHaveLength(1);
  });
  it("restores a missing collection from its rolling backup", () => {
    makeGood();
    rmSync(join(DATA_DIR, name));
    expect(records(new Store(selection))).toHaveLength(1);
  });
  it("skips a corrupt rolling backup and uses a workspace restore safety copy", () => {
    const good = makeGood();
    const id = "7b271374-51fb-4fe9-8147-844f83550dd5";
    const safety = join(DATA_DIR, ".backups", `safety-${id}`);
    mkdirSync(join(safety, "data"), { recursive: true });
    writeFileSync(join(safety, "manifest.json"), JSON.stringify({ id, createdAt: new Date().toISOString(), originalEntries: [name] }));
    writeFileSync(join(safety, "data", name), good);
    writeFileSync(join(DATA_DIR, name), "broken");
    writeFileSync(join(DATA_DIR, `${name}.bak`), "broken backup");
    expect(records(new Store(selection))).toHaveLength(1);
  });
});
