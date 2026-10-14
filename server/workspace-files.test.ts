import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceFilesService, rankFilePaths } from "./workspace-files.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";

let server: Server;
let url: string;
let base: string;
let root: string;
let sessions: SessionRegistry;
beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bos-files-")));
  root = join(base, "root"); mkdirSync(root);
  writeFileSync(join(base, "secret.txt"), "outside");
  mkdirSync(join(root, "src")); mkdirSync(join(root, ".git")); mkdirSync(join(root, "Zeta"));
  writeFileSync(join(root, "b.txt"), "hello world");
  writeFileSync(join(root, "A.md"), "# a");
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, "src", "util.ts"), "export {}");
  symlinkSync(join(base, "secret.txt"), join(root, "escape"));
  symlinkSync(join(root, "b.txt"), join(root, "alias"));
  sessions = new SessionRegistry({ file: join(base, "sessions.json") });
  const service = new WorkspaceFilesService({
    ownerToken: () => "fixture-owner-capability",
    authenticate: req => resolveRequestAuth(req, { sessions, cookieName: "fixture", streamPath: "/api/events", url: new URL(req.url!, url), loopbackMutationToken: "fixture-owner-capability" }).auth?.kind === "loopback",
    resolveRoot: (botId, threadId) => {
      if (botId !== "bot" || threadId !== "thread") throw Object.assign(new Error("No such terminal thread"), { status: 404 });
      return root;
    },
  });
  server = createServer(async (req, res) => {
    if (await service.handle(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  sessions.close(); rmSync(base, { recursive: true, force: true });
});
function get(route: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const qs = new URLSearchParams({ botId: "bot", threadId: "thread", ...params });
  return fetch(`${url}/api/workspace-files/${route}?${qs}`, { headers: { "x-openmausbot-desktop-owner": "fixture-owner-capability", origin: url, ...headers } });
}

it("refuses without the owner capability or from a proxied/non-loopback request", async () => {
  expect((await get("list", {}, { "x-openmausbot-desktop-owner": "" })).status).toBe(403);
  expect((await get("list", {}, { "x-openmausbot-desktop-owner": "wrong" })).status).toBe(403);
  expect((await get("list", {}, { "x-forwarded-for": "10.0.0.1" })).status).toBe(403);
  expect((await get("list", {}, { origin: "https://evil.example" })).status).toBe(403);
  expect((await get("list", {}, { "x-openmausbot-companion": "1" })).status).toBe(403);
  const r = await get("list"); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  expect((await get("list", { botId: "../x" })).status).toBe(400);
  expect((await get("list", { botId: "other" })).status).toBe(404);
  expect((await fetch(`${url}/api/other`)).status).toBe(404);
});
it("lists the root dirs-first with a case-insensitive sort, skipping .git and escaping links", async () => {
  const body = await (await get("list", { path: "" })).json() as any;
  expect(body.root).toBe(root); expect(body.path).toBe(""); expect(body.truncated).toBe(false);
  expect(body.entries.map((e: any) => e.name)).toEqual(["src", "Zeta", "A.md", "alias", "b.txt", "blob.bin"]);
  expect(body.entries[0]).toEqual(expect.objectContaining({ name: "src", path: "src", kind: "dir", mtime: expect.any(Number) }));
  expect(body.entries.find((e: any) => e.name === "alias")).toEqual(expect.objectContaining({ name: "alias", path: "alias", kind: "file", size: 11, mtime: expect.any(Number) }));
  const sub = await (await get("list", { path: "src" })).json() as any;
  expect(sub.entries).toEqual([expect.objectContaining({ name: "util.ts", path: "src/util.ts", kind: "file", size: 9, mtime: expect.any(Number) })]);
  expect((await get("list", { path: "b.txt" })).status).toBe(409);
  expect((await get("list", { path: "missing" })).status).toBe(404);
});
it("reads text, flags binary and refuses folders", async () => {
  expect(await (await get("read", { path: "b.txt" })).json()).toEqual(expect.objectContaining({ path: "b.txt", size: 11, mtime: expect.any(Number), binary: false, truncated: false, content: "hello world" }));
  expect(await (await get("read", { path: "blob.bin" })).json()).toEqual(expect.objectContaining({ path: "blob.bin", size: 4, mtime: expect.any(Number), binary: true, truncated: false, content: "" }));
  writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));
  const big = await (await get("read", { path: "big.txt" })).json() as any;
  expect(big.truncated).toBe(true); expect(big.content.length).toBe(256 * 1024);
  expect((await get("read", { path: "src" })).status).toBe(409);
  expect((await get("read", { path: "nope.txt" })).status).toBe(404);
});
it("rejects traversal, absolute paths and symlink escapes", async () => {
  for (const path of ["../secret.txt", "src/../../secret.txt", "/etc/passwd", join(base, "secret.txt"), "a\0b"]) expect((await get("read", { path })).status).toBe(400);
  expect((await get("list", { path: ".." })).status).toBe(400);
  const r = await get("read", { path: "escape" });
  expect(r.status).toBe(403); expect(JSON.stringify(await r.json())).not.toContain("outside");
});
it("searches with basename-first ranking and skips heavy folders", async () => {
  mkdirSync(join(root, "node_modules", "util"), { recursive: true });
  writeFileSync(join(root, "node_modules", "util", "util.js"), "");
  mkdirSync(join(root, "util", "deep", "nested"), { recursive: true });
  writeFileSync(join(root, "util", "deep", "nested", "thing.ts"), "");
  const body = await (await get("search", { q: "util" })).json() as any;
  expect(body.root).toBe(root); expect(body.truncated).toBe(false);
  expect(body.files).toEqual(["src/util.ts", "util/deep/nested/thing.ts"]);
  const all = await (await get("search", { q: "", limit: "3" })).json() as any;
  expect(all.files).toEqual(["A.md", "alias", "b.txt"]);
  expect((await (await get("search", { q: "secret" })).json() as any).files).toEqual([]);
});
it("ranks basename and contiguous matches above scattered deep matches", () => {
  expect(rankFilePaths(["a/b/c/user-interface.ts", "lib/ui.ts", "u/x/i.ts"], "ui", 10)).toEqual(["lib/ui.ts", "a/b/c/user-interface.ts", "u/x/i.ts"]);
  expect(rankFilePaths(["deep/a/b/index.ts", "index.ts"], "index", 10)).toEqual(["index.ts", "deep/a/b/index.ts"]);
  expect(rankFilePaths(["x/y.ts", "a.ts"], "", 10)).toEqual(["a.ts", "x/y.ts"]);
  expect(rankFilePaths(["a.ts", "b.ts"], "zz", 10)).toEqual([]);
});
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1

 it("reverts only the exact file, refuses directories and escaping parents before mutations", async () => {
  rmSync(join(root, ".git"), {recursive: true});
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {stdio: "pipe"});
  git("init");
  writeFileSync(join(root, ".gitattributes"), "b.txt filter=fixture\n");
  git("config", "filter.fixture.smudge", "touch filter-ran; cat");
  git("add", ".gitattributes", "b.txt", "src/util.ts");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  git("config", "filter.fixture.clean", "touch clean-ran; cat");
  writeFileSync(join(root, "b.txt"), "edited"); writeFileSync(join(root, "src/util.ts"), "changed");
  const revert = (path: string) => fetch(`${url}/api/workspace-files/revert`, {method: "POST", headers: {"content-type": "application/json", "x-openmausbot-desktop-owner": "fixture-owner-capability", origin: url}, body: JSON.stringify({botId: "bot", threadId: "thread", path})});
  expect((await get("changes")).status).toBe(200);
  expect((await get("stat", {path: "clean-ran"})).status).toBe(404);
  expect((await revert("src")).status).toBe(409);
  expect(((await (await get("read", {path: "src/util.ts"})).json()) as {content: string}).content).toBe("changed");
  symlinkSync(base, join(root, "outside-dir"));
  expect((await revert("outside-dir/secret.txt")).status).toBe(403);
  expect((await revert("../secret.txt")).status).toBe(400);
  expect((await revert("b.txt")).status).toBe(200);
  expect((await get("stat", {path: "filter-ran"})).status).toBe(404);
  expect(((await (await get("read", {path: "b.txt"})).json()) as {content: string}).content).toBe("hello world");
  expect(((await (await get("read", {path: "src/util.ts"})).json()) as {content: string}).content).toBe("changed");
});
