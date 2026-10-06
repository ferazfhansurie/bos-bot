import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("resumes a scoped interrupted private turn once through the paired-client route", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const finishGate = join(dataDir, "resume-finish");
  const env = { ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate };
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const restart = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], { env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Resume fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const pair = (await api("POST", "/api/auth/pairing", { scopes: ["client"] })).body;
    const client = (await api("POST", "/api/auth/pair", { code: pair.code, label: "Resume fixture phone" })).body;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "original request", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 15000 }).toBe(false);
    const source = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages.find((m: any) => m.role === "user");
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // Seed a dead host's authority record only while its isolated server is stopped.
    const receipt = { id: "interrupted-fixture-receipt", botId: bot.id, threadId: bot.threadId, sourceId: source.id, state: "outcome-unknown", createdAt: Date.now() };
    const other = { ...receipt, id: "other-interrupted-receipt" };
    const grouped = { ...receipt, id: "group-receipt", groupId: "wrong-group" };
    writeFileSync(join(dataDir, "private-turn-dispatches.json"), JSON.stringify({ version: 1, records: [receipt, other, grouped] }));
    await restart();
    const path = `/api/bots/${bot.id}/threads/${bot.threadId}/recovery/${receipt.id}/resume`;
    const sendId = `recovery-resume-${createHash("sha256").update(receipt.id).digest("hex")}`;
    expect((await api("POST", path.replace(bot.threadId, "wrong-thread"), undefined, client.token)).status).toBe(404);
    expect((await api("POST", path.replace(receipt.id, "missing-receipt"), undefined, client.token)).status).toBe(404);
    expect((await api("POST", path.replace(receipt.id, grouped.id), undefined, client.token)).status).toBe(404);
    const results = await Promise.all([api("POST", path, undefined, client.token), api("POST", path, undefined, client.token)]);
    expect(results.map(result => result.status)).toEqual([202, 202]);
    expect(results[0]!.body.message.id).toBe(results[1]!.body.message.id);
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
    const continuations = messages.filter((m: any) => m.role === "user" && m.sendId === sendId);
    expect(continuations).toHaveLength(1);
    expect(continuations[0].replyToId).toBe(source.id);
    expect(continuations[0].text).toContain("check what already happened");
    // Resume is an explicit new request, not a claim that the old effects were reviewed.
    expect(JSON.parse(readFileSync(join(dataDir, "private-turn-dispatches.json"), "utf8")).records.find((r: any) => r.id === receipt.id)).toEqual(receipt);
    expect((await api("POST", path.replace(receipt.id, other.id), undefined, client.token)).status).toBe(409);
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "private-turn-dispatches.json"), "utf8")).records.some((r: any) => r.state === "dispatching"), { timeout: 15000 }).toBe(true);
    const active = JSON.parse(readFileSync(join(dataDir, "private-turn-dispatches.json"), "utf8")).records.find((r: any) => r.state === "dispatching");
    expect((await api("POST", path.replace(receipt.id, active.id), undefined, client.token)).status).toBe(409);
    writeFileSync(finishGate, "finish");
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 15000 }).toBe(false);
    await waitForExit(restarted, { signal: "SIGTERM" });
    await restart();
    expect((await api("POST", path, undefined, client.token)).body.message.id).toBe(continuations[0].id);
    const after = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
    expect(after.filter((m: any) => m.sendId === sendId)).toHaveLength(1);
  } finally {
    writeFileSync(finishGate, "finish");
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 60000);
