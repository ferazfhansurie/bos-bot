import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { waitForExit } from "./testing/cleanup.ts";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";

it("refuses a checkpoint restore across bots while canonical and nested project writers are active", async ({ skip }) => {
  const gitBin = (process.env.PATH ?? "").split(delimiter).find(dir => existsSync(join(dir, process.platform === "win32" ? "git.exe" : "git")));
  if (!gitBin) return skip();
  const root = mkdtempSync(join(tmpdir(), "omb-restore-race-"));
  const project = join(root, "project");
  const nested = join(project, "nested");
  const alias = join(root, "alias");
  const gate = join(root, "finish");
  mkdirSync(nested, { recursive: true });
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(project, "work.txt"), "checkpoint version");
  writeFileSync(gate, "finish seed turn");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  let child: ChildProcess | undefined;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
  const create = async (name: string, cwd: string) => {
    const created = await api("POST", "/api/bots", { name, cwd, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const configured = await api("PATCH", `/api/bots/${created.body.bot.id}`, { cwd });
    expect(configured.status).toBe(200);
    return configured.body.bot;
  };
  const send = async (bot: any) => {
    const response = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.activeTaskId, text: "hold this isolated fixture turn" });
    expect(response.status).toBe(202);
  };
  try {
    // The default launcher intentionally strips system tools. Restart only its
    // exact disposable child with the git dependency; home/data/providers stay hermetic.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, fixture.info.dataDir, Number(new URL(fixture.info.url).port));
    env.PATH = [env.PATH, gitBin].join(delimiter);
    const log = openSync(fixture.info.logPath, "a", 0o600);
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
    const seed = await create("Checkpoint owner", project);
    await send(seed);
    await expect.poll(async () => (await api("GET", `/api/bots/${seed.id}/checkpoints?cwd=${encodeURIComponent(project)}`)).body.checkpoints.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await state(seed.id)).busy, { timeout: 15_000 }).toBe(false);
    const hash = (await api("GET", `/api/bots/${seed.id}/checkpoints?cwd=${encodeURIComponent(project)}`)).body.checkpoints[0].hash;
    unlinkSync(gate);
    writeFileSync(join(project, "work.txt"), "current work must survive refused restore");
    const aliasWriter = await create("Alias writer", alias);
    const nestedWriter = await create("Nested writer", nested);
    await send(aliasWriter);
    await send(nestedWriter);
    for (const bot of [aliasWriter, nestedWriter]) await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15_000 }).toBe(true);
    const restore = () => api("POST", `/api/bots/${seed.id}/checkpoints/restore`, { cwd: project, hash });
    expect(await restore()).toMatchObject({ status: 409, body: { error: expect.stringContaining("another thread") } });
    expect(readFileSync(join(project, "work.txt"), "utf8")).toBe("current work must survive refused restore");
    // Settling both releases all shared claims; a refused restore never leaked its lease.
    writeFileSync(gate, "finish writers");
    for (const bot of [aliasWriter, nestedWriter]) await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15_000 }).toBe(false);
    expect((await restore()).status).toBe(200);
    expect(readFileSync(join(project, "work.txt"), "utf8")).toBe("checkpoint version");
    // Room conversations must participate in the same canonical lease protocol.
    unlinkSync(gate);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "work.txt"), "room work must survive refused restore");
    const createdRoom = await api("POST", "/api/groups", {
      name: "Restore race room", memberIds: [aliasWriter.id],
      setup: { cwd: nested, bulletin: "Answer briefly.", defaultResponder: { kind: "member", botId: aliasWriter.id } },
    });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group;
    expect((await api("PATCH", `/api/groups/${room.id}`, { cwd: nested })).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hold this room fixture" })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((item: any) => item.id === room.id).working, { timeout: 15_000 }).toBe(true);
    expect(await restore()).toMatchObject({ status: 409, body: { error: expect.stringContaining("another thread") } });
    expect(readFileSync(join(project, "work.txt"), "utf8")).toBe("room work must survive refused restore");
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    writeFileSync(`${fixture.info.logPath}.restore-lock.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(`Restore-lock evidence: ${fixture.info.logPath}.restore-lock.json`);
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
