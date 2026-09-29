import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("holds ordinary private work after a dead server without replaying or losing its history", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-crash-"));
  const env = { ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(root, "never-finish"), FAKE_CLAUDE_PROMPTS: join(root, "prompts.ndjson") };
  const fixture = await launchVerificationServer(env);
  let restarted: ChildProcess | undefined;
  const providerPids: number[] = [];
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const journal = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "private-turn-dispatches.json"), "utf8"));
  try {
    const bots = [];
    for (const name of ["Private alpha", "Private beta"]) {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
      bots.push(bot);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `uncertain work for ${name}`, threadId: bot.threadId, sendId: `private-${bot.id}` })).status).toBe(202);
      await expect.poll(() => { try { const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); if (providerPids.includes(dump.pid)) return false; providerPids.push(dump.pid); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    }
    const roomBot = (await api("POST", "/api/bots", { name: "Room gamma", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Uncertain room", memberIds: [roomBot.id], setup: { bulletin: "Brief fixture reply.", defaultResponder: { kind: "member", botId: roomBot.id } } })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "uncertain ordinary room work" })).status).toBe(202);
    await expect.poll(() => { try { const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); if (providerPids.includes(dump.pid)) return false; providerPids.push(dump.pid); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    bots.push({ ...roomBot, threadId: room.threadId });
    await expect.poll(() => { try { return journal().records.length; } catch { return 0; } }, { timeout: 15_000 }).toBe(3);
    await expect.poll(() => { try { return journal().records.filter((row: any) => row.providerTurnId).length; } catch { return 0; } }, { timeout: 15_000 }).toBe(3);
    const before = journal();
    evidence.push({ beforeKill: before });
    expect(before.records.every((row: any) => row.workspace === `workspace:${row.cwd}`)).toBe(true);
    await expect.poll(() => existsSync(env.FAKE_CLAUDE_PROMPTS) ? readFileSync(env.FAKE_CLAUDE_PROMPTS, "utf8").trim().split("\n").length : 0, { timeout: 15_000 }).toBe(3);
    await waitForExit(fixture.child, { signal: "SIGKILL" });
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: process.cwd(), env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
    evidence.push({ afterRestart: journal() });
    expect(journal().records.map((row: any) => row.state)).toEqual(["outcome-unknown", "outcome-unknown", "outcome-unknown"]);
    for (const bot of bots) {
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
      expect(messages.filter((row: any) => row.role === "user")).toHaveLength(1);
      expect(messages).toContainEqual(expect.objectContaining({ turnTerminal: true, turnOutcome: { ok: false, stopReason: "outcome-unknown" }, tool: expect.objectContaining({ name: expect.stringContaining("outcome is unknown") }) }));
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(readFileSync(env.FAKE_CLAUDE_PROMPTS, "utf8").trim().split("\n")).toHaveLength(3);
    expect(journal().records.map((row: any) => row.id)).toEqual(before.records.map((row: any) => row.id));
    expect((await api("GET", "/api/bots?messages=0")).body.bots.every((bot: any) => !bot.busy)).toBe(true);
  } finally {
    // A killed server cannot close an orphan fake provider. Finish only this
    // fixture gate, then clean exact PIDs captured from its own dump.
    writeFileSync(env.FAKE_CLAUDE_SLOW_FINISH_GATE, "finish owned fake providers");
    for (const pid of providerPids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    await waitForExit(restarted, { signal: "SIGTERM" });
    writeFileSync(`${fixture.info.logPath}.private-turn.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(`Private-turn evidence: ${fixture.info.logPath}.private-turn.json`);
    await fixture.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);


it("does not invoke the fake provider when the pre-dispatch journal cannot be committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-write-fail-"));
  const prompts = join(root, "prompts.ndjson");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_PROMPTS: prompts });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    mkdirSync(join(fixture.info.dataDir, "private-turn-dispatches.json"));
    const bot = (await api("POST", "/api/bots", { name: "Blocked dispatch", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "must not dispatch without durable receipt", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages.some((message: any) => message.tool?.name.startsWith("error:")), { timeout: 15_000 }).toBe(true);
    expect(existsSync(prompts)).toBe(false);
  } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
