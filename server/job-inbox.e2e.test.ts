import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { WorkContinuity } from "./work-continuity.ts";
import { WorkRuntimeLedger } from "./work-continuity-runtime.ts";

const root = new URL("../", import.meta.url).pathname;
let data: string, base: string, port: number, child: ChildProcess;
let lead: any, other: any, room: any, second: string;
let stderr = "";
const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
async function start() {
  child = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], {
    cwd: root, env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(data, "finish.gate") }, data, port), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.resume(); child.stderr!.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { if ((await fetch(base + "/api/health")).status === 200) return; } catch {}
    if (Date.now() > deadline) throw new Error(`Fixture startup timed out: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const items = async (token?: string) => {
  const result = await api("GET", "/api/jobs", undefined, token);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.items as any[];
};
const pair = async (scope = "client") => {
  const code = (await api("POST", "/api/auth/pairing", { scopes: [scope] })).body.code;
  const result = await api("POST", "/api/auth/pair", { code, label: "Synthetic jobs device" });
  expect(result.status).toBe(200); return result.body;
};
beforeAll(async () => {
  port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  data = mkdtempSync(join(tmpdir(), "omb-jobs-")); mkdirSync(join(data, "tmp"));
  const fake = join(root, "server/testing/fake-claude-cli.ts"); chmodSync(fake, 0o755);
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: fake } } } }));
  await start();
  lead = (await api("POST", "/api/bots", {})).body.bot;
  other = (await api("POST", "/api/bots", {})).body.bot;
  expect((await api("PATCH", `/api/bots/${lead.id}`, { visibility: "private", workContinuity: true })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${other.id}`, { visibility: "shared" })).status).toBe(200);
  second = (await api("POST", `/api/bots/${lead.id}/tasks`, { title: "Human hold" })).body.task.threadId;
  room = (await api("POST", "/api/groups", { name: "Synthetic jobs room", memberIds: [lead.id] })).body.group;
  await waitForExit(child, { signal: "SIGTERM" });
  const ledger = new WorkContinuity(join(data, "work-plans.json"));
  const plan = (botId: string, threadId: string, outcome: string, human = false) => ledger.set(botId, threadId, {
    outcome, status: "active", expectedRevision: 0,
    steps: [{ id: "own", ownerBotId: human ? "human" : botId, action: "Synthetic fixture check", status: "ready", dependsOn: [] }],
  });
  plan(lead.id, lead.threadId, "Private direct"); plan(lead.id, second, "Human hold", true);
  plan(lead.id, room.threadId, "Room job");
  ledger.set(other.id, other.threadId, { outcome: "Shared direct", status: "active", expectedRevision: 0, steps: [
    { id: "own", ownerBotId: other.id, action: "Synthetic own work", status: "ready", dependsOn: [] },
    { id: "human", ownerBotId: "human", action: "Human acceptance after own work", status: "ready", dependsOn: ["own"] },
  ] });
  plan(other.id, "unowned-thread", "Orphan thread sentinel"); plan(other.id, room.threadId, "Nonmember bot sentinel");
  plan("missing-bot", "missing-thread", "Deleted bot sentinel");
  const runtime = new WorkRuntimeLedger(join(data, "work-runtime.json")); runtime.hold(lead.id, lead.threadId, "synthetic-round");
  await start();
}, 45000);
afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (data) await removeTempDir(data); });

it("owner and paired owner read only existing direct and room bot/thread pairs", async () => {
  const owner = await pair();
  const expected = ["Human hold", "Private direct", "Room job", "Shared direct"];
  expect((await items()).map(item => item.outcome).sort()).toEqual(expected);
  expect((await items(owner.token)).map(item => item.outcome).sort()).toEqual(expected);
  expect((await items()).find(item => item.outcome === "Private direct").state).toBe("paused");
  expect((await items()).find(item => item.outcome === "Human hold").state).toBe("needs-you");
  expect((await items()).find(item => item.outcome === "Shared direct").state).toBe("ready");
});
it("foreign account sees shared direct jobs but no private bot, room or orphan plans", async () => {
  const guest = await pair();
  expect((await api("POST", "/api/multiplayer/actor-bindings", { sessionId: guest.session.id, personId: "synthetic-home:person:guest", name: "Synthetic guest" })).status).toBe(200);
  expect((await items(guest.token)).map(item => item.outcome)).toEqual(["Shared direct"]);
  expect((await api("PATCH", `/api/bots/${other.id}`, { visibility: "private" })).status).toBe(200);
  expect(await items(guest.token)).toEqual([]);
  expect((await api("PATCH", `/api/bots/${other.id}`, { visibility: "shared" })).status).toBe(200);
});
it("peer-only and revoked sessions cannot read workspace jobs", async () => {
  const peer = await pair("peer");
  expect((await api("GET", "/api/jobs", undefined, peer.token)).status).toBe(403);
  const revoked = await pair();
  expect((await api("DELETE", `/api/auth/sessions/${revoked.session.id}`)).status).toBe(200);
  expect((await api("GET", "/api/jobs", undefined, revoked.token)).status).toBe(401);
});
it("repeated reads leave plans, Stop rounds and dispatch state untouched", async () => {
  const files = ["work-plans.json", "work-runtime.json"];
  const before = files.map(file => readFileSync(join(data, file), "utf8"));
  for (let count = 0; count < 3; count++) await items();
  expect(files.map(file => readFileSync(join(data, file), "utf8"))).toEqual(before);
  expect(existsSync(join(data, "fake-claude-dump.json"))).toBe(false);
  expect((await api("GET", "/api/bots")).body.bots.every((bot: any) => !bot.busy)).toBe(true);
});
it("a real running fixture turn projects moving without reading another thread", async () => {
  expect((await api("POST", `/api/bots/${other.id}/messages`, { text: "Synthetic held turn", threadId: other.threadId })).status).toBe(202);
  await expect.poll(async () => (await items()).find(item => item.outcome === "Shared direct")?.state, { timeout: 15000 }).toBe("moving");
  expect((await items()).find(item => item.outcome === "Human hold").state).toBe("needs-you");
  expect((await api("POST", `/api/bots/${other.id}/interrupt`, {})).status).toBe(200);
});
it("unreadable runtime storage fails closed without a partial response", async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  writeFileSync(join(data, "work-runtime.json"), "invalid-json"); await start();
  const result = await api("GET", "/api/jobs"); expect(result.status).toBe(503); expect(result.body.items).toBeUndefined();
}, 30000);
