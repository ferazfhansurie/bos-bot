// HTTP for apps. The owner reaches every app; a person in a room reaches the
// apps shared into rooms they can read (data and page only, never sharing,
// duplicate or delete). Internal routes are the bot's app tools: in its own
// conversations a bot reaches its own apps and the ones shared into its
// rooms; in a room turn only the apps shared into that room, because a room
// can hold clients.
import type { AppOp, AppStore } from "./apps.ts";
import { APP_LIMITS, APP_TEMPLATES, appMeta, recordsToCsv, type AppRecord, type AppSummary } from "../shared/apps.ts";

export interface AppHttp {
  readBody: (limit: number) => Promise<any>;
  json: (status: number, body: unknown) => void;
  send: (status: number, headers: Record<string, string>, body: Buffer | string) => void;
}

export type AppAccess = "owner" | "member" | null;

export interface OwnerAppDeps extends AppHttp {
  apps: AppStore;
  /** Who this request is, checked again after every body read. */
  access: () => { level: "owner" | "person"; name: string; roomIds: () => string[] } | null;
  botExists: (botId: string) => boolean;
  roomExists: (roomId: string) => boolean;
  /** The page html, read from the conversation's folder; null when gone. */
  readPage: (botId: string, threadId: string, path: string) => Promise<{ html: string; mtime: number } | null>;
  /** Copy the page next to itself; returns the copy's folder-relative path. */
  copyPage: (botId: string, threadId: string, path: string) => Promise<string>;
}

const BATCH_BYTES = APP_LIMITS.recordBytes * 4 + 64_000;

async function guarded(http: AppHttp, run: () => Promise<void> | void): Promise<true> {
  try { await run(); }
  catch (error) {
    const e = error as Error & { status?: number };
    http.json(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message });
  }
  return true;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Bridge and tool ops share one shape: {op, collection, id?, record?|fields?}. */
export function parseOps(input: unknown): AppOp[] {
  if (!Array.isArray(input) || !input.length || input.length > APP_LIMITS.opsPerWrite) throw Object.assign(new Error(`ops must list 1-${APP_LIMITS.opsPerWrite} operations`), { status: 400 });
  return input.map((raw, index) => {
    const label = `operation ${index + 1}`;
    if (!plain(raw)) throw Object.assign(new Error(`${label} must be an object`), { status: 400 });
    const collection = String(raw.collection ?? "");
    const id = raw.id === undefined || raw.id === null || raw.id === "" ? undefined : String(raw.id);
    if (raw.op === "put") return { op: "put", collection, id, record: raw.record ?? raw.fields };
    if (raw.op === "patch") { if (!id) throw Object.assign(new Error(`${label}: patch needs an id`), { status: 400 }); return { op: "patch", collection, id, fields: raw.fields ?? raw.record }; }
    if (raw.op === "delete" || raw.op === "remove") { if (!id) throw Object.assign(new Error(`${label}: delete needs an id`), { status: 400 }); return { op: "delete", collection, id }; }
    throw Object.assign(new Error(`${label}: op must be put, patch or delete`), { status: 400 });
  });
}

/** Simple record search for bots: every word must appear in some field. */
export function matchRecords(records: readonly AppRecord[], query: string | undefined, limit: number): AppRecord[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? records.filter(r => { const text = JSON.stringify(r).toLowerCase(); return words.every(w => text.includes(w)); }) : [...records];
  return hits.sort((a, b) => b._at - a._at).slice(0, limit);
}

function fileName(app: AppSummary, suffix: string, ext: string) {
  const base = app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  return `${base}${suffix ? `-${suffix}` : ""}.${ext}`;
}

export async function handleOwnerAppRoute(method: string, path: string, query: URLSearchParams, deps: OwnerAppDeps): Promise<boolean> {
  const m = path.match(/^\/api\/apps(?:\/(ensure|[^/]+)(?:\/(page|data|export|duplicate)(?:\/([^/]+)(?:\/([^/]+))?)?)?)?$/);
  if (!m) return false;
  const [, appId, sub, collection, recordId] = m;
  return guarded(deps, async () => {
    const who = () => {
      const access = deps.access();
      if (!access) throw Object.assign(new Error("sign in to use apps"), { status: 401 });
      return access;
    };
    const first = who();
    const body = async (limit = 16_000) => {
      const value = await deps.readBody(limit);
      who();
      return plain(value) ? value : {};
    };
    // a person only sees apps shared into rooms they can read; anything else is "no such app"
    const reach = (id: string): AppSummary => {
      const app = deps.apps.get(id);
      const access = who();
      if (access.level === "owner") return app;
      const rooms = access.roomIds();
      if (!app.sharedRoomIds.some(r => rooms.includes(r))) throw Object.assign(new Error("no such app"), { status: 404 });
      return app;
    };
    const ownerOnly = () => { if (who().level !== "owner") throw Object.assign(new Error("only the owner can do that"), { status: 403 }); };

    if (!appId) {
      if (method !== "GET") return deps.json(405, { error: "method not allowed" });
      const botId = query.get("botId");
      const room = query.get("roomId");
      if (room) {
        if (first.level !== "owner" && !first.roomIds().includes(room)) return deps.json(404, { error: "no such room" });
        return deps.json(200, { apps: deps.apps.sharedInto([room]) });
      }
      if (first.level !== "owner") return deps.json(200, { apps: deps.apps.sharedInto(first.roomIds()) });
      if (!botId || !deps.botExists(botId)) return deps.json(400, { error: "botId or roomId is required" });
      return deps.json(200, { apps: deps.apps.list(botId) });
    }
    if (appId === "ensure") {
      if (method !== "POST") return deps.json(405, { error: "method not allowed" });
      ownerOnly();
      const input = await body();
      const botId = String(input.botId ?? ""), threadId = String(input.threadId ?? ""), pagePath = String(input.path ?? "");
      if (!deps.botExists(botId) || !threadId || !pagePath) return deps.json(400, { error: "botId, threadId and path are required" });
      const page = await deps.readPage(botId, threadId, pagePath);
      who();
      const meta = page && appMeta(page.html);
      if (!meta) return deps.json(200, { app: null });
      return deps.json(200, { app: deps.apps.ensure(botId, { threadId, path: pagePath, ...meta }, first.name) });
    }

    if (!sub) {
      if (method === "GET") return deps.json(200, { app: reach(appId), owner: who().level === "owner" });
      if (method === "PATCH") {
        ownerOnly();
        const input = await body();
        let sharedRoomIds: string[] | undefined;
        if (input.sharedRoomIds !== undefined) {
          if (!Array.isArray(input.sharedRoomIds) || input.sharedRoomIds.some(id => typeof id !== "string" || !deps.roomExists(id))) return deps.json(400, { error: "sharedRoomIds must list existing rooms" });
          sharedRoomIds = input.sharedRoomIds as string[];
        }
        return deps.json(200, { app: deps.apps.update(appId, { name: input.name, icon: input.icon, sharedRoomIds }, first.name) });
      }
      if (method === "DELETE") {
        ownerOnly();
        deps.apps.destroy(appId, first.name);
        return deps.json(200, { ok: true });
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (sub === "page" && method === "GET") {
      const app = reach(appId);
      const page = await deps.readPage(app.botId, app.threadId, app.path);
      reach(appId);
      if (!page) return deps.json(404, { error: "this app's page file is gone" });
      // json, never text/html: the page must only ever render inside the sandboxed frame
      return deps.send(200, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }, JSON.stringify({ html: page.html, mtime: page.mtime, app, owner: who().level === "owner" }));
    }
    if (sub === "data") {
      const app = reach(appId);
      if (method === "GET") {
        if (!collection) return deps.json(200, { collections: app.collections });
        if (recordId) return deps.json(200, { record: deps.apps.record(appId, collection, decodeURIComponent(recordId)) });
        return deps.json(200, { records: deps.apps.records(appId, collection) });
      }
      if (method === "POST" && !collection) {
        const input = await body(BATCH_BYTES);
        reach(appId);
        return deps.json(200, deps.apps.write(appId, parseOps(input.ops), who().name));
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (sub === "export" && method === "GET") {
      const app = reach(appId);
      const format = query.get("format") ?? "json";
      const headers = (type: string, name: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
      if (format === "json") return deps.send(200, headers("application/json; charset=utf-8", fileName(app, "", "json")), JSON.stringify(deps.apps.exportData(appId), null, 2));
      if (format === "csv") {
        const name = query.get("collection") ?? Object.keys(app.collections)[0];
        if (!name) return deps.json(404, { error: "this app has no data yet" });
        return deps.send(200, headers("text/csv; charset=utf-8", fileName(app, name, "csv")), "﻿" + recordsToCsv(deps.apps.records(appId, name)));
      }
      return deps.json(400, { error: "format must be json or csv" });
    }
    if (sub === "duplicate" && method === "POST") {
      ownerOnly();
      const input = await body();
      const app = deps.apps.get(appId);
      const copied = await deps.copyPage(app.botId, app.threadId, app.path);
      who();
      const name = typeof input.name === "string" && input.name.trim() ? input.name : `${app.name} copy`;
      return deps.json(200, { app: deps.apps.duplicate(appId, { path: copied, name }, first.name) });
    }
    return deps.json(405, { error: "method not allowed" });
  });
}

export interface InternalAppDeps extends AppHttp {
  apps: AppStore;
  botId: string;
  botName: string;
  threadId: string;
  /** The room this turn runs in, or null for the bot's own conversation. */
  roomId: string | null;
  /** Rooms the bot belongs to (its own conversations reach apps shared there). */
  botRoomIds: () => string[];
  requireActive: () => void;
  /** Copy a starter into this conversation's folder and show it; null when this conversation can't show tabs. */
  createFromTemplate: (template: string, name: string, icon: string | undefined) => Promise<{ path: string; app: AppSummary } | null>;
}

const brief = (app: AppSummary) => ({
  app_id: app.id, name: app.name, icon: app.icon, template: app.template, collections: app.collections,
  schema: app.schema, updated_at: new Date(app.updatedAt).toISOString(), shared_rooms: app.sharedRoomIds.length, page: app.path,
});

export async function handleInternalAppRoute(method: string, path: string, query: URLSearchParams, deps: InternalAppDeps): Promise<boolean> {
  const m = path.match(/^\/api\/internal\/apps(?:\/([^/]+)(?:\/(read|write))?)?$/);
  if (!m) return false;
  const [, appId, action] = m;
  return guarded(deps, async () => {
    const reachable = (): AppSummary[] => {
      if (deps.roomId) return deps.apps.sharedInto([deps.roomId]);
      const own = deps.apps.list(deps.botId);
      const shared = deps.apps.sharedInto(deps.botRoomIds()).filter(a => a.botId !== deps.botId);
      return [...own, ...shared];
    };
    const reach = (id: string) => {
      const app = reachable().find(a => a.id === id);
      if (!app) throw Object.assign(new Error(deps.roomId ? "no app with that id is shared into this room; call apps_list" : "no app with that id; call apps_list"), { status: 404 });
      return app;
    };
    const body = async (limit = BATCH_BYTES) => {
      const value = await deps.readBody(limit);
      deps.requireActive();
      return plain(value) ? value : {};
    };
    if (!appId && method === "GET") return deps.json(200, { apps: reachable().slice(0, 100).map(brief) });
    if (!appId && method === "POST") {
      if (deps.roomId) return deps.json(403, { error: "make apps in your own conversation with the owner, then they can share it into this room" });
      const input = await body(4_000);
      const template = String(input.template ?? "");
      if (!(APP_TEMPLATES as readonly string[]).includes(template)) return deps.json(400, { error: `template must be one of ${APP_TEMPLATES.join(", ")}` });
      const made = await deps.createFromTemplate(template, typeof input.name === "string" ? input.name : "", typeof input.icon === "string" ? input.icon : undefined);
      deps.requireActive();
      if (!made) return deps.json(409, { error: "this conversation can't show tabs (it needs a local working folder and a chat that draws)" });
      return deps.json(200, { ...brief(made.app), page: made.path });
    }
    if (appId && action === "read" && method === "GET") {
      const app = reach(appId);
      const collection = query.get("collection");
      if (!collection) {
        const sample = Object.fromEntries(Object.keys(app.collections).map(c => [c, matchRecords(deps.apps.records(appId, c), undefined, 20)]));
        return deps.json(200, { ...brief(app), records: sample });
      }
      const limit = Math.max(1, Math.min(200, Number(query.get("limit")) || 50));
      const records = deps.apps.records(appId, collection);
      return deps.json(200, { app_id: app.id, collection, total: records.length, records: matchRecords(records, query.get("query") ?? undefined, limit) });
    }
    if (appId && action === "write" && method === "POST") {
      reach(appId);
      const input = await body();
      reach(appId);
      const result = deps.apps.write(appId, parseOps(input.ops), deps.botName);
      return deps.json(200, { ok: true, rev: result.rev, records: result.records });
    }
    return deps.json(405, { error: "method not allowed" });
  });
}
