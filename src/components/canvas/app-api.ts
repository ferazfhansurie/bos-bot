// The tab's side of /api/apps. Cookies carry the session: the owner reaches
// every app, a person in a room only the apps shared into it.
import type { AppRecord, AppSummary } from "../../../shared/apps";
import type { MiniAppManifest } from "../../../shared/mini-apps";

export class AppApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  return body as T;
}

const one = (appId: string) => `/api/apps/${encodeURIComponent(appId)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
type Op = { op: "put"; collection: string; id?: string; record: unknown } | { op: "patch"; collection: string; id: string; fields: unknown } | { op: "delete"; collection: string; id: string };

/** What an install link asks for, held server-side under token until the owner says yes. */
export interface InstallPreview {
  manifest: MiniAppManifest;
  source: string;
  host: string;
  builtin: boolean;
  bytes: number;
  /** bots that already run this app: botId → its app and version */
  existing: Record<string, { appId: string; version: string }>;
}

/** "app:a-…" opens an app by id (rooms, the library, the new tab). */
export const APP_REF_PREFIX = "app:";
export const appRefId = (ref: string | undefined) => ref?.startsWith(APP_REF_PREFIX) ? ref.slice(APP_REF_PREFIX.length) : null;

export const appApi = {
  listForBot: (botId: string) => call<{ apps: AppSummary[] }>(`/api/apps?botId=${encodeURIComponent(botId)}`).then(r => r.apps),
  listForRoom: (roomId: string) => call<{ apps: AppSummary[] }>(`/api/apps?roomId=${encodeURIComponent(roomId)}`).then(r => r.apps),
  ensure: (botId: string, threadId: string, path: string) => call<{ app: AppSummary | null }>("/api/apps/ensure", json("POST", { botId, threadId, path })).then(r => r.app),
  get: (appId: string) => call<{ app: AppSummary; owner: boolean }>(one(appId)),
  page: (appId: string) => call<{ html: string; mtime: number; app: AppSummary; owner: boolean }>(`${one(appId)}/page`),
  update: (appId: string, input: { name?: string; icon?: string; sharedRoomIds?: string[] }) => call<{ app: AppSummary }>(one(appId), json("PATCH", input)).then(r => r.app),
  destroy: (appId: string) => call<{ ok: true }>(one(appId), { method: "DELETE" }),
  duplicate: (appId: string) => call<{ app: AppSummary }>(`${one(appId)}/duplicate`, json("POST", {})).then(r => r.app),
  records: (appId: string, collection: string) => call<{ records: AppRecord[] }>(`${one(appId)}/data/${encodeURIComponent(collection)}`).then(r => r.records),
  record: (appId: string, collection: string, id: string) => call<{ record: AppRecord | null }>(`${one(appId)}/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`).then(r => r.record),
  write: (appId: string, ops: Op[]) => call<{ records: (AppRecord | null)[]; rev: number }>(`${one(appId)}/data`, json("POST", { ops })),
  previewInstall: (from: { url: string } | { builtin: string }) => call<{ token: string; preview: InstallPreview }>("/api/apps/install/preview", json("POST", from)),
  install: (token: string, botId: string) => call<{ app: AppSummary; updated: boolean }>("/api/apps/install", json("POST", { token, botId })),
  exportUrl: (appId: string, format: "json" | "csv", collection?: string) => `${one(appId)}/export?format=${format}${collection ? `&collection=${encodeURIComponent(collection)}` : ""}`,
};
