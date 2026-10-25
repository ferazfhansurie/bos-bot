import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppStore } from "./apps.ts";
import { APP_LIMITS, recordsToCsv, type AppChange } from "../shared/apps.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bos-apps-"));
  dirs.push(dir);
  let clock = 1_000_000;
  const changes: AppChange[] = [];
  const root = (botId: string) => join(dir, botId, "apps");
  const store = new AppStore({ root, now: () => clock, onChange: c => changes.push(c), botIds: () => ["bot-1", "bot-2"] });
  return { dir, root, store, changes, tick: (ms: number) => { clock += ms; } };
}

describe("app store", () => {
  it("registers a page once and keeps its data across restarts", () => {
    const { store, dir, root } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "bos-pages/crm.html", name: "CRM", icon: "users", template: "crm" }, "bot:bos");
    expect(app.id).toMatch(/^a-[a-z0-9]{12}$/);
    expect(store.ensure("bot-1", { threadId: "t1", path: "bos-pages/crm.html", name: "CRM", icon: "users" }, "owner").id).toBe(app.id);
    const put = store.write(app.id, [{ op: "put", collection: "contacts", record: { name: "Ali", company: "Seri Bridal", stage: "warm" } }], "owner");
    const id = put.records[0]!.id;
    store.write(app.id, [{ op: "patch", collection: "contacts", id, fields: { stage: "hot" } }], "bot:bos");
    expect(statSync(join(dir, "bot-1", "apps", `${app.id}.json`)).mode & 0o777).toBe(0o600);
    const reloaded = new AppStore({ root, botIds: () => ["bot-1"] });
    expect(reloaded.record(app.id, "contacts", id)).toMatchObject({ name: "Ali", stage: "hot", _by: "bot:bos" });
    expect(reloaded.get(app.id)).toMatchObject({ rev: 2, collections: { contacts: 1 } });
  });

  it("applies a batch all or nothing and reports one change", () => {
    const { store, changes } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "a.html", name: "Tasks" }, "owner");
    changes.length = 0;
    expect(() => store.write(app.id, [
      { op: "put", collection: "tasks", id: "t1", record: { title: "ok" } },
      { op: "patch", collection: "tasks", id: "nope", fields: { title: "x" } },
    ], "owner")).toThrow(/no tasks record nope/);
    expect(store.records(app.id, "tasks")).toEqual([]);
    expect(changes).toEqual([]);
    store.write(app.id, [{ op: "put", collection: "tasks", id: "t1", record: { title: "a" } }, { op: "put", collection: "notes", record: { body: "b" } }], "owner");
    expect(changes).toEqual([expect.objectContaining({ appId: app.id, collections: ["tasks", "notes"], rev: 1, by: "owner" })]);
    store.write(app.id, [{ op: "delete", collection: "notes", id: store.records(app.id, "notes")[0]!.id }], "owner");
    expect(store.get(app.id).collections).toEqual({ tasks: 1 });
  });

  it("refuses bad names, reserved and oversized input", () => {
    const { store } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "a.html", name: "x" }, "owner");
    expect(() => store.write(app.id, [{ op: "put", collection: "Bad Name", record: {} }], "owner")).toThrow(/collection/);
    expect(() => store.write(app.id, [{ op: "put", collection: "c", id: "../x", record: {} }], "owner")).toThrow(/id must/);
    expect(() => store.write(app.id, [{ op: "put", collection: "c", record: { "bad key": 1 } }], "owner")).toThrow(/field/);
    expect(() => store.write(app.id, [{ op: "put", collection: "c", record: { big: "x".repeat(APP_LIMITS.recordBytes + 1) } }], "owner")).toThrow(/larger than/);
    expect(() => store.write(app.id, [{ op: "put", collection: "c", record: { n: Infinity } }], "owner")).toThrow(/finite/);
    const r = store.write(app.id, [{ op: "put", collection: "c", record: { id: "forged", _by: "someone", name: "n" } }], "owner").records[0]!;
    expect(r.id).not.toBe("forged");
    expect(r._by).toBe("owner");
    expect(() => store.get("a-doesnotexist")).toThrow(/no such app/);
    expect(() => store.get("../../etc")).toThrow(/app id/);
    // keys that would reach Object.prototype
    expect(() => store.write(app.id, [{ op: "put", collection: "constructor", id: "x", record: { a: 1 } }], "owner")).toThrow(/collection/);
    expect(() => store.write(app.id, [{ op: "put", collection: "c", id: "__proto__", record: { a: 1 } }], "owner")).toThrow(/id must/);
    expect(() => store.write(app.id, [{ op: "patch", collection: "c", id: "toString", fields: { a: 1 } }], "owner")).toThrow(/id must/);
    expect(store.record(app.id, "c", "hasOwnProperty")).toBeNull();
    expect((Object as unknown as Record<string, unknown>).x).toBeUndefined();
  });

  it("shares into rooms, duplicates with data and deletes", () => {
    const { store, changes } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "a.html", name: "CRM" }, "owner");
    store.write(app.id, [{ op: "put", collection: "contacts", id: "c1", record: { name: "Ali" } }], "owner");
    store.update(app.id, { sharedRoomIds: ["room-1", "room-1"] }, "owner");
    expect(store.sharedInto(["room-1"]).map(a => a.id)).toEqual([app.id]);
    expect(store.sharedInto(["room-2"])).toEqual([]);
    const copy = store.duplicate(app.id, { path: "b.html", name: "CRM copy" }, "owner");
    expect(copy).toMatchObject({ name: "CRM copy", sharedRoomIds: [], collections: { contacts: 1 } });
    store.write(copy.id, [{ op: "patch", collection: "contacts", id: "c1", fields: { name: "Abu" } }], "owner");
    expect(store.record(app.id, "contacts", "c1")!.name).toBe("Ali");
    store.destroy(app.id, "owner");
    expect(() => store.get(app.id)).toThrow(/no such app/);
    expect(changes.at(-1)).toMatchObject({ appId: app.id, deleted: true });
    expect(store.list("bot-1").map(a => a.id)).toEqual([copy.id]);
  });

  it("exports csv that a spreadsheet will not execute", () => {
    const { store } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "a.html", name: "x" }, "owner");
    store.write(app.id, [{ op: "put", collection: "c", id: "r1", record: { name: "=HYPERLINK(\"x\")", note: "a,b\nc", balance: -50 } }], "owner");
    const csv = recordsToCsv(store.records(app.id, "c"));
    expect(csv.split("\r\n")[0]).toBe("id,name,note,balance,_at,_by");
    expect(csv).toContain(",-50,");
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"a,b\nc"`);
    expect(JSON.parse(JSON.stringify(store.exportData(app.id))).data.c).toHaveLength(1);
  });

  it("caps the number of records in a collection", () => {
    const { store, root } = fixture();
    const app = store.ensure("bot-1", { threadId: "t1", path: "a.html", name: "x" }, "owner");
    for (let i = 0; i < APP_LIMITS.recordsPerCollection; i += APP_LIMITS.opsPerWrite) {
      store.write(app.id, Array.from({ length: APP_LIMITS.opsPerWrite }, (_, j) => ({ op: "put" as const, collection: "c", id: `r${i + j}`, record: { n: i + j } })), "owner");
    }
    expect(() => store.write(app.id, [{ op: "put", collection: "c", record: { n: 1 } }], "owner")).toThrow(/full/);
    store.write(app.id, [{ op: "put", collection: "c", id: "r0", record: { n: -1 } }], "owner");
    expect(JSON.parse(readFileSync(join(root("bot-1"), `${app.id}.json`), "utf8")).data.c.r0.n).toBe(-1);
  });
});
