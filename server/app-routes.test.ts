import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleInternalAppRoute, handleOwnerAppRoute, matchRecords, parseOps } from "./app-routes.ts";
import { AppStore } from "./apps.ts";
import { peerEvent } from "./peer-events.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PAGE = `<!doctype html><html><head><meta name="bos-app" content="CRM"><meta name="bos-app-icon" content="users"><title>CRM</title></head><body></body></html>`;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "bos-app-routes-"));
  dirs.push(dir);
  const apps = new AppStore({ root: botId => join(dir, botId, "apps"), botIds: () => ["bot-1", "bot-2"] });
  let body: unknown = {};
  const out: { status?: number; body?: any; headers?: Record<string, string> } = {};
  const http = {
    readBody: async () => body,
    json: (status: number, value: unknown) => { out.status = status; out.body = value; out.headers = undefined; },
    send: (status: number, headers: Record<string, string>, value: Buffer | string) => { out.status = status; out.body = value; out.headers = headers; },
  };
  const ownerAccess = { level: "owner" as const, name: "Firaz", roomIds: () => ["room-1", "room-2"] };
  const personAccess = { level: "person" as const, name: "Putri", roomIds: () => ["room-1"] };
  let who: typeof ownerAccess | typeof personAccess | null = ownerAccess;
  const owner = (method: string, path: string, query = "") => handleOwnerAppRoute(method, path, new URLSearchParams(query), {
    ...http, apps, access: () => who, botExists: id => id.startsWith("bot-"), roomExists: id => id.startsWith("room-"),
    readPage: async (_b, _t, path) => path.endsWith(".html") ? { html: PAGE, mtime: 1 } : null,
    copyPage: async (_b, _t, path) => path.replace(".html", "-copy.html"),
  });
  const internal = (method: string, path: string, roomId: string | null, query = "") => handleInternalAppRoute(method, path, new URLSearchParams(query), {
    ...http, apps, botId: "bot-1", botName: "bos", threadId: "t1", roomId, botRoomIds: () => ["room-1"], requireActive: () => {},
    createFromTemplate: async () => null,
  });
  return { apps, out, owner, internal, setBody: (b: unknown) => { body = b; }, as: (w: "owner" | "person" | null) => { who = w === "owner" ? ownerAccess : w === "person" ? personAccess : null; } };
}

describe("app routes", () => {
  it("registers a page from its own meta, never from the request", async () => {
    const h = harness();
    h.setBody({ botId: "bot-1", threadId: "t1", path: "bos-pages/crm.html", name: "Evil" });
    await h.owner("POST", "/api/apps/ensure");
    expect(h.out.body.app).toMatchObject({ name: "CRM", icon: "users", botId: "bot-1" });
    h.setBody({ botId: "bot-1", threadId: "t1", path: "notes.txt" });
    await h.owner("POST", "/api/apps/ensure");
    expect(h.out.body).toEqual({ app: null });
  });

  it("gives room people only shared apps, and only data and page", async () => {
    const h = harness();
    const app = h.apps.ensure("bot-1", { threadId: "t1", path: "crm.html", name: "CRM" }, "Firaz");
    h.as("person");
    await h.owner("GET", `/api/apps/${app.id}`);
    expect(h.out.status).toBe(404);
    await h.owner("GET", "/api/apps");
    expect(h.out.body.apps).toEqual([]);
    h.as("owner");
    h.setBody({ sharedRoomIds: ["nope"] });
    await h.owner("PATCH", `/api/apps/${app.id}`);
    expect(h.out.status).toBe(400);
    h.setBody({ sharedRoomIds: ["room-1"] });
    await h.owner("PATCH", `/api/apps/${app.id}`);
    expect(h.out.body.app.sharedRoomIds).toEqual(["room-1"]);
    h.as("person");
    h.setBody({ ops: [{ op: "put", collection: "contacts", id: "c1", record: { name: "Ali" } }] });
    await h.owner("POST", `/api/apps/${app.id}/data`);
    expect(h.out.status).toBe(200);
    expect(h.apps.record(app.id, "contacts", "c1")).toMatchObject({ name: "Ali", _by: "Putri" });
    await h.owner("GET", `/api/apps/${app.id}/page`);
    expect(h.out.headers!["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(h.out.body as string).html).toBe(PAGE);
    for (const [method, path] of [["DELETE", `/api/apps/${app.id}`], ["PATCH", `/api/apps/${app.id}`], ["POST", `/api/apps/${app.id}/duplicate`]] as const) {
      await h.owner(method, path);
      expect(h.out.status).toBe(403);
    }
    await h.owner("GET", "/api/apps", "roomId=room-2");
    expect(h.out.status).toBe(404);
    h.as(null);
    await h.owner("GET", `/api/apps/${app.id}/data/contacts`);
    expect(h.out.status).toBe(401);
  });

  it("exports csv and json and duplicates with data", async () => {
    const h = harness();
    const app = h.apps.ensure("bot-1", { threadId: "t1", path: "crm.html", name: "My CRM" }, "Firaz");
    h.apps.write(app.id, [{ op: "put", collection: "contacts", id: "c1", record: { name: "Ali" } }], "Firaz");
    await h.owner("GET", `/api/apps/${app.id}/export`, "format=csv&collection=contacts");
    expect(h.out.headers!["content-disposition"]).toContain("my-crm-contacts.csv");
    expect(String(h.out.body)).toContain("c1,Ali");
    await h.owner("GET", `/api/apps/${app.id}/export`, "format=json");
    expect(JSON.parse(String(h.out.body)).data.contacts[0].name).toBe("Ali");
    h.setBody({});
    await h.owner("POST", `/api/apps/${app.id}/duplicate`);
    expect(h.out.body.app).toMatchObject({ name: "My CRM copy", path: "crm-copy.html", collections: { contacts: 1 } });
  });

  it("keeps a room turn to apps shared into that room", async () => {
    const h = harness();
    const mine = h.apps.ensure("bot-1", { threadId: "t1", path: "crm.html", name: "CRM" }, "bos");
    const theirs = h.apps.ensure("bot-2", { threadId: "t9", path: "hr.html", name: "HR" }, "x");
    h.apps.update(theirs.id, { sharedRoomIds: ["room-1"] }, "Firaz");
    await h.internal("GET", "/api/internal/apps", null);
    expect(h.out.body.apps.map((a: { app_id: string }) => a.app_id).sort()).toEqual([mine.id, theirs.id].sort());
    await h.internal("GET", "/api/internal/apps", "room-1");
    expect(h.out.body.apps.map((a: { app_id: string }) => a.app_id)).toEqual([theirs.id]);
    h.setBody({ ops: [{ op: "put", collection: "contacts", record: { name: "x" } }] });
    await h.internal("POST", `/api/internal/apps/${mine.id}/write`, "room-1");
    expect(h.out.status).toBe(404);
    await h.internal("POST", "/api/internal/apps", "room-1");
    expect(h.out.status).toBe(403);
    h.setBody({ ops: [{ op: "put", collection: "contacts", id: "ali", record: { name: "Ali", stage: "hot" } }] });
    await h.internal("POST", `/api/internal/apps/${mine.id}/write`, null);
    expect(h.out.body).toMatchObject({ ok: true, rev: 1 });
    await h.internal("GET", `/api/internal/apps/${mine.id}/read`, null, "collection=contacts&query=hot");
    expect(h.out.body).toMatchObject({ total: 1, records: [{ id: "ali", _by: "bos" }] });
  });

  it("lets a bot rename and delete only its own apps, outside rooms, with the exact name", async () => {
    const h = harness();
    const mine = h.apps.ensure("bot-1", { threadId: "t1", path: "crm.html", name: "CRM" }, "bos");
    const theirs = h.apps.ensure("bot-2", { threadId: "t9", path: "hr.html", name: "HR" }, "x");
    h.apps.update(theirs.id, { sharedRoomIds: ["room-1"] }, "Firaz");
    h.setBody({ name: "Leads" });
    await h.internal("PATCH", `/api/internal/apps/${mine.id}`, "room-1");
    expect(h.out.status).toBe(403);
    await h.internal("PATCH", `/api/internal/apps/${theirs.id}`, null);
    expect(h.out.status).toBe(403);
    await h.internal("PATCH", `/api/internal/apps/${mine.id}`, null);
    expect(h.out.body).toMatchObject({ app_id: mine.id, name: "Leads" });
    h.setBody({ confirm_name: "CRM" });
    await h.internal("DELETE", `/api/internal/apps/${mine.id}`, null);
    expect(h.out.status).toBe(400);
    expect(h.apps.list("bot-1")).toHaveLength(1);
    h.setBody({ confirm_name: "leads" });
    await h.internal("DELETE", `/api/internal/apps/${mine.id}`, null);
    expect(h.out.body).toMatchObject({ ok: true, deleted: mine.id, name: "Leads" });
    expect(h.apps.list("bot-1")).toHaveLength(0);
    h.setBody({ confirm_name: "HR" });
    await h.internal("DELETE", `/api/internal/apps/${theirs.id}`, null);
    expect(h.out.status).toBe(403);
    expect(h.apps.list("bot-2")).toHaveLength(1);
  });

  it("parses ops and searches records", () => {
    expect(() => parseOps([])).toThrow(/1-100/);
    expect(() => parseOps([{ op: "patch", collection: "c" }])).toThrow(/needs an id/);
    expect(parseOps([{ op: "remove", collection: "c", id: "x" }])).toEqual([{ op: "delete", collection: "c", id: "x" }]);
    const rows = [{ id: "a", _at: 1, _by: "x", name: "Ali Seri Bridal" }, { id: "b", _at: 2, _by: "x", name: "Abu" }];
    expect(matchRecords(rows, "ali seri", 10).map(r => r.id)).toEqual(["a"]);
    expect(matchRecords(rows, "", 10).map(r => r.id)).toEqual(["b", "a"]);
  });

  it("projects app changes to people only when shared with them", () => {
    const access = { owns: () => false, botView: () => null };
    const frame = { kind: "app", appId: "a-123456789012", botId: "bot-1", rev: 3, collections: ["contacts"], by: "bos" };
    expect(peerEvent(frame, access)).toBeNull();
    expect(peerEvent(frame, { ...access, appShared: () => false })).toBeNull();
    expect(peerEvent(frame, { ...access, appShared: () => true })).toEqual({ kind: "app", appId: "a-123456789012", rev: 3, collections: ["contacts"], by: "bos" });
  });
});
