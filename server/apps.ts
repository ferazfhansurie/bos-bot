// App data: one json file per app under the bot folder, which sits outside
// the bot-writable workspace, so a page or a bot only changes app data
// through the bridge and the app tools (never by editing the file), and
// deleting the bot deletes its apps. The page html itself stays a normal
// file in the conversation's working folder that bos edits.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { botFolder } from "./bot-folder.ts";
import {
  APP_ID_RE, APP_LIMITS, cleanFields, validCollection, validRecordId,
  type AppChange, type AppMeta, type AppRecord, type AppSummary,
} from "../shared/apps.ts";
import { installOrigin, MINI_APP_LIMITS, manifestSchema, type MiniAppManifest } from "../shared/mini-apps.ts";

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

interface AppFile { meta: AppMeta; data: Record<string, Record<string, AppRecord>> }

export type AppOp =
  | { op: "put"; collection: string; id?: string; record: unknown }
  | { op: "patch"; collection: string; id: string; fields: unknown }
  | { op: "delete"; collection: string; id: string };

export interface AppWriteResult { records: (AppRecord | null)[]; collections: string[]; rev: number }

const newAppId = () => `a-${Array.from(randomBytes(12), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
/** An installed app's page sits beside its data file: <app id>.app.html. */
const INSTALLED_PAGE = ".app.html";
export const INSTALLED_PATH_PREFIX = "installed:";

const newRecordId = () => Date.now().toString(36) + randomBytes(4).toString("hex");

export class AppStore {
  private cache = new Map<string, Map<string, AppFile>>();
  private readonly root: (botId: string) => string;
  private readonly now: () => number;
  private readonly onChange: (change: AppChange) => void;
  private readonly botIds: () => string[];

  constructor(options: { root?: (botId: string) => string; now?: () => number; onChange?: (change: AppChange) => void; botIds?: () => string[] } = {}) {
    this.root = options.root ?? (botId => join(botFolder(botId), "apps"));
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
    this.botIds = options.botIds ?? (() => [...this.cache.keys()]);
  }

  private dir(botId: string) {
    if (!/^[\w-]+$/.test(botId)) fail(400, "bad bot id");
    return this.root(botId);
  }

  private apps(botId: string): Map<string, AppFile> {
    let apps = this.cache.get(botId);
    if (apps) return apps;
    apps = new Map();
    const dir = this.dir(botId);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !APP_ID_RE.test(id)) continue;
        try {
          const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as AppFile;
          if (file?.meta?.id === id && file.meta.botId === botId && file.data && typeof file.data === "object") apps.set(id, file);
        } catch { /* a damaged app file stays on disk for recovery and is skipped */ }
      }
    }
    this.cache.set(botId, apps);
    return apps;
  }

  /** Drop the cached copy after the bot (and its folder) is deleted. */
  forget(botId: string) { this.cache.delete(botId); }

  private persist(file: AppFile) {
    const encoded = JSON.stringify(file);
    if (Buffer.byteLength(encoded) > APP_LIMITS.appBytes + 64_000) fail(413, `this app's data is over ${APP_LIMITS.appBytes / 1024 / 1024} MB; export and remove old records first`);
    const dir = this.dir(file.meta.botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, `${file.meta.id}.json`), encoded, { mode: 0o600 });
    this.apps(file.meta.botId).set(file.meta.id, file);
  }

  private file(appId: string): AppFile {
    if (!APP_ID_RE.test(appId)) fail(400, "app id must look like a-xxxxxxxxxxxx");
    for (const botId of new Set([...this.cache.keys(), ...this.botIds()])) {
      let found: AppFile | undefined;
      try { found = this.apps(botId).get(appId); } catch { continue; }
      if (found) return found;
    }
    return fail(404, "no such app");
  }

  private summary(file: AppFile): AppSummary {
    const collections: Record<string, number> = {};
    for (const [name, rows] of Object.entries(file.data)) collections[name] = Object.keys(rows).length;
    return { ...file.meta, sharedRoomIds: [...file.meta.sharedRoomIds], collections, bytes: Buffer.byteLength(JSON.stringify(file.data)) };
  }

  list(botId: string): AppSummary[] {
    return [...this.apps(botId).values()].map(f => this.summary(f)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every app shared into one of these rooms, any bot. */
  sharedInto(roomIds: readonly string[]): AppSummary[] {
    if (!roomIds.length) return [];
    const out: AppSummary[] = [];
    for (const botId of new Set([...this.cache.keys(), ...this.botIds()])) {
      let apps: Map<string, AppFile>;
      try { apps = this.apps(botId); } catch { continue; }
      for (const f of apps.values()) if (f.meta.sharedRoomIds.some(id => roomIds.includes(id))) out.push(this.summary(f));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(appId: string): AppSummary { return this.summary(this.file(appId)); }

  byPage(botId: string, threadId: string, path: string): AppSummary | null {
    for (const f of this.apps(botId).values()) if (f.meta.threadId === threadId && f.meta.path === path) return this.summary(f);
    return null;
  }

  /** The app for a page, made the first time the page is shown or opened. */
  ensure(botId: string, input: { threadId: string; path: string; name: string; icon?: string; schema?: string; template?: string }, by: string): AppSummary {
    const existing = this.byPage(botId, input.threadId, input.path);
    const name = clip(input.name, 60) || "App";
    const icon = input.icon ? clip(input.icon, 32) : undefined;
    const schema = input.schema ? clip(input.schema, APP_LIMITS.schemaChars) : undefined;
    if (existing) {
      const file = this.file(existing.id);
      if (file.meta.name === name && file.meta.icon === icon && file.meta.schema === schema) return existing;
      file.meta = { ...file.meta, name, icon, schema, updatedAt: this.now() };
      this.persist(file);
      this.onChange({ appId: file.meta.id, botId, rev: file.meta.rev, collections: [], by, meta: true });
      return this.summary(file);
    }
    if (this.apps(botId).size >= APP_LIMITS.appsPerBot) fail(409, `a bot can keep at most ${APP_LIMITS.appsPerBot} apps; delete one first`);
    if (!input.path || input.path.length > 1024) fail(400, "bad page path");
    const at = this.now();
    const file: AppFile = {
      meta: { id: newAppId(), botId, threadId: input.threadId, path: input.path, name, icon, schema, template: input.template, createdAt: at, updatedAt: at, rev: 0, sharedRoomIds: [] },
      data: {},
    };
    this.persist(file);
    this.onChange({ appId: file.meta.id, botId, rev: 0, collections: [], by, meta: true });
    return this.summary(file);
  }

  /** Install a mini app for a bot, or update the one it already has from the
   * same site and manifest id (the data stays; the page, version and grants change). */
  install(botId: string, input: { manifest: MiniAppManifest; html: string; source: string; schema?: string }, by: string): AppSummary {
    const { manifest, html } = input;
    if (Buffer.byteLength(html) > MINI_APP_LIMITS.htmlBytes) fail(413, `the app's page is over ${MINI_APP_LIMITS.htmlBytes / 1024 / 1024} MB`);
    const at = this.now();
    const installed = {
      manifestId: manifest.id, version: manifest.version, source: clip(input.source, 2000), author: manifest.author,
      description: manifest.description, permissions: [...manifest.permissions], installedAt: at,
    };
    const schema = manifestSchema(manifest, input.schema);
    const existing = this.installedFile(botId, manifest.id, input.source);
    const file: AppFile = existing
      ? { ...existing, meta: { ...existing.meta, name: clip(manifest.name, 60) || existing.meta.name, icon: manifest.icon, schema, installed, updatedAt: at } }
      : (() => {
        if (this.apps(botId).size >= APP_LIMITS.appsPerBot) fail(409, `a bot can keep at most ${APP_LIMITS.appsPerBot} apps; delete one first`);
        const id = newAppId();
        return {
          meta: { id, botId, threadId: "", path: `${INSTALLED_PATH_PREFIX}${manifest.id}`, name: clip(manifest.name, 60) || "App", icon: manifest.icon, schema, createdAt: at, updatedAt: at, rev: 0, sharedRoomIds: [], installed },
          data: {},
        };
      })();
    const dir = this.dir(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, `${file.meta.id}${INSTALLED_PAGE}`), html, { mode: 0o600 });
    this.persist(file);
    this.onChange({ appId: file.meta.id, botId, rev: file.meta.rev, collections: [], by, meta: true });
    return this.summary(file);
  }

  private installedFile(botId: string, manifestId: string, source: string): AppFile | null {
    const origin = installOrigin(source);
    for (const f of this.apps(botId).values()) {
      const got = f.meta.installed;
      if (got?.manifestId === manifestId && installOrigin(got.source) === origin) return f;
    }
    return null;
  }

  /** The bot's installed copy of this site's manifest id, if it has one. */
  installedFor(botId: string, manifestId: string, source: string): AppSummary | null {
    const file = this.installedFile(botId, manifestId, source);
    return file ? this.summary(file) : null;
  }

  /** An installed app's page; null for a page bos wrote (that one is a file in the conversation folder). */
  installedPage(appId: string): { html: string; mtime: number } | null {
    const file = this.file(appId);
    if (!file.meta.installed) return null;
    try {
      const html = readFileSync(join(this.dir(file.meta.botId), `${appId}${INSTALLED_PAGE}`), "utf8");
      return { html, mtime: file.meta.installed.installedAt };
    } catch { return null; }
  }

  records(appId: string, collection: string): AppRecord[] {
    if (!validCollection(collection)) fail(400, "collection must be a short lowercase name like contacts");
    return Object.values(this.file(appId).data[collection] ?? {});
  }

  record(appId: string, collection: string, id: string): AppRecord | null {
    if (!validCollection(collection)) fail(400, "collection must be a short lowercase name like contacts");
    const rows = this.file(appId).data[collection];
    return rows && Object.hasOwn(rows, id) ? rows[id]! : null;
  }

  /** Apply a batch all or nothing; one persist and one change event. */
  write(appId: string, ops: readonly AppOp[], by: string): AppWriteResult {
    if (!ops.length || ops.length > APP_LIMITS.opsPerWrite) fail(400, `send 1-${APP_LIMITS.opsPerWrite} operations`);
    const file = this.file(appId);
    const data: AppFile["data"] = {};
    for (const [k, v] of Object.entries(file.data)) data[k] = { ...v };
    const at = this.now();
    const touched = new Set<string>();
    const records: (AppRecord | null)[] = [];
    ops.forEach((op, index) => {
      const label = `operation ${index + 1}`;
      if (!validCollection(op.collection)) fail(400, `${label}: collection must be a short lowercase name like contacts`);
      if (op.id !== undefined && !validRecordId(op.id)) fail(400, `${label}: id must be 1-64 letters, digits, _ or -`);
      if (!data[op.collection]) {
        if (op.op === "delete") { records.push(null); return; }
        if (Object.keys(data).length >= APP_LIMITS.collections) fail(409, `an app can have at most ${APP_LIMITS.collections} collections`);
        data[op.collection] = {};
      }
      const rows = data[op.collection]!;
      if (op.op === "delete") {
        delete rows[op.id];
        records.push(null);
      } else if (op.op === "put") {
        const id = op.id ?? newRecordId();
        if (!rows[id] && Object.keys(rows).length >= APP_LIMITS.recordsPerCollection) fail(409, `${op.collection} is full (${APP_LIMITS.recordsPerCollection} records)`);
        const record = { ...cleanFields(op.record, label), id, _at: at, _by: by } as AppRecord;
        rows[id] = record; records.push(record);
      } else if (op.op === "patch") {
        const prev = rows[op.id];
        if (!prev) fail(404, `${label}: no ${op.collection} record ${op.id}`);
        const { id: _i, _at: _a, _by: _b, ...rest } = prev!;
        const record = cleanFields({ ...rest, ...cleanFields(op.fields, label) }, label);
        rows[op.id] = { ...record, id: op.id, _at: at, _by: by } as AppRecord; records.push(rows[op.id]!);
      } else fail(400, `${label}: op must be put, patch or delete`);
      touched.add(op.collection);
    });
    for (const [k, v] of Object.entries(data)) if (!Object.keys(v).length) delete data[k];
    const next: AppFile = { meta: { ...file.meta, rev: file.meta.rev + 1, updatedAt: at }, data };
    this.persist(next);
    this.onChange({ appId, botId: next.meta.botId, rev: next.meta.rev, collections: [...touched], by });
    return { records, collections: [...touched], rev: next.meta.rev };
  }

  update(appId: string, patch: { name?: unknown; icon?: unknown; sharedRoomIds?: string[] }, by: string): AppSummary {
    const file = this.file(appId);
    const meta = { ...file.meta };
    if (typeof patch.name === "string") meta.name = clip(patch.name, 60) || meta.name;
    if (typeof patch.icon === "string") meta.icon = clip(patch.icon, 32) || undefined;
    if (patch.sharedRoomIds) meta.sharedRoomIds = [...new Set(patch.sharedRoomIds)].slice(0, 50);
    meta.updatedAt = this.now();
    this.persist({ ...file, meta });
    this.onChange({ appId, botId: meta.botId, rev: meta.rev, collections: [], by, meta: true });
    return this.get(appId);
  }

  /** A copy of the app (data included) for a copied page. */
  duplicate(appId: string, input: { path: string; name: string }, by: string): AppSummary {
    const file = this.file(appId);
    if (file.meta.installed) fail(409, "an installed app can't be copied; install it for another bot instead");
    if (this.apps(file.meta.botId).size >= APP_LIMITS.appsPerBot) fail(409, `a bot can keep at most ${APP_LIMITS.appsPerBot} apps; delete one first`);
    const at = this.now();
    const copy: AppFile = {
      meta: { ...file.meta, id: newAppId(), path: input.path, name: clip(input.name, 60) || file.meta.name, createdAt: at, updatedAt: at, rev: 0, sharedRoomIds: [] },
      data: JSON.parse(JSON.stringify(file.data)),
    };
    this.persist(copy);
    this.onChange({ appId: copy.meta.id, botId: copy.meta.botId, rev: 0, collections: [], by, meta: true });
    return this.summary(copy);
  }

  destroy(appId: string, by: string) {
    const file = this.file(appId);
    rmSync(join(this.dir(file.meta.botId), `${appId}.json`), { force: true });
    if (file.meta.installed) rmSync(join(this.dir(file.meta.botId), `${appId}${INSTALLED_PAGE}`), { force: true });
    this.apps(file.meta.botId).delete(appId);
    this.onChange({ appId, botId: file.meta.botId, rev: file.meta.rev, collections: [], by, deleted: true });
  }

  /** Everything, for the json export. */
  exportData(appId: string): { app: AppMeta; data: Record<string, AppRecord[]> } {
    const file = this.file(appId);
    return { app: file.meta, data: Object.fromEntries(Object.entries(file.data).map(([k, v]) => [k, Object.values(v)])) };
  }
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
