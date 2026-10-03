import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UpdateCoordinator, appDigests, classifyLaunchdJobs, discoverCandidate, pendingUpdates, readCheckpoint, resumePrompt,
  updaterPlist, writeCandidateManifest, type BusyTurn, type CheckpointTurn, type UpdateEvent, type UpdateResult, type UpdaterHooks, type UpdaterHost,
} from "./updater.ts";

function fakeApp(root: string, name: string, stamp: string): string {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui", "assets"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), `// server ${stamp}\n`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), `<html>${stamp}</html>`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "assets", "app.js"), `console.log(${JSON.stringify(stamp)})`);
  writeFileSync(join(app, "Contents", "MacOS", "BOS Bot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return app;
}

interface Harness {
  dataDir: string; live: string; events: UpdateEvent[]; turns: BusyTurn[]; stopped: number; quiesced: number; unquiesced: number;
  launchd: string; bootstraps: string[]; bootouts: string[]; resumed: Array<{ turn: CheckpointTurn; result: UpdateResult }>;
  make(overrides?: Partial<UpdaterHooks>): UpdateCoordinator;
  settle(): Promise<void>;
}

function harness(root: string): Harness {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const live = fakeApp(join(root, "Applications"), "BOS Bot.app", "old");
  const h: Harness = {
    dataDir, live, events: [], turns: [], stopped: 0, quiesced: 0, unquiesced: 0, launchd: "PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n",
    bootstraps: [], bootouts: [], resumed: [],
    make(overrides = {}) {
      const host: UpdaterHost = {
        launchdList: async () => h.launchd,
        bootstrap: async (_uid, plist) => { h.bootstraps.push(plist); },
        bootout: async (_uid, label) => { h.bootouts.push(label); },
        listeningPorts: async () => [18799],
        appProcess: async () => ({ pid: 4242, identity: "Fri Oct  3 19:58:01 2026 /Applications/BOS Bot.app/Contents/MacOS/BOS Bot" }),
      };
      return new UpdateCoordinator({
        dataDir, liveApp: live, host,
        current: () => ({ version: "0.1.85", sha: "2d83ba23aaaaaaaa" }),
        listBusyTurns: () => [...h.turns],
        stopAll: async () => { h.stopped++; h.turns = []; },
        checkpointExtras: () => ({ steers: { t1: [{ queueId: "q1" }] }, delegations: [] }),
        quiesce: async () => { h.quiesced++; },
        unquiesce: () => { h.unquiesced++; },
        emit: event => { h.events.push(event); },
        resumeTurn: async (turn, result) => { h.resumed.push({ turn, result }); return "resumed"; },
        sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
        stopWaitMs: 5_000, resultWaitMs: 3_000, requireLaunchd: false, codesign: false, uid: 501,
        ...overrides,
      });
    },
    async settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 10)); },
  };
  return h;
}

function stage(h: Harness, stamp = "new") {
  const dir = join(h.dataDir, "updates", "candidate");
  fakeApp(dir, "BOS Bot.app", stamp);
  return writeCandidateManifest(dir, { version: "0.1.86", sha: "feedface00000000", app: "BOS Bot.app" });
}

describe("updater coordinator", () => {
  let root: string; let h: Harness;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bos-updater-")); h = harness(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("hashes bundle trees deterministically and discovers a staged candidate", () => {
    expect(discoverCandidate(h.dataDir)).toBeNull();
    const manifest = stage(h);
    const found = discoverCandidate(h.dataDir)!;
    expect(found.version).toBe("0.1.86");
    expect(found.serverSha256).toBe(manifest.serverSha256);
    expect(appDigests(found.appPath)).toEqual({ server: manifest.serverSha256, ui: manifest.uiSha256 });
    expect(appDigests(h.live).server).not.toBe(manifest.serverSha256);
    expect(h.make().status()).toMatchObject({ state: "ready", candidate: { version: "0.1.86", sha: "feedface00000000" }, current: { version: "0.1.85" } });
  });

  it("is idle without a candidate and refuses to apply", async () => {
    const c = h.make();
    expect(c.status().state).toBe("idle");
    await expect(c.apply()).rejects.toMatchObject({ status: 409, message: /no staged update/ });
    expect(h.events).toEqual([]);
  });

  it("refuses while another installer or keepalive job exists, but clears its own finished jobs", async () => {
    stage(h);
    h.launchd = "PID\tStatus\tLabel\n812\t0\tai.bos.bos.restart-now-179104\n";
    await expect(h.make().apply()).rejects.toMatchObject({ status: 409, message: /restart-now-179104/ });
    h.launchd = "PID\tStatus\tLabel\n-\t0\tai.bos.bot.update.deadbeef\n";
    const c = h.make();
    await c.apply({ force: true });
    await h.settle();
    expect(h.bootouts).toEqual(["ai.bos.bot.update.deadbeef"]);
    expect(h.bootstraps).toHaveLength(1);
  });

  it("classifies launchd rows", () => {
    expect(classifyLaunchdJobs("PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n99\t0\tai.bos.bot.update.11111111\n-\t0\tai.bos.bot.update.22222222\n7\t0\tai.bos.steer.keepalive\n-\t0\tcom.openmausbot.installer\n"))
      // A loaded foreign installer blocks even between runs: KeepAlive jobs sit at "-" while launchd respawns them.
      .toEqual({ blocking: ["ai.bos.bot.update.11111111", "ai.bos.steer.keepalive", "com.openmausbot.installer"], staleOwn: ["ai.bos.bot.update.22222222"] });
  });

  it("checkpoints, stops, quiesces and hands launchd a one-shot job whose script hash is pinned", async () => {
    stage(h);
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct", title: "fix the thing" }, { botId: "b2", threadId: "g1", kind: "room", groupId: "geng" }];
    const c = h.make();
    const { updateId } = await c.apply({ force: true });
    expect(c.status().updateId).toBe(updateId);
    expect(["checkpointing", "stopping"]).toContain(c.status().state);
    await expect(c.apply({ force: true })).rejects.toMatchObject({ status: 409 });
    await h.settle();
    expect(h.events.map(e => e.state)).toEqual(["checkpointing", "stopping", "applying"]);
    expect(h.events.every(e => e.kind === "update.state" && e.type === "update.state" && e.updateId === updateId)).toBe(true);
    expect(h.stopped).toBe(1); expect(h.quiesced).toBe(1);
    const dir = join(h.dataDir, "updates", updateId);
    const checkpoint = readCheckpoint(h.dataDir, updateId)!;
    expect(checkpoint.turns).toHaveLength(2);
    expect(checkpoint.steers).toEqual({ t1: [{ queueId: "q1" }] });
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ updateId, mode: "update", live: h.live, force: true, ports: [18799], health: "http://127.0.0.1:18799/api/health", appPid: 4242, uid: 501, requireLaunchd: false, codesign: false, selfBootout: true, label: `ai.bos.bot.update.${updateId.slice(0, 8)}` });
    expect(plan.staged).toBe(join(h.dataDir, "updates", "candidate", "BOS Bot.app"));
    expect(plan.backup).toMatch(/BOS Bot\.previous-2d83ba23-[0-9a-f]{8}\.app-disabled$/);
    expect(plan.expect).toEqual(appDigests(plan.staged));
    expect(plan.old).toEqual(appDigests(h.live));
    expect(createHash("sha256").update(readFileSync(join(dir, "apply.py"))).digest("hex")).toBe(plan.scriptSha256);
    expect(h.bootstraps).toEqual([join(dir, `${plan.label}.plist`)]);
    const plist = readFileSync(h.bootstraps[0], "utf8");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<false/>");
    expect(plist).toContain("<key>LaunchOnlyOnce</key>");
    expect(plist).toContain(`<string>${join(dir, "apply.py")}</string>`);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(pendingUpdates(h.dataDir)).toEqual([updateId]);
  });

  it("without force waits for turns to end before stopping", async () => {
    stage(h);
    let polls = 0;
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct" }];
    const c = h.make({ listBusyTurns: () => { polls++; if (polls > 4) h.turns = []; return [...h.turns]; } });
    const { updateId } = await c.restart();
    await h.settle();
    expect(h.events.map(e => e.state)).toEqual(["checkpointing", "stopping", "applying"]);
    expect(h.events[1].detail).toMatch(/waiting up to 5s/);
    expect(readCheckpoint(h.dataDir, updateId)!.turns).toEqual([]);
    const plan = JSON.parse(readFileSync(join(h.dataDir, "updates", updateId, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ mode: "restart", staged: null, backup: null, expect: null, force: false });
  });

  it("stops anyway once the bounded wait runs out and records what it interrupted", async () => {
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct" }];
    let clock = 0;
    const c = h.make({ stopWaitMs: 1_000, sleep: async ms => { clock += ms; }, now: () => new Date(clock) });
    const realNow = Date.now;
    Date.now = () => realNow() + clock;
    try {
      const { updateId } = await c.restart();
      await h.settle();
      expect(h.stopped).toBe(1);
      expect(readCheckpoint(h.dataDir, updateId)!.turns).toEqual([{ botId: "b1", threadId: "t1", kind: "direct" }]);
    } finally { Date.now = realNow; }
  });

  it("reports a failure the detached job records while the app is still alive, and reopens the workspace", async () => {
    stage(h);
    const c = h.make();
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    const result: UpdateResult = { state: "failed", at: "2026-10-04T00:00:00Z", detail: "could not stop the app: app did not quit in time", updateId, mode: "update", appStillRunning: true };
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify(result));
    for (let i = 0; i < 50 && c.active; i++) await h.settle();
    expect(c.active).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ state: "failed", detail: /did not quit/ });
    expect(h.unquiesced).toBe(1);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(c.status()).toMatchObject({ state: "ready", lastResult: { state: "failed" } });
    expect(pendingUpdates(h.dataDir)).toEqual([]);
  });

  it("on boot consumes the result once and resumes each interrupted turn exactly once", async () => {
    stage(h);
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct", title: "fix the thing" }, { botId: "b2", threadId: "g1", kind: "room", groupId: "geng" }];
    const first = h.make();
    const { updateId } = await first.apply({ force: true });
    await h.settle();
    // "the app quit here"; the job finishes after the new process is up.
    const result: UpdateResult = { state: "done", at: "2026-10-04T00:00:10Z", detail: "updated to 0.1.86 (feedface)", updateId, mode: "update", version: "0.1.86", sha: "feedface00000000", rollback: "/Applications/BOS Bot.previous.app-disabled" };
    const booted = h.make();
    const boot = booted.boot();
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({ state: "verifying", updateId });
    expect(booted.status().state).toBe("verifying");
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify(result));
    await boot;
    expect(h.events.at(-1)).toMatchObject({ state: "done", updateId, detail: "updated to 0.1.86 (feedface)" });
    expect(h.resumed.map(r => [r.turn.botId, r.turn.threadId, r.turn.kind])).toEqual([["b1", "t1", "direct"], ["b2", "g1", "room"]]);
    expect(h.resumed[0].result.version).toBe("0.1.86");
    const checkpoint = readCheckpoint(h.dataDir, updateId)!;
    expect(checkpoint.turns.every(t => t.resumedAt && t.resumeOutcome === "resumed")).toBe(true);
    expect(booted.status()).toMatchObject({ state: "ready", lastResult: { state: "done", version: "0.1.86", rollback: result.rollback } });
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    // A second boot (crash right after, or just the next launch) does nothing.
    const again = h.make();
    await again.boot();
    expect(h.resumed).toHaveLength(2);
    expect(again.status().lastResult).toMatchObject({ state: "done" });
  });

  it("marks a turn resumed before dispatching so a crash cannot replay it", async () => {
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct" }];
    const { updateId } = await h.make().restart({ force: true });
    await h.settle();
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify({ state: "done", at: "x", detail: "restarted", updateId, mode: "restart" }));
    const crashy = h.make({ resumeTurn: async () => { throw new Error("process died"); } });
    await crashy.boot();
    const turns = readCheckpoint(h.dataDir, updateId)!.turns;
    expect(turns[0].resumedAt).toBeTruthy();
    expect(turns[0].resumeOutcome).toMatch(/failed: process died/);
    await h.make().boot();
    expect(h.resumed).toHaveLength(0);
  });

  it("gives up on a job that never reports and says so", async () => {
    const { updateId } = await h.make().restart({ force: true });
    await h.settle();
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + clock;
    try {
      const booted = h.make({ sleep: async ms => { clock += ms; }, resultWaitMs: 2_000 });
      await booted.boot();
      expect(h.events.at(-1)).toMatchObject({ state: "failed", updateId, detail: /left no result/ });
      expect(pendingUpdates(h.dataDir)).toEqual([]);
    } finally { Date.now = realNow; }
  });

  it("writes a resume prompt that forbids replaying unseen external actions", () => {
    const text = resumePrompt({ botId: "b", threadId: "t", kind: "direct", title: "send the invoice" }, { state: "rolled_back", at: "x", detail: "health failed", updateId: "u", mode: "update" });
    expect(text).toMatch(/rolled back \(health failed\)/);
    expect(text).toContain('"send the invoice"');
    expect(text).toMatch(/interrupted, check/);
    expect(text).toMatch(/verify whether it happened before doing it again/);
  });

  it("escapes plist values", () => {
    expect(updaterPlist("ai.bos.bot.update.1", "/tmp/a&b <c>")).toContain("/tmp/a&amp;b &lt;c&gt;/apply.py");
  });
});
