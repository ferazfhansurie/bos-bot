import { compatEnv } from "../electron/branding-env.cjs";
// A headless server (`bosbot serve`, no desktop parent) has no packaged app to
// confirm Full access, so its owner's paired admin session must be able to
// grant it, while loopback (where a bot's own shell lands) still cannot.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const REMOTE_HOST = "box.tail1234.ts.net:8799";

let home: string;
let child: ChildProcess;
let stderr = "";

const remote = (source: string, extra: Record<string, string> = {}) => ({ host: REMOTE_HOST, "x-forwarded-for": source, ...extra });

function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path, method: init.method ?? "GET", headers: { "content-type": "application/json", ...init.headers } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(JSON.stringify(init.body));
    req.end();
  });
}

async function pair(scopes: string[], source: string): Promise<Record<string, string>> {
  const opened = await call("/api/auth/pairing", { method: "POST", body: { scopes } });
  expect(opened.status).toBe(200);
  const paired = await call("/api/auth/pair", { method: "POST", headers: remote(source), body: { code: opened.body.code, label: "owner phone" } });
  expect(paired.status).toBe(200);
  return remote(source, { authorization: `Bearer ${paired.body.token}` });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-headless-full-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: { codex: { driver: "codex", config: { cli: join(home, "missing-codex") } } },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(compatEnv.PATH ? { PATH: compatEnv.PATH } : {}),
      ...(compatEnv.SystemRoot ? { SystemRoot: compatEnv.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${stderr}`);
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("Full access on a headless server", () => {
  it("lets the owner's paired admin session grant it, never loopback or a client session", async () => {
    const created = await call("/api/bots", { method: "POST", body: { name: "Lead", modelSelection: { instanceId: "codex", model: "fixture" } } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const bot = created.body.bot ?? created.body;
    const threadId: string = bot.threadId;

    const loopback = await call(`/api/bots/${bot.id}`, { method: "PATCH", body: { approvalMode: "full" } });
    expect(loopback.status).toBe(403);
    expect((await call(`/api/bots/${bot.id}/tasks/${threadId}`, { method: "PATCH", body: { approvalMode: "full" } })).status).toBe(403);

    const viewer = await pair(["client"], "10.0.0.7");
    expect((await call(`/api/bots/${bot.id}`, { method: "PATCH", headers: viewer, body: { approvalMode: "full" } })).status).toBe(403);
    expect((await call(`/api/bots/${bot.id}/tasks/${threadId}`, { method: "PATCH", headers: viewer, body: { approvalMode: "full" } })).status).toBe(403);

    const owner = await pair(["admin", "client"], "10.0.0.8");
    const granted = await call(`/api/bots/${bot.id}`, { method: "PATCH", headers: owner, body: { approvalMode: "full" } });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.bot?.approvalMode ?? granted.body.approvalMode).toBe("full");

    const thread = await call(`/api/bots/${bot.id}/tasks/${threadId}`, { method: "PATCH", headers: owner, body: { approvalMode: "full" } });
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    expect(thread.body.task.approvalMode).toBe("full");

    // Custom stays a desktop-only (Codex config) level even here.
    expect((await call(`/api/bots/${bot.id}/tasks/${threadId}`, { method: "PATCH", headers: owner, body: { approvalMode: "custom" } })).status).toBe(403);
    expect((await call(`/api/bots/${bot.id}`, { method: "PATCH", headers: owner, body: { approvalMode: "custom" } })).status).toBe(403);
    const after = await call("/api/bots?messages=0");
    expect(after.body.bots.find((candidate: { id: string }) => candidate.id === bot.id).approvalMode).toBe("full");
  }, 30_000);
});
