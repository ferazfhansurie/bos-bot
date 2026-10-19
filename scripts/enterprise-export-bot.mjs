#!/usr/bin/env node
// Export one client's bot from a shared hosted BOS server (e.g. the aihlete
// server, where we set client bots up first) into a fresh folder that
// becomes the provisioning archive for the client's own Mac, plus the /setup
// document that the per-client dmg applies on first launch.
//
//   node scripts/enterprise-export-bot.mjs --source <dataDir> --bot <id> \
//     --slug <slug> --label <label> --out <dir> --deny <file> \
//     [--allow <term>]... [--engine codex|claude] [--model <id>] \
//     [--tools <build-script>] [--mcp <name>=<entry.mjs>]... \
//     [--skip-thread <threadId>]... [--replace <old>=<new>]... \
//     [--allow-binary <path>]... [--allow-in-secrets <literal>]... \
//     [--server-secrets <file|dir>]... [--server-env <file|dir>]...
//
// Everything is an allow list. The bot record and each of its threads keep
// only the fields below; messages.db is a fresh database holding only the
// bot's own messages (nothing deleted, so no other client's text survives
// in free pages); files come from the bot's own folders and its kept
// threads' folders, minus its old server tool build and profile history;
// attachments only when a kept message names them and no other thread does.
// Other bots, rooms, followups, routines, logins, usage and our profile stay
// behind. Work happens in <out>.partial-<pid> and is renamed into place only
// when every check passes.
//
// Data wall: --deny names a private file (kept on the server, never in this
// repo) with one term or /regex/ per line for every other client, business
// and person. Text is checked after decoding json (and json inside json
// strings), undoing escapes, NFKC folding and removing accents and
// invisible characters. Markdown lines and soul lines that hit it are
// replaced; any remaining hit in a file, path, json string, message, or the
// raw database bytes, any other bot's, thread's or room's id, any secret
// value held elsewhere on the server (the data dir, plus our logins named by
// --server-secrets and mixed env files named by --server-env), anything that looks like a credential
// outside tools/secrets, a symlink, or a binary file that isn't real media
// (unless --allow-binary names it) fails the export. --allow drops a deny
// term that is this client's own name.
//
// --skip-thread leaves one of its threads behind (our own setup or test
// threads, talks with our bots). --replace rewrites a literal in kept text
// (e.g. a key filename named after another client).
//
// --tools runs `node <build-script> <out>/workspaces/<bot>/tools`, the
// client's own Mac build of its MCP tools. Each --mcp maps a server the bot
// uses to its built entry file; a bot server without a Mac build fails. The
// files under tools/secrets are listed (names and keys, never values), and
// the media files by path, for sign-off before the dmg is packed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

process.umask(0o077);
const { values: opt } = parseArgs({
  options: {
    source: { type: "string" }, bot: { type: "string" }, slug: { type: "string" }, label: { type: "string" },
    out: { type: "string" }, deny: { type: "string" }, allow: { type: "string", multiple: true, default: [] },
    engine: { type: "string", default: "codex" }, model: { type: "string" },
    tools: { type: "string" }, mcp: { type: "string", multiple: true, default: [] },
    "skip-thread": { type: "string", multiple: true, default: [] }, replace: { type: "string", multiple: true, default: [] },
    "allow-binary": { type: "string", multiple: true, default: [] }, "allow-in-secrets": { type: "string", multiple: true, default: [] },
    "server-secrets": { type: "string", multiple: true, default: [] }, "server-env": { type: "string", multiple: true, default: [] },
  },
});
const need = (k) => { if (!opt[k]) throw new Error(`--${k} is required`); return opt[k]; };
const source = need("source"), botId = need("bot"), slug = need("slug"), label = need("label"), out = need("out");
const ID = /^[A-Za-z0-9_-]+$/;
if (!ID.test(botId)) throw new Error("--bot is not a plain id");
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error("slug must be lowercase letters, digits and dashes");
if (!["codex", "claude"].includes(opt.engine)) throw new Error("--engine is codex or claude");
if (existsSync(out)) throw new Error(`${out} already exists`);
const stale = existsSync(dirname(out)) ? readdirSync(dirname(out)).filter((n) => n.startsWith(`${basename(out)}.partial-`)) : [];
if (stale.length) throw new Error(`an earlier export was killed half way; delete ${stale.map((n) => join(dirname(out), n)).join(", ")} first`);
const engine = opt.engine === "codex"
  ? { instanceId: "codex", instance: { driver: "codex", displayName: "ChatGPT" }, model: opt.model ?? "gpt-6.1-sol", features: { managedCodex: true } }
  : { instanceId: "claude", instance: { driver: "claudeAgent", displayName: "Claude" }, model: opt.model ?? "claude-opus-5-5", features: { managedClaude: true } };

// ── data wall rules ────────────────────────────────────────────────────
// Everything is compared folded: compatibility forms (fullwidth) unified, accents and invisible characters dropped.
const fold = (s) => s.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "").normalize("NFKC");
// Escapes (\n, \u00e9, \x41, \\) are undone a layer at a time, so text inside a json string inside json, or a string literal in code, is checked as it reads.
const ESC = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbfv0])|(["'`\\/]))/g;
const unescape = (s) => s.replace(ESC, (m, a, b, c, ws, lit) => {
  if (ws) return " ";
  if (lit) return lit;
  const cp = parseInt(a ?? b ?? c, 16);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
});
const variants = (s) => {
  const out = [s];
  for (let i = 0; i < 6 && s.includes("\\"); i++) { const next = unescape(s); if (next === s) break; out.push(s = next); }
  return out;
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const allow = new Set(opt.allow.map((t) => fold(t).toLowerCase()));
const terms = readFileSync(need("deny"), "utf8").split("\n").map((l) => fold(l.trim())).filter((l) => l && !l.startsWith("#"));
// \b is ascii-only in js. A side of a term that is itself punctuation (an @domain) needs no edge.
const WORD = /[\p{L}\p{N}]/u;
const patterns = terms.filter((t) => !allow.has(t.toLowerCase())).map((t) => {
  if (t.startsWith("/") && t.lastIndexOf("/") > 0) return t.slice(1, t.lastIndexOf("/"));
  return `${WORD.test(t[0]) ? "(?<![\\p{L}\\p{N}])" : ""}${escape(t)}${WORD.test(t.at(-1)) ? "(?![\\p{L}\\p{N}])" : ""}`;
});
if (!patterns.length) throw new Error("the deny file has no terms");
const OTHER = new RegExp(patterns.join("|"), "iu");
// --allow-in-secrets: a literal the client's own keys can't avoid (a cloud project named after another client), signed off by name.
const secretLiterals = opt["allow-in-secrets"];
if (secretLiterals.some((l) => l.length < 4)) throw new Error("--allow-in-secrets needs at least 4 characters");
// A line that states the rule ("never other clients, personal or ops data") is checked without that phrase.
const RULE = /other[- ]clients?(?:[,/ ]+(?:or |and )?personal)?(?:[,/ ]+(?:or |and )?ops)?(?: data| history)?|personal(?:,| or| and|\/) ?ops(?: data| history)?/giu;
// camelCase and snake_case names are checked as words too (WidgetcoBot, widgetco_notes).
const offending = (line) => {
  const t = fold(line).replace(RULE, " ");
  return (OTHER.exec(t) ?? OTHER.exec(t.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/_/g, " ")))?.[0] ?? null;
};
// Same families as shared/redact.ts, plus the ones a client's stack hits.
const KEY_NAME = "(?:api[_-]?key|apikey|secret|token|password|passwd|pass|pwd|auth[_-]?token|access[_-]?key|private[_-]?key)";
const CREDENTIAL = [
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, /\bomb_[a-z]+_[A-Za-z0-9_-]{20,}/, /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/, /\bxai-[A-Za-z0-9_-]{20,}/, /\bgsk_[A-Za-z0-9]{40,}/, /\bhf_[A-Za-z0-9]{30,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abposr]-[A-Za-z0-9-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/, /\bnpm_[A-Za-z0-9]{20,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bEAA[A-Za-z0-9]{30,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/, /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"«»]+@/i,
  new RegExp(`\\b(?:[A-Za-z0-9_-]*_)?${KEY_NAME}s?["']?\\s*[=:]\\s*["']?(?=[^\\s"'\`,;]*[A-Za-z])[^\\s"'\`,;]{8,}`, "i"),
];
const GENERIC = CREDENTIAL.length - 1;
// In code a key name followed by a variable is normal; only a quoted literal value (or a literal fallback) counts there.
const CODE_GENERIC = new RegExp(`\\b(?:[A-Za-z0-9_-]*_)?(?:${KEY_NAME}|key)s?["']?\\s*[=:]\\s*(?:[^;\\n"'\`]{0,80}?(?:\\|\\||\\?\\?)\\s*)?["'\`](?![\\w-]*placeholder["'\`])[^\\s"'\`]{8,}["'\`]`, "i");
// Our own engine logins never ship, not even in the client's secrets: claude oauth tokens and chatgpt session jwts.
const ourToken = (text) => /\bsk-ant-(?:oat|ort)\d*-/.test(text) || [...text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)]
  .some((m) => /openai|chatgpt|anthropic|claude/i.test(Buffer.from(m[1], "base64url").toString("utf8")));
const credential = (line, code = false) => CREDENTIAL.some((re, i) => (code && i === GENERIC ? CODE_GENERIC : re).test(line));
const NOTE = "[removed: not this client's data]";
const replacements = opt.replace.map((pair) => {
  const i = pair.indexOf("=");
  const [from, to] = [pair.slice(0, i), pair.slice(i + 1)];
  // Plain characters only, so a raw swap inside json text can never break an escape or a quote.
  if (i < 1 || from.length < 4 || !/^[\p{L}\p{N}._@:/ -]+$/u.test(from) || !/^[\p{L}\p{N}._@:/ -]*$/u.test(to)) {
    throw new Error(`--replace ${pair}: expected <old>=<new>, old at least 4 characters, letters/digits/._@:/- only`);
  }
  return [from, to];
});
const swap = (s) => replacements.reduce((acc, [from, to]) => acc.split(from).join(to), s);

// ── staging, never a half-scrubbed copy left behind ───────────────────
const stage = `${out}.partial-${process.pid}`;
let finished = false;
const cleanup = () => { if (!finished) rmSync(stage, { recursive: true, force: true }); };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });
mkdirSync(stage, { recursive: true });
const src = (p) => join(source, p), dst = (p) => join(stage, p);

// ── bot record, from an allow list ────────────────────────────────────
const allBots = JSON.parse(readFileSync(src("bots.json"), "utf8"));
const record = allBots.find((b) => b.id === botId);
if (!record) throw new Error(`bot ${botId} not found in ${source}`);
const BOT_KEEP = ["id", "name", "title", "description", "soul", "notifications", "color", "mascotExpression", "mascotBody", "mascotEyes",
  "avatarUrl", "avatarCrop", "workContinuity", "speakReplies", "voice", "parkDirectMessages",
  "pinned", "mcpServers", "playbooks", "installedPackage", "projects", "createdAt"];
const TASK_KEEP = ["threadId", "title", "createdAt", "lastUserMessageAt", "lastActivityAt", "titleFromFirstMessage", "projectId",
  "channelTransport", "archivedAt", "pinnedMessageId", "rewound", "appliedCompactionId", "contextFloor"];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const skip = new Set(opt["skip-thread"]);
const tasks = (record.tasks ?? []).filter((t) => t?.threadId);
const ownThreads = new Set([...tasks.map((t) => t.threadId), ...(record.threadId ? [record.threadId] : [])]);
for (const id of ownThreads) if (!ID.test(id)) throw new Error(`thread id ${JSON.stringify(id)} is not a plain id`);
for (const id of skip) if (!ownThreads.has(id)) throw new Error(`--skip-thread ${id} is not one of this bot's threads`);
const keptTasks = tasks.filter((t) => !skip.has(t.threadId));
const threads = new Set([...ownThreads].filter((id) => !skip.has(id)));
if (!threads.size) throw new Error("every thread was skipped");
const bot = {
  ...pick(record, BOT_KEEP),
  // Our instance names never ship; the dmg's setup gives the bot its engine.
  modelSelection: { instanceId: engine.instanceId, model: engine.model },
  threadId: threads.has(record.threadId) ? record.threadId : keptTasks[0].threadId,
  tasks: keptTasks.map((t) => ({ ...pick(t, TASK_KEEP), resumeCursors: {} })),
  computer: "off",
  unread: false,
  resumeCursors: {},
};
if (bot.projects) bot.projects = bot.projects.filter((p) => bot.tasks.some((t) => t.projectId === p.id));

// Ids that must never appear in what ships: other bots, their threads, rooms and everyone in them, our skipped threads.
const forbidden = new Set([
  ...allBots.filter((b) => b.id !== botId).flatMap((b) => [b.id, b.threadId, ...(b.tasks ?? []).map((t) => t.threadId)]),
  ...skip,
]);
if (existsSync(src("groups.json"))) {
  const groups = JSON.parse(readFileSync(src("groups.json"), "utf8"));
  for (const g of Array.isArray(groups) ? groups : Object.values(groups)) {
    if (!g || typeof g !== "object") continue;
    for (const id of [g.id, g.threadId, ...(g.tasks ?? []).map((t) => t?.threadId), ...(g.people ?? []).flatMap((p) => [p?.id, p?.homeId]),
      ...(g.memberBots ?? []).map((m) => (typeof m === "string" ? m : m?.id))]) forbidden.add(id);
  }
}
for (const id of [...forbidden]) if (typeof id !== "string" || id.length < 8 || id === botId || threads.has(id)) forbidden.delete(id);
const foreignId = (s) => { for (const id of forbidden) if (s.includes(id)) return true; return false; };

// Secret values held anywhere else on the server (our logins, hooks, other clients' tool keys) must not appear at all.
const SECRET_KEY = /key|token|secret|pass|auth|credential|cookie|session|private|bearer|dsn/i;
const ourSecrets = new Set();
// A plain url or path isn't a secret (a url with a login in it is).
// A plain url or path isn't a secret; one with a login or a long random segment (a webhook, a bot token) is.
const plain = (v) => /^(?:https?:\/\/[^@\s]*|[/~.][^\s]*)$/i.test(v)
  && !v.split(/[/?&=#:.]/).some((seg) => seg.length >= 16 && /\d/.test(seg) && /[A-Za-z]/.test(seg));
const pem = (v) => { for (const m of v.matchAll(/-----BEGIN [A-Z ]*-----[\s\S]+?-----END [A-Z ]*-----/g)) for (const l of m[0].split(/\r?\n/).slice(1, -1)) if (l.trim().length >= 40) ourSecrets.add(l.trim()); };
const add = (v, min = 16) => {
  pem(v);
  v = v.trim().replace(/^["']|["']$/g, "");
  if (v.length >= min && !/\s/.test(v) && !plain(v) && !/^[\d\s:.TZ+-]+$/.test(v)) ourSecrets.add(v);
};
// keyed: under a secret-sounding key or env. all: every value (a credential file). Otherwise only token-shaped values (mcp args).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collect = (value, mode) => {
  if (typeof value === "string") {
    const shaped = mode === "shape" && /^[A-Za-z0-9_\-.+=]{16,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && !UUID.test(value);
    if (mode === "all" || mode === "keyed" || shaped) add(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) collect(v, mode === "all" || mode === "keyed" || SECRET_KEY.test(k) || k === "env" ? (mode === "all" ? "all" : "keyed") : mode);
};
// KEY=value lines: a quoted value is taken whole, an unquoted one up to an inline comment; a secret-named key counts from 10 characters.
const envValues = (text) => {
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    const q = /^(["'])(.*)\1/.exec(m[2].trim());
    add(q ? q[2] : m[2].replace(/\s+#.*$/, ""), SECRET_KEY.test(m[1]) ? 10 : 16);
  }
};
// A file of ours: json values (every one, or keyed for a mixed file like a pm2 dump), else KEY=value lines, else the whole token.
// Our own inputs, so links are followed (a .env symlinked to a shared one, a linked config dir).
const harvest = (file, mode, depth = 0) => {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st || depth > 8) return;
  if (st.isDirectory()) { for (const n of readdirSync(file)) harvest(join(file, n), mode, depth + 1); return; }
  if (!st.isFile() || st.size > 8 * 1024 * 1024) return;
  const text = readFileSync(file, "utf8");
  let data;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (data !== undefined) return collect(data, mode);
  envValues(text);
  if (!text.trim().includes("\n")) add(text);
  pem(text);
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
for (const name of readdirSync(source)) {
  if (!name.endsWith(".json") || name === "bots.json" || name === "groups.json") continue;
  const data = readJson(src(name));
  // The client's own tool servers are configured on our server too; their keys are hers and ship in tools/secrets.
  if (name === "config.json" && data?.mcpServers) {
    for (const own of record.mcpServers ?? []) delete data.mcpServers[own];
    collect(data.mcpServers, "shape");
  }
  collect(data, "none");
}
for (const dir of ["hook-tokens", "providers"]) if (existsSync(src(dir))) harvest(src(dir), "all");
for (const other of existsSync(src("workspaces")) ? readdirSync(src("workspaces")) : []) {
  if (other !== botId) harvest(src(`workspaces/${other}/tools/secrets`), "all");
}
// Our logins outside the data dir: --server-secrets for credential files (every value), --server-env for mixed ones (.env, pm2 dump).
for (const p of opt["server-secrets"]) { if (!existsSync(p)) throw new Error(`--server-secrets ${p} not found`); harvest(p, "all"); }
for (const p of opt["server-env"]) { if (!existsSync(p)) throw new Error(`--server-env ${p} not found`); harvest(p, "keyed"); }
for (const [k, v] of Object.entries(process.env)) if (SECRET_KEY.test(k) && v) add(v);
for (const id of [botId, ...ownThreads]) ourSecrets.delete(id);
const ourSecret = (s) => { for (const v of ourSecrets) if (s.includes(v)) return true; return false; };

// ── files from the bot's own folders, regular files only ─────────────
const links = [];
const copyTree = (from, to) => {
  const st = lstatSync(from, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) { links.push(relative(source, from)); return; }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else if (st.isFile()) {
    copyFileSync(from, to);
  } else {
    links.push(`${relative(source, from)} (not a regular file)`);
  }
};
for (const p of [`workspaces/${botId}`, `bots/${botId}`, `skill-state/${botId}`, ...[...threads].map((id) => `task-workspaces/${botId}/${id}`)]) copyTree(src(p), dst(p));
if (links.length) throw new Error(`symlinks or special files in the bot's folders; resolve them on the server first:\n${links.join("\n")}`);
// The old server-side tool build and secrets are replaced by the Mac build; profile history holds old souls.
rmSync(dst(`workspaces/${botId}/tools`), { recursive: true, force: true });
rmSync(dst(`bots/${botId}/history.ndjson`), { force: true });

let redacted = 0;
const clean = (text) => text.split("\n").map((l) => (offending(l) ? (redacted++, NOTE) : l)).join("\n");
bot.soul = clean(swap(bot.soul ?? ""));
bot.soulHash = createHash("sha256").update(bot.soul, "utf8").digest("hex");
mkdirSync(dst(`bots/${botId}`), { recursive: true });
writeFileSync(dst(`bots/${botId}/SOUL.md`), bot.soul);
writeFileSync(dst("bots.json"), JSON.stringify([bot], null, 2) + "\n");
const cfg = JSON.parse(readFileSync(src("config.json"), "utf8"));
const onboarding = cfg.onboarding ? pick(cfg.onboarding, ["completedAt", "version", "hintsSeen"]) : undefined;
const features = pick(cfg.features ?? {}, ["showToolCalls"]);
writeFileSync(dst("config.json"), JSON.stringify({ features, ...(onboarding ? { onboarding } : {}), profile: { name: label } }, null, 2) + "\n");

// ── messages: a fresh database holding only this bot's rows ──────────
const live = new DatabaseSync(src("messages.db"), { readOnly: true });
const db = new DatabaseSync(dst("messages.db"));
db.exec("PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE");
const schema = live.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
const virtual = schema.filter((s) => /^CREATE VIRTUAL TABLE/i.test(s.sql)).map((s) => s.name);
const shadow = (name) => virtual.some((v) => name.startsWith(`${v}_`));
for (const type of ["table", "index", "trigger"]) {
  for (const s of schema) if (s.type === type && !(type === "table" && shadow(s.name))) db.exec(s.sql);
}
const keep = JSON.stringify([...threads]);
const copyRows = (table, mutate) => {
  const cols = live.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const insert = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  let n = 0;
  for (const row of live.prepare(`SELECT * FROM "${table}" WHERE thread_id IN (SELECT value FROM json_each(?))`).iterate(keep)) {
    const next = mutate ? mutate(row) : row;
    insert.run(...cols.map((c) => next[c]));
    n++;
  }
  return n;
};
db.exec("BEGIN");
// Followups, queue pauses and command receipts are the server's pending work; the memory index rebuilds from disk.
const messageCount = copyRows("messages", (row) => {
  const json = swap(row.json);
  JSON.parse(json);
  return { ...row, text: row.text == null ? row.text : swap(row.text), json };
});
copyRows("thread_state");
db.exec("COMMIT");

// ── attachments a kept message names and nobody else's thread does ────
const ATTACHMENT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}\b/gi;
const named = new Set();
for (const r of db.prepare("SELECT coalesce(text,'') || char(10) || json AS t FROM messages").iterate()) for (const m of r.t.matchAll(ATTACHMENT)) named.add(m[0]);
const avatar = /([0-9a-f-]{36}\.[a-z0-9]{1,10})/i.exec(bot.avatarUrl ?? "");
if (avatar) named.add(avatar[1]);
db.close();
const elsewhere = live.prepare("SELECT thread_id FROM messages WHERE thread_id NOT IN (SELECT value FROM json_each(?)) AND (instr(json, ?) OR instr(coalesce(text,''), ?)) LIMIT 1");
const own = JSON.stringify([...ownThreads]);
// Named outside messages too: another bot's avatar, a room, a pending followup.
const elsewhereText = JSON.stringify(allBots.filter((b) => b.id !== botId)) + (existsSync(src("groups.json")) ? readFileSync(src("groups.json"), "utf8") : "");
const followups = live.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'chat_followups'").get().n
  ? live.prepare("SELECT 1 FROM chat_followups WHERE instr(coalesce(payload,''), ?) LIMIT 1") : null;
const hits = [];
let attachments = 0;
for (const name of named) {
  if (!lstatSync(src(`attachments/${name}`), { throwIfNoEntry: false })?.isFile()) continue;
  const other = elsewhere.get(own, name, name);
  if (other) { hits.push(`attachment ${name}: also in thread ${other.thread_id}, not this bot's`); continue; }
  if (elsewhereText.includes(name) || followups?.get(name)) { hits.push(`attachment ${name}: also used by another bot, a room or a followup`); continue; }
  mkdirSync(dst("attachments"), { recursive: true });
  copyFileSync(src(`attachments/${name}`), dst(`attachments/${name}`));
  attachments++;
}
live.close();

// ── redact markdown, apply replacements, build tools ──────────────────
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? [p, ...walk(p)] : [p];
});
for (const file of walk(stage)) {
  if (!/\.(md|txt)$/i.test(file) || file === dst(`bots/${botId}/SOUL.md`) || !lstatSync(file).isFile()) continue;
  const body = readFileSync(file, "utf8");
  const next = /\.md$/i.test(file) ? clean(swap(body)) : swap(body);
  if (next !== body) writeFileSync(file, next);
}

const toolsDir = dst(`workspaces/${botId}/tools`);
if (opt.tools) execFileSync(process.execPath, [opt.tools, toolsDir], { stdio: ["ignore", "inherit", "inherit"] });
const mcp = Object.fromEntries(opt.mcp.map((pair) => {
  const [name, entry] = pair.split("=");
  if (!name || !entry || entry.includes("..") || entry.startsWith("/")) throw new Error(`--mcp ${pair}: expected <name>=<entry.mjs>`);
  if (!lstatSync(join(toolsDir, entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`--mcp ${name}: ${entry} was not built into tools/`);
  return [name, { command: "{{NODE}}", args: [`{{DATA_DIR}}/workspaces/${botId}/tools/${entry}`], env: {}, enabled: true }];
}));
const missing = (bot.mcpServers ?? []).filter((name) => !mcp[name]);
if (missing.length) throw new Error(`the bot uses ${missing.join(", ")} but no Mac build was given (--tools + --mcp)`);
// Json the bot reads (its tool build's knowledge, its own notes) gets the same line redaction as markdown.
const cleanValue = (v) => (typeof v === "string" ? clean(swap(v)) : Array.isArray(v) ? v.map(cleanValue)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanValue(x)])) : v);
for (const file of walk(dst(`workspaces/${botId}`))) {
  const rel = relative(stage, file);
  if (!/\.json$/i.test(rel) || rel.startsWith(`workspaces/${botId}/tools/secrets/`) || !lstatSync(file).isFile()) continue;
  const body = readFileSync(file, "utf8");
  let value;
  try { value = JSON.parse(body); } catch { continue; }
  const next = cleanValue(value);
  if (JSON.stringify(next) !== JSON.stringify(value)) writeFileSync(file, JSON.stringify(next));
}
// The tool build ran with our permissions: anything it left that isn't a plain file or folder is refused.
const odd = walk(stage).filter((p) => { const st = lstatSync(p); return !st.isFile() && !st.isDirectory(); });
if (odd.length) throw new Error(`symlinks or special files in the export:\n${odd.map((p) => relative(stage, p)).join("\n")}`);

// ── scan everything that ships ────────────────────────────────────────
const scanText = (where, body, { words = true, keys = true, code = false } = {}) => {
  for (const text of variants(body)) {
    if (ourSecret(text)) return hits.push(`${where}: holds a secret from elsewhere on the server`);
    for (const raw of text.split("\n")) {
      const line = fold(raw);
      const term = words ? offending(line) : null;
      if (term) return hits.push(`${where}: other-client text ("${term}")`);
      if (foreignId(line)) return hits.push(`${where}: another bot's, thread's or room's id`);
      if (keys && credential(line, code)) return hits.push(`${where}: looks like a credential`);
    }
  }
};
// Json is checked decoded, string by string, so escapes (\n, e) can't hide a word, a key or an id.
// A string that is itself json (a tool result) is decoded again.
const scanValue = (where, value, opts, depth = 0) => {
  if (typeof value === "string") {
    scanText(where, value, opts);
    if (depth < 8 && /^\s*[[{]/.test(value)) { try { scanValue(where, JSON.parse(value), opts, depth + 1); } catch { /* not json */ } }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(value)) scanValue(where, v, opts, depth);
    else if (v === null || typeof v !== "object") { scanText(where, `${k}: ${v}`, opts); if (typeof v === "string") scanValue(where, v, opts, depth); }
    else { scanText(where, k, opts); scanValue(where, v, opts, depth); }
  }
};
const scanJsonish = (where, text, opts) => {
  scanText(where, text, opts);
  const parse = (s) => { try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };
  const whole = parse(text);
  if (whole.ok) return scanValue(where, whole.v, opts);
  for (const line of text.split("\n")) { const p = parse(line); if (p.ok) scanValue(where, p.v, opts); }
};
const SNIFF = [
  [/\.png$/i, (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  [/\.jpe?g$/i, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [/\.gif$/i, (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  [/\.webp$/i, (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  [/\.(wav)$/i, (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE"],
  [/\.(heic|heif|mp4|mov|m4v|m4a|aac)$/i, (b) => b.subarray(4, 8).toString("latin1") === "ftyp" || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0)],
  [/\.mp3$/i, (b) => b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  [/\.(ogg|oga|opus)$/i, (b) => b.subarray(0, 4).toString("latin1") === "OggS"],
  [/\.webm$/i, (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))],
  [/\.flac$/i, (b) => b.subarray(0, 4).toString("latin1") === "fLaC"],
  [/\.caf$/i, (b) => b.subarray(0, 4).toString("latin1") === "caff"],
  [/\.bmp$/i, (b) => b.subarray(0, 2).toString("latin1") === "BM"],
  [/\.ico$/i, (b) => b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))],
  [/\.tiff?$/i, (b) => ["II*\0", "MM\0*"].includes(b.subarray(0, 4).toString("latin1"))],
];
const isMedia = (rel, buf) => SNIFF.some(([ext, ok]) => ext.test(rel) && ok(buf));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const allowBinary = new Set(opt["allow-binary"]);
const secretsDir = `workspaces/${botId}/tools/secrets/`;
const bundles = new Set(opt.mcp.map((pair) => `workspaces/${botId}/tools/${pair.split("=")[1]}`));
const media = [], secrets = [];
let total = 0;
for (const file of walk(stage)) {
  const rel = relative(stage, file);
  scanText(`path ${rel}`, rel, { keys: false });
  const st = lstatSync(file);
  if (st.isDirectory()) continue;
  total += st.size;
  if (st.size > 256 * 1024 * 1024) { hits.push(`${rel}: over 256 MB, check it by hand`); continue; }
  if (rel === "messages.db") continue;
  const buf = readFileSync(file);
  let text = null;
  try { text = utf8.decode(buf); } catch { /* not utf-8 */ }
  if (rel.startsWith(secretsDir)) {
    // The client's own keys: listed for sign-off, checked for other clients' words, ids and our secrets.
    const whole = text ?? buf.toString("latin1");
    if (variants(whole).some(ourSecret)) hits.push(`${rel}: holds a secret from elsewhere on the server`);
    if (ourToken(whole)) hits.push(`${rel}: holds one of our own logins (a claude or chatgpt account token)`);
    scanText(rel, secretLiterals.reduce((acc, l) => acc.split(l).join(" "), whole), { keys: false });
    const keys = (text ?? "").split("\n").map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean);
    secrets.push(`${rel.slice(secretsDir.length)}${keys.length ? ` (${keys.join(", ")})` : ""}`);
    continue;
  }
  if (text === null) {
    if (isMedia(rel, buf)) media.push(rel);
    else if (!allowBinary.has(rel)) { hits.push(`${rel}: binary file that isn't plain media; open it, then pass --allow-binary ${rel}`); continue; }
    // Metadata (png text chunks, exif, xmp) sits in the clear: ids and secrets anywhere, words in readable runs.
    const bytes = buf.toString("latin1");
    if (foreignId(bytes)) hits.push(`${rel}: another bot's, thread's or room's id inside the file`);
    if (ourSecret(bytes)) hits.push(`${rel}: holds a secret from elsewhere on the server`);
    // Runs of valid utf-8 (xmp, png itxt; latin1 would fold random bytes into letters), latin runs from utf-16 (exif XP fields),
    // and short NUL-separated fields (a png tEXt author).
    const readable = [...(new TextDecoder().decode(buf).match(/[^\uFFFD\p{Cc}\p{Cs}\p{Co}\p{Cn}]{8,}/gu) ?? []),
      ...(buf.toString("utf16le").match(/[\x20-\x7e\u00c0-\u024f]{8,}/g) ?? []),
      ...[...bytes.matchAll(/\0([\x20-\x7e]{3,7})(?=\0)/g)].map((m) => m[1])].join("\n");
    scanText(`${rel} (embedded text)`, readable, { keys: false });
    continue;
  }
  // The built tool entry is the client's own code: a key name followed by a variable is normal there.
  const opts = { code: bundles.has(rel) };
  if (/\.(json|jsonl|ndjson)$/i.test(rel)) scanJsonish(rel, text, opts); else scanText(rel, text, opts);
}
if (total > 4 * 1024 * 1024 * 1024) hits.push(`export is ${Math.round(total / 1024 ** 3)} GB, over the 4 GB cap`);
const check = new DatabaseSync(dst("messages.db"), { readOnly: true });
for (const r of check.prepare("SELECT thread_id, id, text, json FROM messages").iterate()) {
  const where = `messages.db ${r.thread_id}/${r.id}`;
  if (r.text) scanText(where, r.text);
  scanJsonish(where, r.json);
}
if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") hits.push("messages.db: integrity check failed");
check.close();
// Belt and braces: the raw file, including free pages and index segments.
const raw = fold(readFileSync(dst("messages.db")).toString("utf8"));
if (OTHER.test(raw.replace(RULE, " "))) hits.push("messages.db raw bytes: other-client text");
if (foreignId(raw)) hits.push("messages.db raw bytes: another bot's, thread's or room's id");
if (ourSecret(raw)) hits.push("messages.db raw bytes: a secret from elsewhere on the server");
if (hits.length) {
  console.error(hits.slice(0, 50).join("\n"));
  throw new Error(`${hits.length} item(s) failed the data wall; fix them on the server (or redact) and export again`);
}

// ── publish, then the setup document ──────────────────────────────────
const setup = {
  version: 1,
  features: engine.features,
  instances: { [engine.instanceId]: engine.instance },
  ...(Object.keys(mcp).length ? { mcpServers: mcp } : {}),
  bots: { [botId]: { cwd: `{{DATA_DIR}}/workspaces/${botId}`, modelSelection: { instanceId: engine.instanceId, model: engine.model } } },
};
const lock = (dir) => {
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) lock(join(dir, e.name));
    else if (e.isFile()) chmodSync(join(dir, e.name), 0o600);
  }
};
lock(stage);
if (existsSync(out)) throw new Error(`${out} appeared while exporting`);
renameSync(stage, out);
finished = true;
const setupFile = join(dirname(out), `${basename(out)}.setup.json`);
writeFileSync(setupFile, JSON.stringify(setup, null, 2) + "\n", { mode: 0o600 });

console.log(JSON.stringify({ out, setup: setupFile, slug, bot: bot.name, threads: threads.size, messages: messageCount, attachments, media, linesRedacted: redacted, serverSecretsChecked: ourSecrets.size, mcp: Object.keys(mcp), secrets }));
