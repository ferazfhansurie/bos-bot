// Sandboxed swap: the detached python updater against copies of a fake app
// bundle in a temp dir. Never the live app, never ~/.bos-bot.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDigests, type ApplyPlan } from "./updater.ts";
import { UPDATER_APPLY_SCRIPT } from "./updater-apply-script.ts";

const PYTHON = "/usr/bin/python3";
const hasPython = process.platform === "darwin" && existsSync(PYTHON);

// Stand-in for the Electron binary: binds the port it is given and answers
// /api/health like the real server does, with its own pid.
const FAKE_BINARY = `#!${PYTHON}
import json, os, sys, signal
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"app": "openmausbot", "pid": os.getpid()}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
HTTPServer.allow_reuse_address = True
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
`;
const BROKEN_BINARY = `#!${PYTHON}\nimport sys\nsys.exit(7)\n`;

function fakeApp(root: string, name: string, stamp: string, binary = FAKE_BINARY): string {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), `// ${stamp}\n`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), `<html>${stamp}</html>`);
  writeFileSync(join(app, "Contents", "MacOS", "BOS Bot"), binary, { mode: 0o755 });
  return app;
}

const stampOf = (app: string) => readFileSync(join(app, "Contents", "Resources", "server", "index.js"), "utf8").trim();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function health(port: number): Promise<{ app: string; pid: number } | null> {
  try { return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { app: string; pid: number }; } catch { return null; }
}

async function waitHealthy(port: number, ms = 10_000): Promise<{ app: string; pid: number }> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const h = await health(port); if (h) return h; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`nothing healthy on ${port}`);
}

function listeners(port: number): Promise<number[]> {
  return new Promise(resolve => execFile("/usr/sbin/lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], (_e, out) => resolve(String(out).split(/\s+/).filter(Boolean).map(Number))));
}

async function killPort(port: number) {
  for (const pid of await listeners(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

function runScript(dir: string): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(PYTHON, [join(dir, "apply.py")], { timeout: 120_000 }, (error, _out, stderr) => {
      resolve({ code: child.exitCode ?? (error ? 1 : 0), stderr: String(stderr) });
    });
  });
}

describe.skipIf(!hasPython)("detached updater script (sandboxed swap)", () => {
  let root: string; let port: number; let live: string; let dir: string; let oldApp: ChildProcess | null;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "bos-swap-"));
    port = await freePort();
    live = fakeApp(join(root, "Applications"), "BOS Bot.app", "old");
    dir = join(root, "data", "updates", "11111111-2222-4333-8444-555555555555");
    mkdirSync(dir, { recursive: true });
    oldApp = spawn(join(live, "Contents", "MacOS", "BOS Bot"), [String(port)], { stdio: "ignore", detached: true });
    oldApp.unref();
    await waitHealthy(port);
  });
  afterEach(async () => {
    await killPort(port);
    rmSync(root, { recursive: true, force: true });
  });

  function plan(overrides: Partial<ApplyPlan> & { staged?: string | null }): ApplyPlan {
    const old = appDigests(live);
    const staged = overrides.staged ?? null;
    const full: ApplyPlan = {
      updateId: "11111111-2222-4333-8444-555555555555", label: "ai.bos.bot.update.11111111", mode: staged ? "update" : "restart", live,
      staged, backup: staged ? join(root, "Applications", "BOS Bot.previous-old.app-disabled") : null,
      appPid: oldApp?.pid ?? null, appIdentity: null, ports: [port], health: `http://127.0.0.1:${port}/api/health`,
      expect: staged ? appDigests(staged) : null, old, oldVersion: "0.1.85", oldSha: "2d83ba23", version: staged ? "0.1.86" : "0.1.85", sha: staged ? "feedface" : "2d83ba23",
      force: true, launch: ["{app}/Contents/MacOS/BOS Bot", String(port)], resultPath: join(dir, "result.json"), installedPath: join(root, "data", "updates", "installed.json"),
      gracefulSeconds: 5, healthSeconds: 12, codesign: false, selfBootout: false, requireLaunchd: false, uid: null,
      scriptSha256: createHash("sha256").update(UPDATER_APPLY_SCRIPT).digest("hex"), ...overrides,
    };
    writeFileSync(join(dir, "apply.py"), UPDATER_APPLY_SCRIPT, { mode: 0o700 });
    writeFileSync(join(dir, "plan.json"), JSON.stringify(full, null, 2));
    return full;
  }

  const result = () => JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));

  it("agrees with the TypeScript tree digest", async () => {
    const staged = fakeApp(join(root, "staged"), "BOS Bot.app", "new");
    const probe = join(root, "digest.py");
    writeFileSync(probe, UPDATER_APPLY_SCRIPT.split("\ndef digests")[0].replace(/^HERE = [\s\S]*?^LOG = .*\n/m, "") +
      `\nimport json, sys\nprint(json.dumps({"server": tree_digest(sys.argv[1], "server"), "ui": tree_digest(sys.argv[1], "ui")}))\n`);
    const out = await new Promise<string>((resolve, reject) => execFile(PYTHON, [probe, staged], (e, o, err) => e ? reject(new Error(err)) : resolve(o)));
    expect(JSON.parse(out)).toEqual(appDigests(staged));
  });

  it("stops the old app, swaps the bundle, relaunches, verifies health and records done", async () => {
    const staged = fakeApp(join(root, "staged"), "BOS Bot.app", "new");
    const p = plan({ staged });
    const oldPid = (await health(port))!.pid;
    const { code } = await runScript(dir);
    expect(code).toBe(0);
    expect(result()).toMatchObject({ state: "done", mode: "update", version: "0.1.86", sha: "feedface", rollback: p.backup, detail: "updated to 0.1.86 (feedface)" });
    expect(stampOf(live)).toBe("// new");
    expect(stampOf(p.backup!)).toBe("// old");
    expect(existsSync(staged)).toBe(false);
    const fresh = await waitHealthy(port);
    expect(fresh.pid).not.toBe(oldPid);
    expect(JSON.parse(readFileSync(p.installedPath, "utf8"))).toMatchObject({ version: "0.1.86", sha: "feedface", updateId: p.updateId, server: p.expect!.server });
    // A second run of the same job touches nothing.
    const again = await runScript(dir);
    expect(again.code).toBe(4);
    expect((await health(port))!.pid).toBe(fresh.pid);
  }, 90_000);

  it("rolls back to the old bundle when the new one never becomes healthy", async () => {
    const staged = fakeApp(join(root, "staged"), "BOS Bot.app", "broken", BROKEN_BINARY);
    const p = plan({ staged, healthSeconds: 4 });
    const { code } = await runScript(dir);
    expect(code).toBe(1);
    expect(result()).toMatchObject({ state: "rolled_back", version: "0.1.85", sha: "2d83ba23", detail: expect.stringMatching(/did not become healthy/) });
    expect(result().rollback).toMatch(/BOS Bot\.failed-11111111\.app-disabled$/);
    expect(stampOf(live)).toBe("// old");
    expect(stampOf(result().rollback)).toBe("// broken");
    expect(existsSync(p.backup!)).toBe(false);
    expect(existsSync(p.installedPath)).toBe(false);
    expect((await waitHealthy(port)).app).toBe("openmausbot");
  }, 90_000);

  it("refuses a staged bundle whose contents changed after it was hashed and relaunches the old app", async () => {
    const staged = fakeApp(join(root, "staged"), "BOS Bot.app", "new");
    plan({ staged, expect: { server: "0".repeat(64), ui: "0".repeat(64) } });
    const { code } = await runScript(dir);
    expect(code).toBe(1);
    expect(result()).toMatchObject({ state: "failed", appStillRunning: false, detail: expect.stringMatching(/swap refused: staged tree changed/) });
    expect(stampOf(live)).toBe("// old");
    expect(existsSync(staged)).toBe(true);
    expect((await waitHealthy(port)).app).toBe("openmausbot");
  }, 60_000);

  it("restart mode relaunches the same bundle", async () => {
    plan({});
    const oldPid = (await health(port))!.pid;
    const { code } = await runScript(dir);
    expect(code).toBe(0);
    expect(result()).toMatchObject({ state: "done", mode: "restart", detail: "restarted", version: "0.1.85" });
    expect(stampOf(live)).toBe("// old");
    expect((await waitHealthy(port)).pid).not.toBe(oldPid);
  }, 60_000);

  it("refuses to run when its own bytes differ from the plan", async () => {
    plan({ scriptSha256: "f".repeat(64) });
    const { code } = await runScript(dir);
    expect(code).toBe(1);
    expect(result()).toMatchObject({ state: "failed", detail: expect.stringMatching(/does not match the plan/) });
    expect((await health(port))?.app).toBe("openmausbot");
  });
});
