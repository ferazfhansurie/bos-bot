import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("resumes one unfinished shared room reply after a server crash", async () => {
  const gate = join("/tmp", `bos-restart-${randomUUID()}.gate`);
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  let restarted: ReturnType<typeof spawn> | null = null;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await api("POST", "/api/bots", {
      name: "Recovery bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const me = await api("GET", "/api/multiplayer/me");
    const dm = await api("POST", "/api/multiplayer/dm", { targetId: `${me.body.homeId}:bot:${created.body.bot.id}` });
    expect(dm.status).toBe(201);
    const roomId = dm.body.room.id as string;
    const sent = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "recover this reply", sendId: "restart-send-1" });
    expect(sent.status).toBe(201);
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
      return read.body.messages.some((message: any) => message.kind === "activity" && message.tool?.name === "working");
    }, { timeout: 10_000, interval: 100 }).toBe(true);
    fixture.child.kill("SIGKILL");
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) await once(fixture.child, "exit");
    // Release the orphaned fake CLI, then start a fresh server on the same
    // temporary data directory. The new fake CLI answers immediately.
    writeFileSync(gate, "finish");
    const port = Number(new URL(fixture.info.url).port);
    const env = verificationServerEnvironment({ ...process.env, FAKE_CLAUDE_MODE: "happy" }, fixture.info.dataDir, port);
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", join(process.cwd(), "server", "index.ts")], {
      cwd: process.cwd(), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api("GET", "/api/health")).status; } catch { return 0; }
    }, { timeout: 20_000, interval: 150 }).toBe(200);
    try {
      await expect.poll(async () => {
        const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
        return read.body.messages.filter((message: any) => message.actor.kind === "bot" && Boolean(message.text) && message.responseTo === sent.body.message.id).length;
      }, { timeout: 25_000, interval: 250 }).toBe(1);
    } catch (error) {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
      throw new Error(`recovery result: ${JSON.stringify(read.body.messages)}\n${readFileSync(fixture.info.logPath, "utf8").slice(-3000)}`, { cause: error });
    }
    const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
    expect(read.body.messages.filter((message: any) => message.sendId === "restart-send-1")).toHaveLength(1);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(gate, { force: true });
  }
}, 60_000);
