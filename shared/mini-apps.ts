// Mini apps: an app someone else wrote, installed from a link. It is the
// same thing as an app bos writes (an html page plus records the server
// keeps), with a manifest that says what it is and what it asks for. The
// page is untrusted code: it runs in a sandbox with no network and reaches
// only its own records through the tab's bridge. Nothing else is grantable
// yet; the permission list below stays empty until a grant can be enforced
// in code (a bot turn an app can start would still see the bot's memory).
//
// The manifest is small on purpose. A JSON file:
//   { "id": "crm", "name": "CRM", "version": "1.0.0", "entry": "index.html",
//     "icon": "users", "author": "bos bot", "description": "…",
//     "permissions": [],
//     "collections": { "contacts": "name, stage (lead|hot|won), value (RM)" } }
// or the same object inline in a single html file:
//   <script type="application/bos-app+json">{ … }</script>
// Permission names are the mods vocabulary, so a mod and an app that ask
// for the same thing say it the same way.
import { APP_ICONS, APP_LIMITS, validCollection } from "./apps.ts";

/** What an installed app can ask for beyond its own records: nothing yet. */
export const MINI_APP_PERMISSIONS: readonly string[] = [];
export type MiniAppPermission = string;

export const MINI_APP_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** a file next to the manifest: no scheme, no leading slash, no .. */
const ENTRY_RE = /^(?!\/)(?!.*\.\.)(?!.*:)[A-Za-z0-9_./-]{1,200}\.html?$/;

export const MINI_APP_LIMITS = {
  /** the entry html */
  htmlBytes: 2 * 1024 * 1024,
  /** the manifest json */
  manifestBytes: 32 * 1024,
} as const;

export interface MiniAppManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  /** the page, relative to the manifest; absent when the manifest sits inside the page */
  entry?: string;
  permissions: MiniAppPermission[];
  /** collection name → what it holds, for bots (becomes the app's schema) */
  collections: Record<string, string>;
}

/** What AppMeta keeps about an installed app. */
export interface InstalledInfo {
  manifestId: string;
  version: string;
  /** the link it came from, or "builtin:<id>"; with manifestId, which install this is (installOrigin) */
  source: string;
  author?: string;
  description?: string;
  permissions: MiniAppPermission[];
  installedAt: number;
}

export type ManifestResult = { ok: true; manifest: MiniAppManifest } | { ok: false; error: string };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Check a manifest from a link. Errors are written for the owner, since
 * they show in the install sheet. Unknown top-level keys are ignored so a
 * newer manifest (cards, tools) still installs what this version supports. */
export function parseMiniAppManifest(raw: unknown, options: { needEntry?: boolean } = {}): ManifestResult {
  const no = (error: string): ManifestResult => ({ ok: false, error });
  if (!plain(raw)) return no("the manifest must be a json object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!MINI_APP_ID_RE.test(id)) return no("id must be 2-40 lowercase letters, digits or -, starting with a letter");
  const name = text(raw.name, 60);
  if (!name) return no("name is missing");
  const version = typeof raw.version === "string" ? raw.version : "";
  if (!VERSION_RE.test(version)) return no("version must look like 1.0.0");

  let entry: string | undefined;
  if (raw.entry !== undefined) {
    if (typeof raw.entry !== "string" || !ENTRY_RE.test(raw.entry)) return no("entry must be an .html file next to the manifest, like index.html");
    entry = raw.entry;
  } else if (options.needEntry) return no("entry is missing (the app's .html file, like index.html)");

  const permissions: MiniAppPermission[] = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) return no("permissions must be a list");
    for (const p of raw.permissions) {
      if (typeof p !== "string" || !MINI_APP_PERMISSIONS.includes(p)) {
        return no(`this app asks for "${text(p, 40) || "?"}", which bos doesn't grant. installed apps get only their own records in this version of bos`);
      }
      if (!permissions.includes(p)) permissions.push(p);
    }
  }

  // apps run offline in 3.0; a declared domain is refused, never silently dropped
  const network = raw.network ?? raw.domains;
  if (network !== undefined && !(Array.isArray(network) && network.length === 0)) {
    const list = Array.isArray(network) ? network.map(d => text(d, 60)).filter(Boolean).slice(0, 3).join(", ") : "the internet";
    return no(`this app wants to reach ${list || "the internet"}. installed apps run offline in this version of bos, so it can't be added`);
  }

  const collections: Record<string, string> = {};
  if (raw.collections !== undefined) {
    if (!plain(raw.collections)) return no("collections must be an object of name → what it holds");
    const entries = Object.entries(raw.collections);
    if (entries.length > APP_LIMITS.collections) return no(`an app can have at most ${APP_LIMITS.collections} collections`);
    for (const [key, value] of entries) {
      if (!validCollection(key)) return no(`collection "${text(key, 40)}" must be a short lowercase name like contacts`);
      collections[key] = text(value, 200);
    }
  }

  const icon = typeof raw.icon === "string" && (APP_ICONS as readonly string[]).includes(raw.icon) ? raw.icon : undefined;
  const description = text(raw.description, 300) || undefined;
  const author = text(raw.author, 60) || undefined;
  return { ok: true, manifest: { id, name, version, description, author, icon, entry, permissions, collections } };
}

/** The manifest inside a single-file app: an inline
 * `<script type="application/bos-app+json">`, or failing that the bos-app
 * metas a page bos wrote already carries (id from the name, version 1.0.0). */
export function manifestFromHtml(html: string): unknown | null {
  const head = html.slice(0, 200_000);
  const inline = /<script\b[^>]*\btype=["']application\/bos-app\+json["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(head);
  if (inline) {
    try { return JSON.parse(inline[1]!); } catch { return { invalid: true }; }
  }
  const meta = (name: string) => {
    const tag = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*>`, "i").exec(head)?.[0];
    const content = tag && /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return content ? (content[1] ?? content[2] ?? "").trim() : undefined;
  };
  const name = meta("bos-app");
  if (name === undefined) return null;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 40);
  return { id: id.length >= 2 ? id : "app", name: name || "App", version: meta("bos-app-version") || "1.0.0", icon: meta("bos-app-icon"), collections: {}, schema: meta("bos-app-schema") };
}

/** `<link rel="bos-app-manifest" href="…">`: a landing page pointing at its manifest. */
export function manifestLink(html: string): string | null {
  const tag = /<link\b[^>]*\brel=["']bos-app-manifest["'][^>]*>/i.exec(html.slice(0, 200_000))?.[0];
  const href = tag && /href=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return href ? (href[1] ?? href[2] ?? "").trim() || null : null;
}

/** The schema line bots read (app_read), built from the manifest. */
export function manifestSchema(manifest: MiniAppManifest, fallback?: string): string | undefined {
  const parts = Object.entries(manifest.collections).map(([name, holds]) => holds ? `${name}: ${holds}` : name);
  const schema = parts.join("; ") || fallback || "";
  return schema ? schema.slice(0, APP_LIMITS.schemaChars) : undefined;
}

/** One line per thing the app can do, for the install sheet. Its own
 * records are always on the list, so the owner sees the whole picture. */
export function permissionLines(manifest: Pick<MiniAppManifest, "collections">, botName: string): { key: string; text: string; detail: string }[] {
  const names = Object.keys(manifest.collections);
  return [{
    key: "records",
    text: names.length ? `keep its own ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}` : "keep its own records",
    detail: `only this app's data. ${botName} can read and change it too.`,
  }];
}

/** Who an install belongs to: the site it came from (or bos, for a builtin).
 * An update must come from the same place, so another site can't publish an
 * app under the same id and take over the records an install already keeps. */
export function installOrigin(source: string): string {
  if (source.startsWith("builtin:")) return "builtin";
  try { return new URL(source).origin; } catch { return source; }
}

/** Things an installed app never gets, said plainly in the sheet. */
export const MINI_APP_NEVER = "no internet. it can't see your chats, files, keys or other apps.";

/** Link → the url bos fetches. Accepts bosbot.my/a/crm without the scheme. */
export function normalizeInstallUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.hash = "";
  return url.toString();
}
