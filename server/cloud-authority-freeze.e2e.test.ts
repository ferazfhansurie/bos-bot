// BOS 2.0 slice 5: the legacy writer freeze, through the real server in an
// isolated fake-engine fixture. The flag is written into the fixture's own
// temporary data dir, never the user's.
import { existsSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

it("refuses room/message writes and bot dispatch while frozen, keeps reads, and lifts on rollback", async () => {
  const fixture = await launchVerificationServer();
  const flag = join(fixture.info.dataDir, "cloud-authority.json");
  let stamp = Date.now();
  const setFlag = (text: string) => {
    writeFileSync(flag, text);
    stamp += 2_000;
    utimesSync(flag, new Date(stamp), new Date(stamp));
  };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(path.startsWith("http") ? path : `${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const messages = async (threadId: string) => (await call("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  try {
    const created = await call("POST", "/api/bots", { name: "Freeze fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const room = await call("POST", "/api/groups", { name: "Freeze room", memberIds: [bot.id] });
    expect(room.status).toBe(201);
    const groupId = room.body.group.id as string;
    const { body: hook } = await call("POST", "/api/webhooks", { name: "Freeze hook", botId: bot.id, prompt: "Summarize the event.", enabled: true });
    const { body: { routine } } = await call("POST", "/api/routines", { name: "Freeze routine", botId: bot.id, prompt: "Report.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });

    // No flag, invalid JSON, and non-freezing states: writes are accepted.
    for (const text of [null, "{not json", JSON.stringify({ workspace_id: "ws_live", epoch: 2, state: "inventoried" }),
      JSON.stringify({ workspace_id: "ws_live", epoch: 2, state: "failed" }), JSON.stringify({ workspace_id: "ws_live", epoch: 2, state: "held" })]) {
      if (text === null) expect(existsSync(flag)).toBe(false); else setFlag(text);
      const renamed = await call("PATCH", `/api/groups/${groupId}`, { name: `Freeze room ${text?.length ?? 0}` });
      expect(renamed.status, String(text)).toBe(200);
    }

    // The first frozen state: one message write dispatches nothing.
    const before = statSync(fixture.fixtureDumpPath, { throwIfNoEntry: false })?.mtimeMs ?? null;
    const sentBefore = (await messages(bot.threadId)).length;
    for (const [state, epoch] of [["frozen", 7], ["imported", "8"], ["validated", 9], ["cloud_active", 10], ["legacy_archived", 11]] as const) {
      setFlag(JSON.stringify({ workspace_id: "ws_cloud_1", epoch, state }));
      const refusal = { error: "authority_moved", workspace_id: "ws_cloud_1", epoch };
      // Message writes, direct and in a room.
      expect(await call("POST", `/api/bots/${bot.id}/messages`, { text: `frozen ${state}` })).toEqual({ status: 409, body: refusal });
      expect(await call("POST", `/api/groups/${groupId}/messages`, { text: `@${bot.name} frozen ${state}` })).toEqual({ status: 409, body: refusal });
      // Room writes.
      expect(await call("POST", "/api/groups", { name: `Room while ${state}`, memberIds: [bot.id] })).toEqual({ status: 409, body: refusal });
      expect(await call("PATCH", `/api/groups/${groupId}`, { name: "renamed while frozen" })).toEqual({ status: 409, body: refusal });
      expect(await call("DELETE", `/api/groups/${groupId}`)).toEqual({ status: 409, body: refusal });
      // Dispatch triggers.
      expect(await call("POST", `/api/routines/${routine.id}/run`)).toEqual({ status: 409, body: refusal });
      expect(await call("POST", hook.credential.endpointUrl, { event: state }, { authorization: `Bearer ${hook.credential.secret}` }))
        .toEqual({ status: 409, body: refusal });
      // A sender without the secret learns nothing about the migration.
      expect((await call("POST", hook.credential.endpointUrl, { event: state }, { authorization: "Bearer wrong" })).status).toBe(401);
      // Reads still work.
      expect((await call("GET", "/api/bots?messages=0")).status).toBe(200);
      expect((await call("GET", `/api/threads/${bot.threadId}/messages`)).status).toBe(200);
      expect((await call("GET", `/api/threads/${room.body.group.threadId}/messages`)).status).toBe(200);
      expect((await call("GET", "/api/routines")).status).toBe(200);
    }
    // Nothing was written or dispatched: no new transcript rows, no engine launch, no run.
    expect((await messages(bot.threadId)).length).toBe(sentBefore);
    expect(statSync(fixture.fixtureDumpPath, { throwIfNoEntry: false })?.mtimeMs ?? null).toBe(before);
    expect((await call("GET", "/api/routines")).body.runs.filter((run: any) => run.routineId === routine.id)).toEqual([]);
    expect((await call("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === groupId)).toBeTruthy();

    // Rollback before cloud_active clears the flag: writes and dispatch resume without a restart.
    rmSync(flag);
    const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text: "after rollback" });
    expect(sent.status).toBe(202);
    await expect.poll(async () => (await messages(bot.threadId)).some((message) => message.role === "bot" && message.kind === "text"),
      { timeout: 20_000 }).toBe(true);
    expect((await call("PATCH", `/api/groups/${groupId}`, { name: "renamed after rollback" })).status).toBe(200);
  } finally {
    await fixture.close();
  }
}, 90_000);

it("defers a scheduled routine while frozen and runs it after the flag is removed", async () => {
  const fixture = await launchVerificationServer();
  const flag = join(fixture.info.dataDir, "cloud-authority.json");
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const { body: { bot } } = await call("POST", "/api/bots", { name: "Background freeze", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    writeFileSync(flag, JSON.stringify({ workspace_id: "ws_cloud_2", epoch: 1, state: "frozen" }));
    const { status, body: { routine } } = await call("POST", "/api/routines", { name: "Background run", botId: bot.id, prompt: "Report.", enabled: true,
      schedule: { type: "once", at: Date.now() + 1_000 } });
    expect(status).toBe(201);
    const run = async () => (await call("GET", "/api/routines")).body.runs.find((item: any) => item.routineId === routine.id);
    // The scheduler queues the occurrence but the frozen bot reads as busy: deferred, never dispatched.
    await expect.poll(async () => (await run())?.deferredAt ?? null, { timeout: 30_000, interval: 500 }).not.toBeNull();
    expect(await run()).toMatchObject({ status: "queued" });
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    rmSync(flag);
    await expect.poll(async () => (await run())?.status, { timeout: 30_000, interval: 500 }).toBe("completed");
  } finally {
    await fixture.close();
  }
}, 90_000);
