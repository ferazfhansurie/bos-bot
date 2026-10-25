// Apps: blank-tab pages that keep their own data. The page is an html file
// bos writes; its records live on the server, one json file per app, and
// reach the page through the tab's bridge and bots through the app tools.

export const APP_ID_RE = /^a-[a-z0-9]{12}$/;
/** contacts, leave_requests, cells */
export const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// "constructor", "toString", "__proto__" would reach Object.prototype as keys
const reserved = (key: string) => key in Object.prototype;
export const validCollection = (name: string) => COLLECTION_RE.test(name) && !reserved(name);
export const validRecordId = (id: string) => RECORD_ID_RE.test(id) && !reserved(id);

export const APP_LIMITS = {
  /** one record, as json */
  recordBytes: 256 * 1024,
  /** the whole app's data, as json */
  appBytes: 8 * 1024 * 1024,
  collections: 32,
  recordsPerCollection: 5000,
  fieldsPerRecord: 80,
  appsPerBot: 200,
  schemaChars: 2000,
  /** one app_write / bridge batch */
  opsPerWrite: 100,
} as const;

export type AppValue = string | number | boolean | null | AppValue[] | { [key: string]: AppValue };
export type AppRecordInput = Record<string, unknown>;
/** A stored record: the app's own fields plus id, _at (ms) and _by (who wrote it last). */
export type AppRecord = { id: string; _at: number; _by: string } & Record<string, AppValue>;

export interface AppMeta {
  id: string;
  botId: string;
  /** the conversation whose working folder holds the page */
  threadId: string;
  /** the page, relative to that folder */
  path: string;
  name: string;
  icon?: string;
  /** what the collections hold, from <meta name="bos-app-schema">, for bots */
  schema?: string;
  template?: string;
  createdAt: number;
  updatedAt: number;
  rev: number;
  /** rooms (group chats) the owner shared this app into */
  sharedRoomIds: string[];
}
export interface AppSummary extends AppMeta { collections: Record<string, number>; bytes: number }

export interface AppChange { appId: string; botId: string; rev: number; collections: string[]; by: string; deleted?: boolean; meta?: boolean }

export const APP_TEMPLATES = ["crm", "hr", "sheet", "docs", "tasks", "invoices", "blank"] as const;
export type AppTemplate = typeof APP_TEMPLATES[number];
export const APP_TEMPLATE_LABEL: Record<AppTemplate, string> = {
  crm: "CRM", hr: "HR", sheet: "Sheet", docs: "Docs", tasks: "Tasks", invoices: "Invoices", blank: "App",
};
/** lucide icon names the library knows; anything else shows the default */
export const APP_ICONS = ["users", "briefcase", "table", "file-text", "kanban", "receipt", "box", "calendar", "heart", "star", "shopping-cart", "package", "clipboard-list", "wallet", "graduation-cap", "home"] as const;
export const APP_TEMPLATE_ICON: Record<AppTemplate, string> = {
  crm: "users", hr: "briefcase", sheet: "table", docs: "file-text", tasks: "kanban", invoices: "receipt", blank: "box",
};

/** `<meta name="bos-app" content="…">`, with optional icon and schema metas. */
export function appMeta(html: string): { name: string; icon?: string; schema?: string } | null {
  const head = html.slice(0, 20_000);
  const meta = (name: string) => {
    const re = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*>`, "i");
    const tag = re.exec(head)?.[0];
    const content = tag && /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return content ? (content[1] ?? content[2] ?? "").replace(/\s+/g, " ").trim() : undefined;
  };
  const name = meta("bos-app");
  if (name === undefined) return null;
  return { name: name.slice(0, 60) || "App", icon: meta("bos-app-icon")?.slice(0, 32) || undefined, schema: meta("bos-app-schema")?.slice(0, APP_LIMITS.schemaChars) || undefined };
}

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

/** Validate a record the page or a bot sends: plain json, bounded, sane keys.
 * Reserved fields (id, _at, _by) are dropped; the store sets them. */
export function cleanFields(input: unknown, label = "record"): Record<string, AppValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, `${label} must be an object`);
  const out: Record<string, AppValue> = {};
  const entries = Object.entries(input as Record<string, unknown>).filter(([k]) => k !== "id" && k !== "_at" && k !== "_by");
  if (entries.length > APP_LIMITS.fieldsPerRecord) fail(400, `${label} has more than ${APP_LIMITS.fieldsPerRecord} fields`);
  for (const [key, value] of entries) {
    if (!FIELD_RE.test(key)) fail(400, `field "${key.slice(0, 40)}": use letters, digits and _ (start with a letter)`);
    out[key] = cleanValue(value, `${label}.${key}`, 0);
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > APP_LIMITS.recordBytes) fail(413, `${label} is larger than ${APP_LIMITS.recordBytes / 1024} KB`);
  return out;
}

function cleanValue(value: unknown, label: string, depth: number): AppValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value as AppValue;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(400, `${label} must be a finite number`); return value; }
  if (depth >= 6) fail(400, `${label} is nested too deeply`);
  if (Array.isArray(value)) {
    if (value.length > 2000) fail(400, `${label} has more than 2000 items`);
    return value.map((v, i) => cleanValue(v, `${label}[${i}]`, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, AppValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.length > 64 || k === "__proto__" || k === "constructor" || k === "prototype") fail(400, `${label} has a bad key`);
      out[k] = cleanValue(v, `${label}.${k}`, depth + 1);
    }
    return out;
  }
  return fail(400, `${label} must be json (text, number, true/false, null, list or object)`);
}

/** CSV for one collection: id first, then every field seen, in first-seen order. */
export function recordsToCsv(records: readonly AppRecord[]): string {
  const cols: string[] = ["id"];
  for (const r of records) for (const k of Object.keys(r)) if (!cols.includes(k) && k !== "_by" && k !== "_at") cols.push(k);
  cols.push("_at", "_by");
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // a spreadsheet must not run a text cell as a formula (numbers like -50 stay numbers)
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of records) lines.push(cols.map(c => cell(c === "_at" ? new Date(r._at).toISOString() : (r as Record<string, unknown>)[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
