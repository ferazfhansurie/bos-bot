import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_KEY = "voice-ring-fixture-only";
const OWNER_TOKEN = randomBytes(32).toString("base64url");
let child: ChildProcess; let home = ""; let base = ""; let port: number; let errors = "";

async function api(path: string, body?: unknown, headers: Record<string, string> = {}, method = "POST") {
  const response = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": OWNER_TOKEN, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as any, retryAfter: response.headers.get("retry-after") };
}
async function createBot() {
  const response = await api("/api/bots", {});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.bot;
}
async function capability(botId: string, threadId: string, kind = "agents") {
  const result = await api("/api/testing/internal-capability", { botId, threadId, kind }, { "x-openmausbot-test-capability": TEST_KEY });
  expect(result.status).toBe(201);
  return { authorization: `Bearer ${result.body.token}`, "x-openmausbot-desktop-owner": "" };
}
async function pair(scopes: string[]) {
  const opened = await api("/api/auth/pairing", { scopes });
  const paired = await api("/api/auth/pair", { code: opened.body.code, label: "voice ring fixture" });
  expect(paired.status).toBe(200);
  return paired.body;
}
async function start() {
  errors = "";
  // Match Electron's utility-process parentPort; node child IPC is a
  // different channel and cannot install the desktop mutation capability.
  const prelude = join(home, "desktop-parent.mjs");
  writeFileSync(prelude, `process.parentPort={on(name,fn){if(name==='message')setImmediate(()=>fn({data:{type:'openmausbot:desktop-mutation-token',token:${JSON.stringify(OWNER_TOKEN)}}}));},postMessage(){}};`);
  child = spawn(process.execPath, ["--import", prelude, join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_KEY, OMB_DESKTOP_PARENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${errors}`);
    try { if ((await api("/api/health", undefined, {}, "GET")).status === 200) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fixture startup timed out: ${errors}`);
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "bos-ring-http-"));
  mkdirSync(join(home, ".openmausbot"));
  writeFileSync(join(home, ".openmausbot/config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } } } }));
  port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  await start();
}, 30_000);
afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("voice ring HTTP authorization and delivery", () => {
  it("rings from an active MCP capability without the desktop mutation header, with exactly matching owner stream fields", async () => {
    const bot = await createBot();
    const auth = await capability(bot.id, bot.threadId);
    const stream = await openSse(base + "/api/events");
    try {
      const input = { botId: bot.id, reason: "Your work is ready." };
      const response = await api("/api/voice/ring", input, auth);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ ok: true, type: "voice_ring", ...input, threadId: bot.threadId });
      const event = await stream.until(frame => frame.kind === "voice_ring" && frame.ringId === response.body.ringId);
      expect(event).toMatchObject({ kind: "voice_ring", ...input, ringId: response.body.ringId, threadId: bot.threadId });
      const repeat = await api("/api/voice/ring", { ...input, threadId: bot.threadId }, auth);
      expect(repeat.status).toBe(429);
      expect(Number(repeat.retryAfter)).toBeGreaterThan(0);
      expect(Number(repeat.retryAfter)).toBeLessThanOrEqual(600);
      // The same reservation is honored after an actual process restart.
      stream.close(); await waitForExit(child, { signal: "SIGTERM" }); await start();
      expect((await api("/api/voice/ring", input)).status).toBe(429);
      expect((await api("/api/voice/ring", input, auth)).status).toBe(401);
    } finally { stream.close(); }
  }, 30_000);

  it("rejects client and peer sessions, forged capabilities, wrong integration kinds and impersonation without reserving a ring", async () => {
    const bot = await createBot(); const other = await createBot();
    const input = { botId: bot.id, threadId: bot.threadId, reason: "Join me." };
    const client = await pair(["client"]); const peer = await pair(["peer"]);
    for (const token of [client.token, peer.token]) expect((await api("/api/voice/ring", input, { authorization: `Bearer ${token}` })).status).toBe(403);
    const foreignAdmin = await pair(["admin", "client"]);
    expect((await api("/api/multiplayer/actor-bindings", { sessionId: foreignAdmin.session.id, personId: "foreign:person:owner", name: "Fixture guest" })).status).toBe(200);
    expect((await api("/api/voice/ring", input, { authorization: `Bearer ${foreignAdmin.token}` })).status).toBe(403);
    expect((await api("/api/voice/ring", input, { authorization: "Bearer forged", "x-openmausbot-desktop-owner": "" })).status).toBe(401);
    expect((await api("/api/voice/ring", input, { "x-openmausbot-desktop-owner": "" })).status).toBe(403);
    const wrong = await capability(bot.id, bot.threadId, "computer");
    expect((await api("/api/voice/ring", input, wrong)).status).toBe(403);
    const auth = await capability(bot.id, bot.threadId);
    expect((await api("/api/voice/ring", { ...input, botId: other.id }, auth)).status).toBe(403);
    expect((await api("/api/voice/ring", { ...input, threadId: other.threadId }, auth)).status).toBe(403);
    expect((await api("/api/voice/ring", input, { ...auth, origin: "https://evil.example" })).status).toBe(403);
    expect((await api("/api/voice/ring", input, { ...auth, "x-forwarded-for": "203.0.113.1" })).status).toBe(403);
    expect((await api("/api/voice/ring", { ...input, actorId: "evil:person:owner" }, auth)).status).toBe(400);
    expect((await api("/api/voice/ring", { ...input, reason: " " }, auth)).status).toBe(400);
    expect((await api("/api/voice/ring", input, auth)).status).toBe(202);
  });

  it("accepts an owner admin device but refuses another bot's thread and limits genuinely overlapping HTTP rings", async () => {
    const bot = await createBot(); const other = await createBot(); const admin = await pair(["admin", "client"]);
    const headers = { authorization: `Bearer ${admin.token}`, "x-openmausbot-desktop-owner": "" };
    const input = { botId: bot.id, reason: "Please join." };
    expect((await api("/api/voice/ring", { ...input, threadId: other.threadId }, headers)).status).toBe(404);
    const results = await Promise.all([api("/api/voice/ring", input, headers), api("/api/voice/ring", input, headers)]);
    expect(results.map(result => result.status).sort()).toEqual([202, 429]);
    expect((await api("/api/voice/ring", { botId: other.id, reason: "Another call." }, headers)).status).toBe(202);
  });

  it("rechecks capability revocation when a request body is still arriving", async () => {
    const bot = await createBot(); const auth = await capability(bot.id, bot.threadId);
    const raw = JSON.stringify({ botId: bot.id, threadId: bot.threadId, reason: "Call." });
    const req = request(base + "/api/voice/ring", { method: "POST", headers: { authorization: auth.authorization, "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } });
    const response = new Promise<number>((resolve, reject) => { req.on("error", reject); req.on("response", res => { res.resume(); resolve(res.statusCode!); }); });
    req.write(raw.slice(0, -1));
    // Force bytes onto the live connection before replacing the capability.
    await new Promise<void>((resolve, reject) => {
      req.on("socket", socket => { socket.on("error", reject); if (socket.connecting) socket.once("connect", resolve); else resolve(); });
    });
    const fresh = await capability(bot.id, bot.threadId);
    req.end(raw.slice(-1));
    expect(await response).toBe(401);
    expect((await api("/api/voice/ring", { botId: bot.id, reason: "Call." }, fresh)).status).toBe(202);
  });

  it("rechecks an owner device's session after revocation during upload", async () => {
    const bot = await createBot(); const admin = await pair(["admin", "client"]);
    const raw = JSON.stringify({ botId: bot.id, reason: "Call." });
    const req = request(base + "/api/voice/ring", { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } });
    const response = new Promise<number>((resolve, reject) => { req.on("error", reject); req.on("response", res => { res.resume(); resolve(res.statusCode!); }); });
    req.write(raw.slice(0, -1));
    await new Promise<void>((resolve, reject) => {
      req.on("socket", socket => { socket.on("error", reject); if (socket.connecting) socket.once("connect", resolve); else resolve(); });
    });
    expect((await api(`/api/auth/sessions/${admin.session.id}`, {}, {}, "DELETE")).status).toBe(200);
    req.end(raw.slice(-1));
    expect([401, 403]).toContain(await response);
    expect((await api("/api/voice/ring", { botId: bot.id, reason: "Call." })).status).toBe(202);
  });
});
