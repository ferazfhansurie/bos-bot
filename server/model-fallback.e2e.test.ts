import { compatEnv } from "../electron/branding-env.cjs";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { waitForExit, removeTempDir } from "./testing/cleanup.ts";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
let home = "", base = "", child: ChildProcess, stderr = "";
let errorFile = "", usageFile = "", clockFile = "", usageGate = "";
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  stderr = "";
  home = mkdtempSync(join(tmpdir(), "omb-fallback-fixture-"));
  const data = join(home, ".openmausbot"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Fallback fixture</title>");
  errorFile = join(home, "error.txt"); writeFileSync(errorFile, "429 Too Many Requests");
  const wrapper = join(home, "quota-cli.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node\nimport {readFileSync} from 'node:fs';\nconst write=process.stdout.write.bind(process.stdout);\nprocess.stdout.write=(chunk,...args)=>write(typeof chunk==='string'?chunk.replaceAll('529 Overloaded',readFileSync(${JSON.stringify(errorFile)},'utf8')):chunk,...args);\nprocess.env.FAKE_CLAUDE_MODE=readFileSync(${JSON.stringify(errorFile)},'utf8')==='happy'?'happy':'api-error';\nawait import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});\n`, { mode: 0o755 });
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
    primary: { driver: "claudeAgent", config: { cli: wrapper } },
    backup: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE: "happy" } },
  } }));
  const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  usageFile = join(home, "usage.json"); clockFile = join(home, "clock.txt"); usageGate = join(home, "usage.gate");
  writeFileSync(usageGate, "ready");
  const bootstrap = join(home, "bootstrap.mjs");
  writeFileSync(bootstrap, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const now=Date.now.bind(Date);Date.now=()=>existsSync(${JSON.stringify(clockFile)})?Number(readFileSync(${JSON.stringify(clockFile)},'utf8')):now();
const fetch=globalThis.fetch;globalThis.fetch=async(url,...args)=>{if(String(url)!=='https://api.anthropic.com/api/oauth/usage')return fetch(url,...args);writeFileSync(${JSON.stringify(usageGate)}+'.waiting','1');while(!existsSync(${JSON.stringify(usageGate)}))await new Promise(r=>setTimeout(r,20));return new Response(existsSync(${JSON.stringify(usageFile)})?readFileSync(${JSON.stringify(usageFile)},'utf8'):'{}',{headers:{'content-type':'application/json'}});};
await import(${JSON.stringify(pathToFileURL(join(root,"server/index.ts")).href)});`);
  child = spawn(process.execPath, [bootstrap], { cwd: root,
    env: { PATH: compatEnv.PATH, HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: staticDir }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${stderr}`);
    try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* fixture boot */ }
    if (Date.now() > deadline) throw new Error(stderr || "fixture start timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}, 30_000);
afterEach(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });
async function create() {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const primary = instances.find((i: any) => i.instanceId === "primary").models.default;
  const backup = instances.find((i: any) => i.instanceId === "backup").models.default;
  const result = await api("POST", "/api/bots", { name: "Fixture", modelSelection: { instanceId: "primary", model: primary }, fallbackModel: backup });
  expect(result.status).toBe(201);
  expect(result.body.bot.fallbackModel).toBe(backup);
  await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
  return { bot: result.body.bot, primary, backup };
}
async function settled(bot: any, expected: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id);
    const task = state.tasks.find((task: any) => task.threadId === bot.threadId);
    if (!task.busy && task.modelSelection.model === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`fallback fixture timeout: ${stderr}`);
}
it("the real server retries a quota-blocked turn once on its configured model", async () => {
  const { bot, backup } = await create();
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fixture request", threadId: bot.threadId })).status).toBe(202);
  const state = await settled(bot, backup);
  expect(state.tasks[0].approvalMode ?? "ask").toBe("ask");
  const events = readFileSync(join(home, ".openmausbot/events", `${bot.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.filter(e => e.type === "model.switched")).toHaveLength(1);
  expect(events.filter(e => e.type === "turn.started")).toHaveLength(2);
  expect(events.filter(e => e.type === "turn.completed").at(-1)?.ok).toBe(true);
});
it("authentication failure stays on the primary model and invalid backup configuration is rejected", async () => {
  writeFileSync(errorFile, "401 Unauthorized");
  const { bot, primary } = await create();
  expect((await api("PATCH", `/api/bots/${bot.id}`, { fallbackModel: "unknown-model" })).status).toBe(400);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fixture auth failure", threadId: bot.threadId })).status).toBe(202);
  await new Promise(resolve => setTimeout(resolve, 400));
  await settled(bot, primary);
  const events = readFileSync(join(home, ".openmausbot/events", `${bot.threadId}.ndjson`), "utf8");
  expect(events).not.toContain('"type":"model.switched"');
});

it("room execution preflights usage and restores its member model at reset", async () => {
  const { bot, primary, backup } = await create();
  const clock = Date.now();
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: clock + 600_000 } }));
  writeFileSync(clockFile, String(clock));
  writeFileSync(usageFile, JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(clock + 1000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(clock + 604800000).toISOString() } }));
  const result = await api("POST", "/api/groups", { name: "Fallback room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(result.status).toBe(201);
  const room = result.body.group;
  const waitRoom = async (count: number) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const snapshot = (await api("GET", "/api/bots?messages=100")).body.groups.find((g: any) => g.id === room.id);
      if (!snapshot.working && snapshot.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length >= count) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`room fallback timeout: ${stderr}`);
  };
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room fixture request" })).status).toBe(202);
  const first = await waitRoom(1);
  expect(first.messages.some((m: any) => m.kind === "activity" && m.tool?.name?.includes(backup))).toBe(true);
  writeFileSync(clockFile, String(clock + 31_000));
  writeFileSync(usageFile, JSON.stringify({ five_hour: { utilization: 10, resets_at: new Date(clock + 18_000_000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(clock + 604800000).toISOString() } }));
  writeFileSync(errorFile, "happy");
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room after reset" })).status).toBe(202);
  const second = await waitRoom(2);
  expect(second.messages.some((m: any) => m.kind === "activity" && m.tool?.name?.includes(`restored ${primary}`))).toBe(true);
  const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id);
  expect(state.modelSelection.model).toBe(primary);
  expect(state).not.toHaveProperty("roomModelFallbacks");
}, 40_000);

it("configured fallback lookup cannot admit a guarded send after permissions changed", async () => {
  const { bot } = await create();
  writeFileSync(errorFile, "happy");
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: Date.now() + 600_000 } }));
  writeFileSync(usageFile, JSON.stringify({ five_hour: { utilization: 25, resets_at: new Date(Date.now() + 18000000).toISOString() } }));
  const page = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body;
  rmSync(usageGate);
  const pending = api("POST", `/api/bots/${bot.id}/messages/guarded`, { threadId: bot.threadId, sendId: randomUUID(), text: "STALE GUARDED REQUEST", expectedActiveLeafId: page.activeLeafId });
  const deadline = Date.now() + 4000;
  while (!existsSync(usageGate + ".waiting")) {
    if (Date.now() > deadline) throw new Error("guarded fixture did not reach quota lookup");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", autoApprove: true })).status).toBe(200);
  writeFileSync(usageGate, "resume lookup");
  const rejected = await pending;
  expect(rejected.status).toBe(409);
  expect(rejected.body.code).toBe("guarded_permissions");
  const final = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body;
  expect(final.messages.some((m: any) => m.role === "user" && m.text === "STALE GUARDED REQUEST")).toBe(false);
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
