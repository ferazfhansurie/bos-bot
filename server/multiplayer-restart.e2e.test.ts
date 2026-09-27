import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("does not replay a dispatched shared request after a server crash", async () => {
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
    const queued = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "queued before restart", sendId: "restart-queued" });
    expect(queued.status).toBe(201);
    const queuedState = await api("GET", `/api/multiplayer/rooms/${roomId}/requests`);
    expect(queuedState.body.requests.find((item: any) => item.sourceId === queued.body.message.id)).toMatchObject({ state: "queued" });
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
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/requests`);
      return read.body.requests.find((item: any) => item.sourceId === sent.body.message.id)?.state;
    }, { timeout: 10_000, interval: 100 }).toBe("outcome-unknown");
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/requests`);
      return read.body.requests.find((item: any) => item.sourceId === queued.body.message.id)?.state;
    }, { timeout: 20_000, interval: 100 }).toBe("completed");
    // Retrying the original send receipt is delivery recovery, not authority
    // to repeat a request whose provider outcome is unknown.
    expect((await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "recover this reply", sendId: "restart-send-1" })).status).toBe(200);
    const deliberate = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "a new deliberate request", sendId: "restart-send-2" });
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/requests`);
      return read.body.requests.find((item: any) => item.sourceId === deliberate.body.message.id)?.state;
    }, { timeout: 25_000, interval: 250 }).toBe("completed");
    const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
    expect(read.body.messages.filter((message: any) => message.sendId === "restart-send-1")).toHaveLength(1);
    expect(read.body.messages.filter((message: any) => message.actor.kind === "bot" && Boolean(message.text) && message.responseTo === sent.body.message.id)).toHaveLength(0);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(gate, { force: true });
  }
}, 60_000);
