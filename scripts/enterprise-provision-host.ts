// Enterprise provision host: the server half of first-launch provisioning
// (electron/enterprise-provision.mjs is the desktop half).
//
// It holds, per client, one encrypted workspace archive plus its setup
// document behind a one-time bearer token, and one-time download links for
// the client's signed dmgs. Tokens are stored as sha256 only, expire after
// --hours (default 48), and burn on use: /done for the provision token, the
// first completed dmg download for a link. A burned provision deletes its
// archive from disk.
//
//   pack  <state> <slug> --data <dir> --setup <file> --label <text> --public <https://host> --out <provision.json>
//   link  <state> <slug> --file arm64=<dmg> --file x64=<dmg>   (prints the download url)
//   serve <state> --port <n>
//   status <state>
//
// Runs on node 24 as one esbuild bundle: bin/enterprise-provision-host-bundle.sh.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { createWorkspaceBackup } from "../server/workspace-backup.ts";
import { enterpriseSetupSchema } from "../server/enterprise-provision.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ARCH = /^(arm64|x64)$/;
const HEX = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HOUR = 3_600_000;

interface Provision { id: string; tokenHash: string; expiresAt: number; createdAt: number; sha256: string; bytes: number; burnedAt?: number; receipt?: unknown }
interface Download { tokenHash: string; expiresAt: number; createdAt: number; files: Record<string, string>; burnedAt?: number; fetches: number }
interface Client { slug: string; label: string; publicUrl: string; provision?: Provision; downloads: Download[] }

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
const clientDir = (state: string, slug: string) => {
  if (!SLUG.test(slug)) throw new Error(`invalid slug: ${slug}`);
  return join(state, "clients", slug);
};
function readClient(state: string, slug: string): Client | null {
  try { return JSON.parse(readFileSync(join(clientDir(state, slug), "client.json"), "utf8")) as Client; } catch { return null; }
}
const saveClient = (state: string, client: Client) => writeJson(join(clientDir(state, client.slug), "client.json"), client);

function args(list: string[]) {
  const named: Record<string, string[]> = {}; const positional: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i]!;
    if (item.startsWith("--")) { (named[item.slice(2)] ??= []).push(list[++i] ?? ""); } else positional.push(item);
  }
  const one = (key: string, fallback?: string) => {
    const value = named[key]?.at(-1) ?? fallback;
    if (value === undefined || value === "") throw new Error(`--${key} is required`);
    return value;
  };
  return { named, positional, one };
}

async function pack(state: string, slug: string, a: ReturnType<typeof args>) {
  const dir = clientDir(state, slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const publicUrl = a.one("public").replace(/\/+$/, "");
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username) throw new Error("--public must be a bare https origin");
  const label = a.one("label").trim().slice(0, 80);
  const setup = enterpriseSetupSchema.parse(JSON.parse(readFileSync(a.one("setup"), "utf8")));
  const hours = Number(a.one("hours", "48"));
  if (!(hours > 0 && hours <= 24 * 14)) throw new Error("--hours must be between 0 and 336");
  const password = randomBytes(24).toString("base64url");
  const backup = await createWorkspaceBackup(resolve(a.one("data")), { password, appVersion: a.one("app-version", "enterprise") });
  const id = randomBytes(16).toString("hex");
  const archive = join(dir, `${id}.ombbackup`);
  renameSync(backup.path, archive);
  rmSync(resolve(backup.path, ".."), { recursive: true, force: true });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
  writeJson(join(dir, `${id}.setup.json`), setup);
  const previous = readClient(state, slug);
  // A new pack replaces the old one outright: its token stops working and its archive is deleted.
  if (previous?.provision) for (const name of [`${previous.provision.id}.ombbackup`, `${previous.provision.id}.setup.json`]) rmSync(join(dir, name), { force: true });
  const secret = token();
  const now = Date.now();
  const client: Client = {
    slug, label, publicUrl, downloads: previous?.downloads ?? [],
    provision: { id, tokenHash: sha(secret), createdAt: now, expiresAt: now + hours * HOUR, sha256: hash.digest("hex"), bytes: statSync(archive).size },
  };
  saveClient(state, client);
  writeJson(a.one("out"), { version: 1, slug, label, url: `${publicUrl}/v1/${id}`, token: secret, password });
  console.log(JSON.stringify({ slug, id, expiresAt: new Date(client.provision!.expiresAt).toISOString(), bytes: client.provision!.bytes, summary: backup.summary }, null, 2));
}

function link(state: string, slug: string, a: ReturnType<typeof args>) {
  const client = readClient(state, slug);
  if (!client) throw new Error(`no client ${slug}; pack it first`);
  const dir = clientDir(state, slug);
  const files: Record<string, string> = {};
  for (const spec of a.named.file ?? []) {
    const [arch, path] = [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)];
    if (!ARCH.test(arch) || !path || !existsSync(path)) throw new Error(`bad --file ${spec}`);
    const name = basename(path);
    if (!/^[\w.() -]+\.dmg$/.test(name)) throw new Error(`not a dmg: ${name}`);
    mkdirSync(join(dir, "dmg"), { recursive: true, mode: 0o700 });
    copyFileSync(path, join(dir, "dmg", name));
    files[arch] = name;
  }
  if (!Object.keys(files).length) throw new Error("at least one --file arch=<dmg> is required");
  const hours = Number(a.one("hours", "48"));
  const secret = token();
  const now = Date.now();
  client.downloads = client.downloads.filter((d) => !d.burnedAt && d.expiresAt > now);
  client.downloads.push({ tokenHash: sha(secret), createdAt: now, expiresAt: now + hours * HOUR, files, fetches: 0 });
  saveClient(state, client);
  console.log(`${client.publicUrl}/d/${secret}`);
}

function clients(state: string): Client[] {
  const root = join(state, "clients");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => SLUG.test(name)).map((slug) => readClient(state, slug)).filter((c): c is Client => Boolean(c));
}

function status(state: string) {
  const now = Date.now();
  for (const c of clients(state)) {
    const p = c.provision;
    console.log(`${c.slug} provision ${p ? `${p.id} ${p.burnedAt ? `burned ${new Date(p.burnedAt).toISOString()}` : p.expiresAt < now ? "expired" : `live until ${new Date(p.expiresAt).toISOString()}`}` : "none"}`);
    for (const d of c.downloads) console.log(`  link ${d.tokenHash.slice(0, 8)} ${d.burnedAt ? "burned" : d.expiresAt < now ? "expired" : "live"} fetches=${d.fetches} ${Object.keys(d.files).join(",")}`);
  }
}

function page(res: ServerResponse, code: number, title: string, body: string) {
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex><title>${title}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;color:#1d1d1f}h1{font-size:24px}a.b{display:block;margin:12px 0;padding:14px 18px;border-radius:12px;background:#1d1d1f;color:#fff;text-decoration:none;text-align:center}small{color:#6e6e73}</style>
<h1>${title}</h1>${body}`;
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" });
  res.end(html);
}
const json = (res: ServerResponse, code: number, value: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function body(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += (chunk as Buffer).length; if (bytes > limit) throw new Error("too large"); chunks.push(chunk as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function serve(state: string, port: number, host: string) {
  const findProvision = (id: string) => clients(state).find((c) => c.provision?.id === id);
  const findDownload = (secret: string) => {
    const hash = sha(secret);
    for (const c of clients(state)) { const d = c.downloads.find((x) => sameHash(x.tokenHash, hash)); if (d) return { client: c, download: d }; }
    return null;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean);
    const now = Date.now();
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (parts[0] === "v1" && parts.length === 3 && HEX.test(parts[1]!)) {
        const client = findProvision(parts[1]!);
        if (!client?.provision) return json(res, 404, { error: "not found" });
        const p = client.provision;
        const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        if (!TOKEN.test(bearer) || !sameHash(sha(bearer), p.tokenHash)) return json(res, 401, { error: "invalid token" });
        if (p.burnedAt || p.expiresAt < now) return json(res, 410, { error: "this setup link has already been used or expired" });
        const dir = clientDir(state, client.slug);
        if (req.method === "GET" && parts[2] === "archive") {
          const file = join(dir, `${p.id}.ombbackup`);
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(statSync(file).size), "x-bos-sha256": p.sha256, "cache-control": "no-store" });
          createReadStream(file).pipe(res);
          return;
        }
        if (req.method === "GET" && parts[2] === "setup") return json(res, 200, JSON.parse(readFileSync(join(dir, `${p.id}.setup.json`), "utf8")));
        if (req.method === "POST" && parts[2] === "done") {
          const value = await body(req).catch(() => null) as { receipt?: unknown } | null;
          const fresh = readClient(state, client.slug)!;
          if (fresh.provision?.id !== p.id || fresh.provision.burnedAt) return json(res, 410, { error: "already done" });
          fresh.provision.burnedAt = Date.now();
          fresh.provision.receipt = value?.receipt ?? null;
          saveClient(state, fresh);
          for (const name of [`${p.id}.ombbackup`, `${p.id}.setup.json`]) rmSync(join(dir, name), { force: true });
          console.log(`${new Date().toISOString()} ${client.slug} provision ${p.id} burned`);
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      if (parts[0] === "d" && (parts.length === 2 || parts.length === 3) && TOKEN.test(parts[1]!) && req.method === "GET") {
        const found = findDownload(parts[1]!);
        if (!found) return page(res, 404, "Link not found", "<p>Check the link you were sent.</p>");
        const { client, download } = found;
        if (download.burnedAt || download.expiresAt < now) return page(res, 410, "This link has expired", "<p>Each download link works once. Ask for a new one.</p>");
        const label = escape(client.label);
        if (parts.length === 2) {
          const names: Record<string, string> = { arm64: "Apple silicon (M1, M2, M3, M4…)", x64: "Intel Mac" };
          const buttons = Object.keys(download.files).sort().map((arch) => `<a class=b href="/d/${parts[1]}/${arch}">Download for ${names[arch]}</a>`).join("");
          return page(res, 200, `BOS for ${label}`, `<p>Download, open the dmg and drag BOS to Applications. Your team is set up the first time you open it.</p>${buttons}<p><small>Not sure which Mac you have? Apple menu → About This Mac → Chip. This link works for one download.</small></p>`);
        }
        const arch = parts[2]!;
        const name = ARCH.test(arch) ? download.files[arch] : undefined;
        if (!name) return page(res, 404, "Not found", "<p>That download isn't in this link.</p>");
        const file = join(clientDir(state, client.slug), "dmg", name);
        const size = statSync(file).size;
        res.writeHead(200, { "content-type": "application/x-apple-diskimage", "content-length": String(size), "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
        const stream = createReadStream(file);
        stream.pipe(res);
        res.on("finish", () => {
          // Only a fully delivered dmg burns the link; a cancelled download leaves it usable.
          const fresh = readClient(state, client.slug)!;
          const d = fresh.downloads.find((x) => x.tokenHash === download.tokenHash);
          if (!d) return;
          d.fetches++;
          d.burnedAt ??= Date.now();
          saveClient(state, fresh);
          console.log(`${new Date().toISOString()} ${client.slug} link ${d.tokenHash.slice(0, 8)} ${arch} delivered, burned`);
        });
        return;
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "internal error" }); else res.destroy();
    }
  });
  server.listen(port, host, () => console.log(`enterprise provision host on ${host}:${port}, state ${state}`));
}

const [command, state, ...rest] = process.argv.slice(2);
if (!command || !state) {
  console.error("usage: enterprise-provision-host pack|link|serve|status <state> …");
  process.exit(2);
}
mkdirSync(state, { recursive: true, mode: 0o700 });
const a = args(rest);
try {
  if (command === "pack") await pack(state, a.positional[0] ?? "", a);
  else if (command === "link") link(state, a.positional[0] ?? "", a);
  else if (command === "serve") serve(state, Number(a.one("port")), a.one("host", "127.0.0.1"));
  else if (command === "status") status(state);
  else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(`enterprise-provision-host: ${(error as Error).message}`);
  process.exit(1);
}
