import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { sameSecret, terminalTransportAllowed } from "./terminal.ts";

const PREFIX = "/api/workspace-files/";
const ID = /^[\w-]{1,128}$/;
const MAX_LIST = 2000, MAX_WALK = 20_000, WALK_MS = 2000, MAX_READ = 256 * 1024;
const MAX_RAW = 64 * 1024 * 1024, MAX_DIFF = 2 * 1024 * 1024, MAX_UNTRACKED = 200, MAX_UNTRACKED_READ = 64 * 1024;
const GIT_MS = 5000;
/** Only media the viewer renders inline is served raw, each with its real type. */
const RAW_TYPES: Record<string, string> = {
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".avif":"image/avif",
  ".bmp":"image/bmp", ".ico":"image/x-icon", ".svg":"image/svg+xml", ".pdf":"application/pdf",
};
const SKIP = new Set([".git","node_modules",".next","dist","build",".venv","venv","__pycache__",".cache","target","coverage",".turbo","Pods","DerivedData"]);
type Options = {
  ownerToken: () => string | undefined;
  authenticate: (req: IncomingMessage) => boolean;
  resolveRoot: (botId: string, threadId: string) => string;
};
export type WorkspaceEntry = {name: string; path: string; kind: "dir" | "file"; size?: number; mtime?: number};
export type WorkspaceChange = {path: string; status: "modified" | "added" | "deleted" | "untracked" | "changed"};
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {"content-type":"application/json", "cache-control":"no-store"}); res.end(JSON.stringify(body));
}
const inside = (root: string, real: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
function fsStatus(e: unknown): number {
  const code = (e as {code?: string}).code;
  return code === "ENOENT" || code === "ENOTDIR" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : 500;
}
/** Validate a relative posix path, then resolve it and refuse anything whose realpath leaves the root. */
async function resolveInside(root: string, rel: string): Promise<{real: string; rel: string}> {
  if (rel.includes("\0") || rel.startsWith("/") || /^[a-z]:/i.test(rel) || rel.split(/[\\/]/).includes("..")) fail(400, "Invalid path");
  const clean = rel.split("/").filter(s => s && s !== ".").join("/");
  let real: string;
  try {real = await realpath(clean ? join(root, ...clean.split("/")) : root);} catch (e) {fail(fsStatus(e), fsStatus(e) === 404 ? "Not found" : "Path unavailable");}
  if (!inside(root, real)) fail(403, "Path escapes the working folder");
  return {real, rel: clean};
}
const byName = (a: string, b: string) => {const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;};

/** Greedy case-insensitive subsequence score; null when q is not a subsequence of text. */
function fuzzy(text: string, q: string): number | null {
  let score = 0, last = -2;
  for (let i = 0, j = 0; j < q.length; i++) {
    if (i >= text.length) return null;
    if (text[i] !== q[j]) continue;
    score += 1 + (i === last + 1 ? 5 : 0) + (i === 0 || "/_-. ".includes(text[i - 1]) ? 3 : 0);
    last = i; j++;
  }
  return score;
}
const depth = (p: string) => p.split("/").length;
/** Rank relative posix paths: basename matches first, then contiguous runs, then shorter paths. */
export function rankFilePaths(paths: string[], query: string, limit: number): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...paths].sort((a, b) => depth(a) - depth(b) || a.length - b.length || byName(a, b)).slice(0, limit);
  const scored: {p: string; s: number}[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase(), base = lower.slice(lower.lastIndexOf("/") + 1);
    const b = fuzzy(base, q);
    let s: number;
    if (b !== null) s = 1000 + b * 10 + (base.startsWith(q) ? 300 : base.includes(q) ? 200 : 0);
    else {const f = fuzzy(lower, q); if (f === null) continue; s = f * 10 + (lower.includes(q) ? 150 : 0);}
    scored.push({p, s: s - p.length - depth(p) * 5});
  }
  return scored.sort((a, b) => b.s - a.s || a.p.length - b.p.length || byName(a.p, b.p)).slice(0, limit).map(x => x.p);
}

/** Read-only browsing of a thread's working folder for the local desktop owner. */
export class WorkspaceFilesService {
  private options: Options;
  constructor(options: Options) {this.options = options;}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url?.startsWith(PREFIX)) return false;
    try {
      if (!terminalTransportAllowed(req) || !this.options.authenticate(req) ||
          !sameSecret(req.headers["x-openmausbot-desktop-owner"], this.options.ownerToken())) fail(403, "Local desktop owner required");
      if (req.url.length > 8192) fail(413, "Request too large");
      const url = new URL(req.url, "http://localhost");
      const action = url.pathname.slice(PREFIX.length);
      if (action === "revert") {
        if (req.method !== "POST") fail(405, "POST only");
        await this.revert(req);
        json(res, 200, {ok: true});
        return true;
      }
      if (req.method !== "GET") fail(405, "GET only");
      const botId = url.searchParams.get("botId") ?? "", threadId = url.searchParams.get("threadId") ?? "";
      if (!ID.test(botId) || !ID.test(threadId)) fail(400, "Send botId and threadId");
      if (!["list","search","read","stat","raw","locate","changes"].includes(action)) fail(404, "Unknown workspace files route");
      const root = this.options.resolveRoot(botId, threadId);
      const path = url.searchParams.get("path") ?? "";
      if (action === "stat") json(res, 200, await this.stat(root, path));
      else if (action === "locate") json(res, 200, await this.locate(root, path));
      else if (action === "raw") await this.raw(root, path, res);
      else if (action === "changes") json(res, 200, await this.changes(root));
      else if (action === "list") json(res, 200, {root, ...await this.list(root, path)});
      else if (action === "search") {
        const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 50));
        const q = url.searchParams.get("q") ?? "";
        if (q.length > 256) fail(400, "Query too long");
        const {files, truncated} = await this.walk(root);
        json(res, 200, {root, files: rankFilePaths(files, q, limit), truncated});
      } else json(res, 200, await this.read(root, path));
    } catch (e) {
      const status = (e as {status?: number}).status ?? 500;
      if (res.headersSent) {res.destroy(); return true;}
      json(res, status, {error: status === 500 ? "Workspace files unavailable" : e instanceof Error ? e.message : "Workspace files unavailable"});
    }
    return true;
  }
  private async list(root: string, path: string) {
    const {real, rel} = await resolveInside(root, path);
    if (!(await stat(real)).isDirectory()) fail(409, "Not a folder");
    let names;
    try {names = await readdir(real, {withFileTypes:true});} catch (e) {fail(fsStatus(e), "Folder unavailable");}
    const entries: WorkspaceEntry[] = [];
    for (const d of names) {
      if (d.name === ".git") continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name, full = join(real, d.name);
      try {
        let target = full;
        if (d.isSymbolicLink()) {target = await realpath(full); if (!inside(root, target)) continue;}
        else if (!d.isDirectory() && !d.isFile()) continue;
        const st = await stat(target);
        if (st.isDirectory()) entries.push({name:d.name, path:childRel, kind:"dir", mtime:st.mtimeMs});
        else if (st.isFile()) entries.push({name:d.name, path:childRel, kind:"file", size:st.size, mtime:st.mtimeMs});
      } catch {/* broken link or vanished entry */}
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || byName(a.name, b.name));
    return {path: rel, entries: entries.slice(0, MAX_LIST), truncated: entries.length > MAX_LIST};
  }
  private async walk(root: string): Promise<{files: string[]; truncated: boolean}> {
    const files: string[] = [], queue = [""], deadline = Date.now() + WALK_MS;
    for (let i = 0; i < queue.length; i++) {
      if (Date.now() > deadline) return {files, truncated:true};
      let names;
      try {names = await readdir(queue[i] ? join(root, ...queue[i].split("/")) : root, {withFileTypes:true});} catch {continue;}
      names.sort((a, b) => byName(a.name, b.name));
      for (const d of names) {
        const rel = queue[i] ? `${queue[i]}/${d.name}` : d.name;
        if (d.isDirectory()) {if (!SKIP.has(d.name)) queue.push(rel); continue;}
        if (d.isSymbolicLink()) {
          try {const t = await realpath(join(root, ...rel.split("/"))); if (!inside(root, t) || !(await stat(t)).isFile()) continue;} catch {continue;}
        } else if (!d.isFile()) continue;
        if (files.push(rel) >= MAX_WALK) return {files, truncated:true};
      }
    }
    return {files, truncated:false};
  }
  private async read(root: string, path: string) {
    const {real, rel} = await resolveInside(root, path);
    const st = await stat(real);
    if (!st.isFile()) fail(409, st.isDirectory() ? "Path is a folder" : "Not a regular file");
    const fh = await open(real, "r");
    try {
      const buf = Buffer.alloc(Math.min(MAX_READ, st.size));
      const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
      const data = buf.subarray(0, bytesRead), binary = data.includes(0);
      return {path: rel, size: st.size, mtime: st.mtimeMs, binary, truncated: st.size > bytesRead, content: binary ? "" : data.toString("utf8")};
    } finally {await fh.close();}
  }
  /** Cheap change check for an open file or folder: the viewer polls this. */
  private async stat(root: string, path: string) {
    const {real, rel} = await resolveInside(root, path);
    const st = await stat(real);
    return {path: rel, kind: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs};
  }
  /** Map a path the bot wrote in chat (absolute, or relative to the folder) to one inside the folder. */
  private async locate(root: string, path: string) {
    if (!path || path.length > 4096 || path.includes("\0")) fail(400, "Invalid path");
    let rel = path.replace(/^file:\/\//, "");
    if (isAbsolute(rel)) {
      let real: string;
      try {real = await realpath(rel);} catch (e) {fail(fsStatus(e), "Not found");}
      if (!inside(root, real)) fail(404, "Outside the working folder");
      rel = relative(root, real).split(sep).join("/");
    }
    const {real, rel: clean} = await resolveInside(root, rel.replace(/^\.\//, ""));
    const st = await stat(real);
    return {root, path: clean, kind: st.isDirectory() ? "dir" : "file"};
  }
  private async raw(root: string, path: string, res: ServerResponse) {
    const {real} = await resolveInside(root, path);
    const type = RAW_TYPES[extname(real).toLowerCase()];
    if (!type) fail(415, "Not a previewable file");
    const st = await stat(real);
    if (!st.isFile()) fail(409, "Not a regular file");
    if (st.size > MAX_RAW) fail(413, "File too large to preview");
    res.writeHead(200, {"content-type": type, "content-length": String(st.size), "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox"});
    await new Promise<void>((resolve, reject) => createReadStream(real).on("error", reject).on("end", resolve).pipe(res));
  }
  /** Uncommitted changes as one unified diff. {git:false} hides the tab for plain folders. */
  private async changes(root: string) {
    const repo = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (repo.code !== 0 || repo.out.trim() !== "true") return {git: false};
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
    const base = head ? ["HEAD"] : ["--cached"];
    const [names, diff, others] = await Promise.all([
      git(root, ["diff", ...base, "--name-status", "-z", "--no-renames", "--relative", "--", "."]),
      git(root, ["diff", ...base, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--", "."], MAX_DIFF),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
    ]);
    if (names.code !== 0 || diff.code !== 0) fail(500, "git diff failed");
    const files: WorkspaceChange[] = [];
    const parts = names.out.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]![0], path = parts[i + 1]!;
      files.push({path, status: code === "M" ? "modified" : code === "A" ? "added" : code === "D" ? "deleted" : "changed"});
    }
    let patch = diff.out, truncated = diff.truncated;
    const untracked = others.code === 0 ? others.out.split("\0").filter(Boolean) : [];
    for (const path of untracked.slice(0, MAX_UNTRACKED)) {
      files.push({path, status: "untracked"});
      if (patch.length >= MAX_DIFF) {truncated = true; continue;}
      patch += await untrackedPatch(root, path);
    }
    if (untracked.length > MAX_UNTRACKED) truncated = true;
    files.sort((a, b) => byName(a.path, b.path));
    return {git: true, files, patch, truncated};
  }
  /** Throw away one file's uncommitted changes. The client confirms first. */
  private async revert(req: IncomingMessage) {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) fail(415, "Send JSON");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req.iterator({destroyOnReturn:false})) {bytes += chunk.length; if (bytes > 8192) fail(413, "Request too large"); chunks.push(chunk);}
    let body: any;
    try {body = JSON.parse(Buffer.concat(chunks).toString());} catch {fail(400, "Invalid request");}
    if (!body || typeof body !== "object" || !ID.test(String(body.botId)) || !ID.test(String(body.threadId)) || typeof body.path !== "string") fail(400, "Send botId, threadId and path");
    const rel: string = body.path;
    if (!rel || rel.length > 4096 || rel.includes("\0") || rel.startsWith("/") || /^[a-z]:/i.test(rel) || rel.split(/[\\/]/).includes("..")) fail(400, "Invalid path");
    const root = this.options.resolveRoot(body.botId, body.threadId);
    // Validate the exact file before any index/worktree mutation. A directory
    // or a path beneath an escaping link must never turn into a bulk checkout.
    const full = join(root, ...rel.split("/"));
    let parent: string;
    try {parent = await realpath(join(full, ".."));} catch {fail(409, "File parent unavailable");}
    if (!inside(root, parent)) fail(403, "Path escapes the working folder");
    const st = await lstat(full).catch(() => null);
    if (st && !st.isFile() && !st.isSymbolicLink()) fail(409, "Only files can be reverted");
    if ((await git(root, ["rev-parse", "--is-inside-work-tree"])).out.trim() !== "true") fail(409, "Not a git repository");
    const spec = `:(literal)${rel}`;
    const prefix = (await git(root, ["rev-parse", "--show-prefix"])).out.trim();
    const object = await git(root, ["cat-file", "-t", `HEAD:${prefix}${rel}`]);
    if (object.code === 0 && object.out.trim() !== "blob") fail(409, "Only files can be reverted");
    const tracked = object.code === 0;
    if (tracked) {
      const done = await git(root, ["checkout", "HEAD", "--", spec]);
      if (done.code !== 0) fail(500, "git checkout failed");
      return;
    }
    // New file (staged or untracked): drop it from the index, then delete the regular file itself.
    if (!st) return;
    const removed = await git(root, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", spec]);
    if (removed.code !== 0) fail(500, "git index update failed");
    await unlink(full);
  }
}

/** Run git read-mostly in the folder: no optional locks, no prompts, no
 * fsmonitor hook, capped output and a hard timeout. */
async function git(cwd: string, args: string[], cap = 256 * 1024, inspectFilters = true): Promise<{code: number; out: string; truncated: boolean}> {
  // Even reading a diff can run a clean/process filter. The workspace viewer
  // never executes repository-defined commands, on reads or on restores.
  let disable: string[] = [];
  if (inspectFilters) {
    const filters = await git(cwd, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], cap, false);
    if (filters.truncated || (filters.code !== 0 && filters.code !== 1)) fail(500, "Cannot inspect repository filters");
    disable = filters.out.split("\n").filter(Boolean).flatMap(key => {
      if (!/^filter\.[^\s=]+\.(clean|smudge|process|required)$/.test(key)) fail(409, "Unsupported repository filter");
      return ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`];
    });
  }
  return new Promise(resolve => {
    let out = "", truncated = false, settled = false;
    const finish = (code: number) => {if (!settled) {settled = true; clearTimeout(timer); resolve({code, out, truncated});}};
    let child;
    try {
      child = spawn("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.quotepath=false", "-C", cwd, ...disable, ...args], {
        env: {...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C"},
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      });
    } catch {resolve({code: -1, out: "", truncated: false}); return;}
    const timer = setTimeout(() => {child.kill("SIGKILL"); finish(-1);}, GIT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      if (out.length + chunk.length > cap) {out += chunk.slice(0, cap - out.length); truncated = true; return;}
      out += chunk;
    });
    child.on("error", () => finish(-1));
    child.on("close", code => finish(truncated ? 0 : code ?? -1));
  });
}

/** An untracked file shown as an all-added diff, so the changes view reads the same for new files. */
async function untrackedPatch(root: string, path: string): Promise<string> {
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  try {
    const real = await realpath(join(root, ...path.split("/")));
    if (!inside(root, real)) return "";
    const st = await stat(real);
    if (!st.isFile()) return "";
    const fh = await open(real, "r");
    try {
      const buf = Buffer.alloc(Math.min(MAX_UNTRACKED_READ, st.size));
      const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.includes(0)) return `${header}Binary files /dev/null and b/${path} differ\n`;
      const lines = data.toString("utf8").replace(/\n$/, "").split("\n");
      if (!data.length) return header;
      return `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}\n`;
    } finally {await fh.close();}
  } catch {return "";}
}
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1
