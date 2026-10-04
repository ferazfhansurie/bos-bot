import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateCoordinator, pendingUpdates, readCheckpoint, type BusyTurn, type CheckpointTurn, type ExecutorPlan, type UpdateEvent, type UpdateResult, type UpdaterHooks } from "./updater.ts";
import { createElectronUpdateExecutor, type UpdatePort } from "./updater-executor-electron.ts";

const SHA512 = "ab".repeat(64);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Port's Electron side (dev/port-updater-win). Point at their worktree to run the integration half here.
const CONTRACT_PATH = process.env.OMB_WINDOWS_UPDATE_CONTRACT || join(SERVER_DIR, "..", "electron", "windows-update-contract.mjs");

/** Both ends of the utility-process port: the server posts, "main" answers on the next tick. */
function fakePort(main: (message: Record<string, unknown>, reply: (body: Record<string, unknown>) => void) => void) {
  const listeners: Array<(event: { data?: object }) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const port: UpdatePort = {
    on: (_event, listener) => { listeners.push(listener); },
    postMessage: message => {
      const request = message as Record<string, unknown>;
      sent.push(request);
      setImmediate(() => main(request, body => { for (const listener of listeners) listener({ data: { type: `${request.type}-result`, requestId: request.requestId, ...body } }); }));
    },
  };
  return { port, sent, deliver: (data: object) => { for (const listener of listeners) listener({ data }); } };
}

interface Harness { dataDir: string; events: UpdateEvent[]; turns: BusyTurn[]; stopped: number; quiesced: number; unquiesced: number; resumed: Array<{ turn: CheckpointTurn; result: UpdateResult }>; make(overrides?: Partial<UpdaterHooks>): UpdateCoordinator; settle(): Promise<void> }
function harness(root: string, executor: UpdaterHooks["executor"]): Harness {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const h: Harness = {
    dataDir, events: [], turns: [], stopped: 0, quiesced: 0, unquiesced: 0, resumed: [],
    make: (overrides = {}) => new UpdateCoordinator({
      dataDir, executor,
      current: () => ({ version: "1.2.0", sha: "2d83ba23aaaaaaaa" }),
      listBusyTurns: () => [...h.turns],
      stopAll: async () => { h.stopped++; h.turns = []; },
      checkpointExtras: () => ({ steers: {}, delegations: [] }),
      quiesce: async () => { h.quiesced++; },
      unquiesce: () => { h.unquiesced++; },
      emit: event => { h.events.push(event); },
      resumeTurn: async (turn, result) => { h.resumed.push({ turn, result }); return "resumed"; },
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
      stopWaitMs: 5_000, resultWaitMs: 3_000, ...overrides,
    }),
    async settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 10)); },
  };
  return h;
}

describe("electron update executor (win32 seam, fake main)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bos-electron-updater-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("without a parent port it is not an updater at all", async () => {
    const executor = createElectronUpdateExecutor({ port: undefined, serverPort: 8799 });
    expect(await executor.candidate()).toBeNull();
    await expect(executor.admit("restart")).rejects.toMatchObject({ status: 409, message: /not running inside the desktop app/ });
    const h = harness(root, executor);
    expect((await h.make().status()).state).toBe("idle");
    await expect(h.make().restart()).rejects.toMatchObject({ status: 409 });
  });

  it("speaks the three private pairs by requestId and carries main's installer sha through untouched", async () => {
    const executes: Array<Record<string, unknown>> = [];
    const { port, sent } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") reply({ candidate: { version: "1.3.0", sha: SHA512, stagedAt: "2026-10-04T10:00:00.000Z" } });
      else if (message.type === "openmausbot:update-admit") reply({ ok: true });
      else { executes.push(message); reply({ ok: true }); }
    });
    const executor = createElectronUpdateExecutor({ port, serverPort: 18799, extraPorts: [18812], checkPort: async port => port === 18812 });
    const h = harness(root, executor);
    const c = h.make();
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct", title: "fix the thing" }];
    const status = await c.status();
    expect(status).toMatchObject({ state: "ready", candidate: { version: "1.3.0", sha: SHA512 } });
    expect(status.candidate!.sha).toHaveLength(128);
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    expect(h.events.map(e => e.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(h.events.every(e => e.kind === "update.state" && e.type === "update.state" && e.updateId === updateId)).toBe(true);
    expect(h.stopped).toBe(1); expect(h.quiesced).toBe(1);
    expect(sent.map(m => m.type)).toEqual(["openmausbot:update-candidate", "openmausbot:update-candidate", "openmausbot:update-admit", "openmausbot:update-execute"]);
    expect(sent.every(m => typeof m.requestId === "string" && (m.requestId as string).length > 0 && (m.requestId as string).length <= 100)).toBe(true);
    expect(sent[2]).toMatchObject({ mode: "update" });
    const plan = executes[0].plan as ExecutorPlan;
    expect(Object.keys(plan).sort()).toEqual(["force", "gracefulSeconds", "health", "healthSeconds", "installedPath", "mode", "oldSha", "oldVersion", "ports", "resultPath", "sha", "updateId", "version"]);
    expect(plan).toMatchObject({ updateId, mode: "update", version: "1.3.0", sha: SHA512, oldVersion: "1.2.0", oldSha: "2d83ba23aaaaaaaa", force: true, ports: [18799, 18812], health: "http://127.0.0.1:18799/api/health", gracefulSeconds: 45, healthSeconds: 90, resultPath: join(h.dataDir, "updates", updateId, "result.json"), installedPath: join(h.dataDir, "updates", "installed.json") });
    expect(readCheckpoint(h.dataDir, updateId)!.turns).toHaveLength(1);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(pendingUpdates(h.dataDir)).toEqual([updateId]);
  });

  it("ignores stray or mismatched replies", async () => {
    const { port, deliver } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") {
        deliver({ type: "openmausbot:update-candidate-result", requestId: "someone-else", candidate: { version: "9", sha: "x", stagedAt: "y" } });
        deliver({ type: "openmausbot:update-admit-result", requestId: message.requestId, ok: true });
        deliver({ type: "openmausbot:update-candidate-result", candidate: { version: "9", sha: "x", stagedAt: "y" } });
        reply({ candidate: { version: "1.3.0", sha: SHA512, stagedAt: "now" } });
      }
    });
    const executor = createElectronUpdateExecutor({ port, serverPort: 1 });
    expect(await executor.candidate()).toEqual({ version: "1.3.0", sha: SHA512, stagedAt: "now" });
    const { port: bad } = fakePort((_m, reply) => reply({ candidate: { version: "1.3.0", sha: "" } }));
    expect(await createElectronUpdateExecutor({ port: bad, serverPort: 1 }).candidate()).toBeNull();
  });

  it("turns an admission refusal into a 409 with main's words, before anything is checkpointed", async () => {
    const { port } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") reply({ candidate: null });
      else reply({ ok: false, error: "Windows update is already pending", status: 409 });
    });
    const h = harness(root, createElectronUpdateExecutor({ port, serverPort: 18799 }));
    await expect(h.make().restart()).rejects.toMatchObject({ status: 409, message: "Windows update is already pending" });
    expect(h.events).toEqual([]);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
  });

  it("an execute refusal with pending:true keeps the lock, the quiesce and the applying state, and never retries", async () => {
    let executes = 0;
    const { port } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") reply({ candidate: null });
      else if (message.type === "openmausbot:update-admit") reply({ ok: true });
      else { executes++; reply({ ok: false, error: "Windows install was not dispatched", status: 409, pending: true }); }
    });
    const h = harness(root, createElectronUpdateExecutor({ port, serverPort: 18799 }));
    const c = h.make();
    const { updateId } = await c.restart({ force: true });
    await h.settle();
    expect(executes).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ state: "applying", detail: /handoff uncertain: Windows install was not dispatched/ });
    expect(c.active).toBe(true); expect(h.quiesced).toBe(1); expect(h.unquiesced).toBe(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(await c.restart({ force: true })).toEqual({ updateId, inProgress: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(executes).toBe(1);
    expect((await c.status()).state).toBe("applying");
    expect(pendingUpdates(h.dataDir)).toEqual([updateId]);
  });

  it("silence after execute is treated as pending too; a refusal before the hold is not", async () => {
    const { port } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") reply({ candidate: null });
      else if (message.type === "openmausbot:update-admit") reply({ ok: true });
      /* execute: main is already quitting us */
    });
    const h = harness(root, createElectronUpdateExecutor({ port, serverPort: 18799, timeoutMs: { execute: 50 } }));
    const c = h.make();
    await c.restart({ force: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.events.at(-1)).toMatchObject({ state: "applying", detail: /did not confirm the handoff/ });
    expect(c.active).toBe(true); expect(h.unquiesced).toBe(0);

    const { port: refusing } = fakePort((message, reply) => {
      if (message.type === "openmausbot:update-candidate") reply({ candidate: null });
      else if (message.type === "openmausbot:update-admit") reply({ ok: true });
      else reply({ ok: false, error: "Invalid Windows update plan", status: 409 });
    });
    const h2 = harness(join(root, "two"), createElectronUpdateExecutor({ port: refusing, serverPort: 18799 }));
    const c2 = h2.make();
    await c2.restart({ force: true });
    await h2.settle();
    expect(c2.active).toBe(false);
    expect(h2.events.at(-1)).toMatchObject({ state: "failed", detail: "Invalid Windows update plan" });
    expect(h2.unquiesced).toBe(1);
    expect(pendingUpdates(h2.dataDir)).toEqual([]);
  });
});

describe.skipIf(!existsSync(CONTRACT_PATH))("electron update executor against main's real windows-update-contract", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bos-electron-contract-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // Untyped .mjs: only the surface this test touches.
  interface ContractModule {
    createWindowsUpdateResultWriter(options: { dataDir: string; currentVersion: () => string; hostPid: number; hostId: string; verifyHealth: (plan: ExecutorPlan) => Promise<boolean> }): { readPending(): { hostId: string; plan: ExecutorPlan } | null; complete(): Promise<void>; validate(plan: unknown): ExecutorPlan; persistPlan(plan: unknown): void };
    createCheckpointUpdateLifecycle(options: { dataDir: string; isOwned: () => boolean; recordIntent: (plan: ExecutorPlan) => Promise<void> }): { prepareInstall(plan: ExecutorPlan): Promise<void> };
    createWindowsUpdateContract(options: { coordinator: unknown; lifecycleClient: unknown; relaunch: () => void; resultWriter: unknown; log?: (line: string) => void }): { receive(proc: { postMessage(m: object): void }, message: object): boolean; onServerHealthy(): Promise<void> };
  }
  interface MainSide {
    candidate: { version: string; sha: string; stagedAt: string } | null;
    refuseAdmission?: string; dispatchFails?: string;
    atExecute?: () => void;
  }
  /** Main as the contract wants it: coordinator facade, checkpoint lifecycle, result writer for one host generation. */
  async function main(dataDir: string, side: MainSide, hostId: string) {
    const contract = await import(pathToFileURL(CONTRACT_PATH).href) as ContractModule;
    const writer = contract.createWindowsUpdateResultWriter({ dataDir, currentVersion: () => side.candidate?.version ?? "1.2.0", hostPid: process.pid, hostId, verifyHealth: async () => true });
    const relaunches: number[] = [];
    const installs: ExecutorPlan[] = [];
    const seen: Array<{ stopped: number; quiesced: number }> = [];
    const coordinator = {
      candidate: () => side.candidate,
      admit: () => { if (side.refuseAdmission) throw Object.assign(new Error(side.refuseAdmission), { status: 409 }); },
      hold: () => {},
      install: async ({ prepareInstall }: { prepareInstall: () => Promise<void> }) => {
        await prepareInstall();
        if (side.dispatchFails) return { dispatched: false, error: side.dispatchFails };
        side.atExecute?.();
        return { dispatched: true };
      },
    };
    const lifecycleClient = contract.createCheckpointUpdateLifecycle({ dataDir, isOwned: () => true, recordIntent: async (plan: ExecutorPlan) => { installs.push(plan); } });
    const instance = contract.createWindowsUpdateContract({ coordinator, lifecycleClient, relaunch: () => { relaunches.push(Date.now()); side.atExecute?.(); }, resultWriter: writer, log: () => {} });
    return { instance, writer, relaunches, installs, seen };
  }
  function bridge(receive: (proc: { postMessage(m: object): void }, message: object) => boolean) {
    const listeners: Array<(event: { data?: object }) => void> = [];
    const proc = { postMessage: (message: object) => { setImmediate(() => { for (const listener of listeners) listener({ data: message }); }); } };
    const port: UpdatePort = { on: (_event, listener) => { listeners.push(listener); }, postMessage: message => { setImmediate(() => receive(proc, message)); } };
    return port;
  }

  it("ready status, 202, checkpoint+stop+quiesce before execute, pending hold, result on the next generation resumes once", async () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const side: MainSide = { candidate: { version: "1.3.0", sha: SHA512, stagedAt: "2026-10-04T10:00:00.000Z" } };
    const gen1 = await main(dataDir, side, "host-1");
    const h = harness(root, createElectronUpdateExecutor({ port: bridge(gen1.instance.receive), serverPort: 18799 }));
    side.atExecute = () => gen1.seen.push({ stopped: h.stopped, quiesced: h.quiesced });
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct", title: "fix the thing" }, { botId: "b2", threadId: "g1", kind: "room", groupId: "geng" }];
    const c = h.make();
    expect(await c.status()).toMatchObject({ state: "ready", candidate: { version: "1.3.0", sha: SHA512 }, busyTurns: [{ botId: "b1", threadId: "t1" }, { botId: "b2", threadId: "g1" }] });
    const { updateId } = await c.apply({ force: true });
    expect(updateId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(c.apply({ force: true })).resolves.toEqual({ updateId, inProgress: true });
    await h.settle();
    expect(h.events.map(e => e.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(h.events.every(e => e.kind === "update.state" && e.type === "update.state")).toBe(true);
    // main saw the stopped checkpoint and the quiesced workspace before it dispatched
    expect(gen1.seen).toEqual([{ stopped: 1, quiesced: 1 }]);
    expect(gen1.installs).toHaveLength(1);
    expect(gen1.installs[0]).toMatchObject({ updateId, version: "1.3.0", sha: SHA512, health: "http://127.0.0.1:18799/api/health" });
    expect(readCheckpoint(h.dataDir, updateId)!.stoppedAt).toBeTruthy();
    expect(gen1.writer.readPending()).toMatchObject({ hostId: "host-1", plan: { updateId } });
    // we are "quitting" now: the lock and the pending plan survive into the next generation
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(pendingUpdates(h.dataDir)).toEqual([updateId]);
    expect(c.active).toBe(true);
    // same generation cannot complete it
    await gen1.writer.complete();
    expect(existsSync(join(h.dataDir, "updates", updateId, "result.json"))).toBe(false);

    // next host generation: main verifies health, writes installed + result, server boots and resumes once
    const gen2 = await main(dataDir, side, "host-2");
    const h2 = harness(root, createElectronUpdateExecutor({ port: bridge(gen2.instance.receive), serverPort: 18799 }));
    const booted = h2.make();
    const boot = booted.boot();
    await h2.settle();
    expect(h2.events.at(-1)).toMatchObject({ state: "verifying", updateId });
    await gen2.instance.onServerHealthy();
    await boot;
    expect(JSON.parse(readFileSync(join(dataDir, "updates", "installed.json"), "utf8"))).toEqual({ version: "1.3.0", sha: SHA512 });
    expect(h2.events.at(-1)).toMatchObject({ state: "done", updateId, detail: /updated to 1\.3\.0/ });
    expect(h2.resumed.map(r => [r.turn.botId, r.turn.threadId])).toEqual([["b1", "t1"], ["b2", "g1"]]);
    expect(h2.resumed[0].result).toMatchObject({ state: "done", version: "1.3.0", sha: SHA512 });
    expect(await booted.status()).toMatchObject({ state: "ready", lastResult: { state: "done", version: "1.3.0", sha: SHA512 } });
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    expect(gen2.writer.readPending()).toBeNull();
    const again = h2.make();
    await again.boot();
    expect(h2.resumed).toHaveLength(2);
  });

  it("restart returns 202 and relaunches without an installer", async () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const gen1 = await main(dataDir, { candidate: null }, "host-1");
    const h = harness(root, createElectronUpdateExecutor({ port: bridge(gen1.instance.receive), serverPort: 18799 }));
    const c = h.make();
    expect((await c.status()).state).toBe("idle");
    await expect(c.apply()).rejects.toMatchObject({ status: 409, message: /no staged update/ });
    const { updateId } = await c.restart({ force: true });
    await h.settle();
    expect(gen1.relaunches).toHaveLength(1);
    expect(gen1.installs[0]).toMatchObject({ updateId, mode: "restart", version: "1.2.0", sha: "2d83ba23aaaaaaaa" });
    expect(h.events.at(-1)).toMatchObject({ state: "applying", detail: "restarting" });
    expect(c.active).toBe(true);
  });

  it("main's admission refusal is a 409 before any checkpoint; a failed dispatch after the hold stays locked", async () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const side: MainSide = { candidate: { version: "1.3.0", sha: SHA512, stagedAt: "now" }, refuseAdmission: "Windows update is already pending" };
    const gen1 = await main(dataDir, side, "host-1");
    const h = harness(root, createElectronUpdateExecutor({ port: bridge(gen1.instance.receive), serverPort: 18799 }));
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: "Windows update is already pending" });
    expect(h.events).toEqual([]); expect(h.quiesced).toBe(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);

    delete side.refuseAdmission; side.dispatchFails = "installer process did not start";
    const c = h.make();
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({ state: "applying", detail: /handoff uncertain: installer process did not start/ });
    expect(c.active).toBe(true); expect(h.quiesced).toBe(1); expect(h.unquiesced).toBe(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(gen1.writer.readPending()).toMatchObject({ plan: { updateId } });
    await expect(c.apply({ force: true })).resolves.toEqual({ updateId, inProgress: true });
  });
});
