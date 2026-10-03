import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UpdateCoordinator, appDigests, classifyLaunchdJobs, createDarwinExecutor, discoverCandidate, jobBlocks, pendingUpdates, preflightVerdict, readCheckpoint, resumePrompt,
  updaterPlist, writeCandidateManifest, type BusyTurn, type CheckpointTurn, type DarwinExecutorOptions, type LaunchdJobDetails, type UpdateEvent, type UpdateExecutor, type UpdateResult, type UpdaterHooks, type UpdaterHost,
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
  details: Record<string, LaunchdJobDetails | null>; preflight: string | null; logs: string[];
  executor(options?: Partial<DarwinExecutorOptions>): UpdateExecutor;
  make(overrides?: Partial<UpdaterHooks>, executor?: Partial<DarwinExecutorOptions>): UpdateCoordinator;
  settle(): Promise<void>;
}

function harness(root: string): Harness {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const live = fakeApp(join(root, "Applications"), "BOS Bot.app", "old");
  const h: Harness = {
    dataDir, live, events: [], turns: [], stopped: 0, quiesced: 0, unquiesced: 0, launchd: "PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n",
    bootstraps: [], bootouts: [], resumed: [], details: {}, preflight: null, logs: [],
    executor(options = {}) {
      const host: UpdaterHost = {
        launchdList: async () => h.launchd,
        jobDetails: async (_uid, label) => h.details[label] ?? null,
        bootstrap: async (_uid, plist) => { h.bootstraps.push(plist); },
        bootout: async (_uid, label) => { h.bootouts.push(label); },
        listeningPorts: async () => [18799],
        appProcess: async () => ({ pid: 4242, identity: "Fri Oct  3 19:58:01 2026 /Applications/BOS Bot.app/Contents/MacOS/BOS Bot" }),
      };
      // The preflight "script" is any existing file; the harness answers for python.
      const preflightPath = join(root, "preflight.py");
      if (!existsSync(preflightPath)) writeFileSync(preflightPath, "# fake\n");
      return createDarwinExecutor(host, {
        dataDir, liveApp: live, codesign: false, requireLaunchd: false, uid: 501,
        preflight: preflightPath, runPreflight: async () => { if (h.preflight === null) throw new Error("python exploded"); return h.preflight; },
        log: line => h.logs.push(line), ...options,
      });
    },
    make(overrides = {}, executorOptions = {}) {
      return new UpdateCoordinator({
        dataDir, executor: h.executor(executorOptions),
        current: () => ({ version: "0.1.85", sha: "2d83ba23aaaaaaaa" }),
        listBusyTurns: () => [...h.turns],
        stopAll: async () => { h.stopped++; h.turns = []; },
        checkpointExtras: () => ({ steers: { t1: [{ queueId: "q1" }] }, delegations: [] }),
        quiesce: async () => { h.quiesced++; },
        unquiesce: () => { h.unquiesced++; },
        emit: event => { h.events.push(event); },
        resumeTurn: async (turn, result) => { h.resumed.push({ turn, result }); return "resumed"; },
        sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
        stopWaitMs: 5_000, resultWaitMs: 3_000, log: line => h.logs.push(line),
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

  it("hashes bundle trees deterministically and discovers a staged candidate", async () => {
    expect(discoverCandidate(h.dataDir)).toBeNull();
    const manifest = stage(h);
    const found = discoverCandidate(h.dataDir)!;
    expect(found.version).toBe("0.1.86");
    expect(found.serverSha256).toBe(manifest.serverSha256);
    expect(appDigests(found.appPath)).toEqual({ server: manifest.serverSha256, ui: manifest.uiSha256 });
    expect(appDigests(h.live).server).not.toBe(manifest.serverSha256);
    expect(await h.make().status()).toMatchObject({ state: "ready", candidate: { version: "0.1.86", sha: "feedface00000000" }, current: { version: "0.1.85" } });
  });

  it("is idle without a candidate and refuses to apply", async () => {
    const c = h.make();
    expect((await c.status()).state).toBe("idle");
    await expect(c.apply()).rejects.toMatchObject({ status: 409, message: /no staged update/ });
    expect(h.events).toEqual([]);
  });

  it("refuses while another installer job is running, but clears its own finished jobs", async () => {
    stage(h);
    h.launchd = "PID\tStatus\tLabel\n812\t0\tai.bos.bos.restart-now-179104\n";
    await expect(h.make().apply()).rejects.toMatchObject({ status: 409, message: /restart-now-179104 \(running\)/ });
    h.launchd = "PID\tStatus\tLabel\n-\t0\tai.bos.bot.update.deadbeef\n";
    const c = h.make();
    await c.apply({ force: true });
    await h.settle();
    expect(h.bootouts).toEqual(["ai.bos.bot.update.deadbeef"]);
    expect(h.bootstraps).toHaveLength(1);
  });

  it("reports idle finished one-shot install jobs instead of refusing, and refuses jobs launchd would run again", async () => {
    stage(h);
    // What the live mac looks like today: finished steer-*-install one-shots still loaded at "-".
    h.launchd = "PID\tStatus\tLabel\n-\t0\tai.bos.bos.steer-t1-install\n-\t0\tai.bos.bos.steer-t2-install\n-\t0\tai.bos.bos.old-restart\n";
    h.details["ai.bos.bos.steer-t1-install"] = { keepAlive: false, runAtLoad: true, program: "/bin/sh /tmp/install.sh" };
    h.details["ai.bos.bos.steer-t2-install"] = { keepAlive: false, runAtLoad: true, program: "/bin/sh /tmp/install.sh" };
    const c = h.make();
    const { notes } = await c.apply({ force: true });
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/idle, not blocking: ai\.bos\.bos\.steer-t1-install$/), expect.stringMatching(/old-restart \(launchd gave no details\)/)]));
    await h.settle();
    expect(h.bootstraps).toHaveLength(1);
    rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
    h.details["ai.bos.bos.steer-t2-install"] = { keepAlive: true, runAtLoad: false, program: "/bin/sh /tmp/install.sh" };
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /steer-t2-install \(KeepAlive\)/ });
    h.details["ai.bos.bos.steer-t2-install"] = { keepAlive: false, runAtLoad: true, program: "/usr/bin/open /Applications/BOS Bot.app" };
    h.details["ai.bos.bos.old-restart"] = { keepAlive: false, runAtLoad: true, program: "/bin/sh /tmp/restart.sh" };
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /old-restart \(RunAtLoad restart\)/ });
    expect(h.bootstraps).toHaveLength(1);
  });

  it("decides per job what launchd would do with it", () => {
    expect(jobBlocks("ai.bos.bos.steer-x-install", null)).toBeNull();
    expect(jobBlocks("ai.bos.bos.steer-x-install", { keepAlive: false, runAtLoad: true, program: "/bin/sh install.sh" })).toBeNull();
    expect(jobBlocks("ai.bos.bos.steer-x-install", { keepAlive: true, runAtLoad: false })).toBe("KeepAlive");
    expect(jobBlocks("ai.bos.bos.restart-now", { keepAlive: false, runAtLoad: true })).toBe("RunAtLoad restart");
    expect(jobBlocks("ai.bos.bos.job", { keepAlive: false, runAtLoad: true, program: "/bin/sh relaunch.sh" })).toBe("RunAtLoad restart");
    expect(jobBlocks("ai.bos.bos.restart-now", { keepAlive: false, runAtLoad: false })).toBeNull();
  });

  it("asks preflight.py when it is there and refuses only on its live-job finding", async () => {
    stage(h);
    h.preflight = JSON.stringify({ ok: false, checks: { health_ok: true, health_pid_is_server: false, single_main_app: true, blocking_jobs: [], idle_jobs: ["ai.bos.bos.steer-t9-install"] } });
    const { notes } = await h.make().apply({ force: true });
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/preflight: idle install jobs loaded, not blocking: ai\.bos\.bos\.steer-t9-install/), expect.stringMatching(/preflight: not ok \(health_pid_is_server\); reported, not blocking/)]));
    await h.settle();
    rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
    h.preflight = JSON.stringify({ ok: false, checks: { blocking_jobs: ["ai.bos.bos.restart-keepalive"], idle_jobs: [] } });
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight found live install jobs: ai\.bos\.bos\.restart-keepalive/ });
    h.preflight = null; // python failed: reported, not blocking
    const second = await h.make().apply({ force: true });
    expect(second.notes).toEqual(expect.arrayContaining([expect.stringMatching(/preflight unreadable, not blocking: python exploded/)]));
    await h.settle();
    rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
    h.preflight = JSON.stringify({ ok: false, checks: { blocking_jobs: ["x"] } });
    const absent = await h.make({}, { preflight: join(root, "nope.py") }).apply({ force: true }); // not shipped: skipped
    expect(absent.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/preflight/)]));
    await h.settle();
  });

  it("classifies launchd rows", () => {
    expect(classifyLaunchdJobs("PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n99\t0\tai.bos.bot.update.11111111\n-\t0\tai.bos.bot.update.22222222\n7\t0\tai.bos.steer.keepalive\n-\t0\tcom.openmausbot.installer\n-\t0\tapplication.ai.bos.bot.123.456\n"))
      .toEqual({ running: ["ai.bos.bot.update.11111111", "ai.bos.steer.keepalive"], idle: ["com.openmausbot.installer"], staleOwn: ["ai.bos.bot.update.22222222"] });
    expect(preflightVerdict({})).toEqual({ blocking: [], notes: [] });
    expect(preflightVerdict({ ok: true, checks: { blocking_jobs: ["a"], idle_jobs: ["b"] } })).toEqual({ blocking: ["a"], notes: ["preflight: idle install jobs loaded, not blocking: b"] });
  });

  it("keeps the lock and the quiesced workspace when the executor cannot say whether it handed off", async () => {
    stage(h);
    let executes = 0;
    const base = h.executor();
    const executor: UpdateExecutor = { ...base, execute: async () => { executes++; throw Object.assign(new Error("desktop went quiet after recording intent"), { status: 409, pending: true }); } };
    const c = h.make({ executor });
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    expect(executes).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ state: "applying", detail: /handoff uncertain: desktop went quiet.*holding the workspace/ });
    expect(c.active).toBe(true); expect(c.id).toBe(updateId);
    expect(h.quiesced).toBe(1); expect(h.unquiesced).toBe(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(true);
    expect(pendingUpdates(h.dataDir)).toEqual([updateId]);
    await expect(c.apply({ force: true })).rejects.toMatchObject({ status: 409, message: /already running/ });
    await h.settle();
    expect(executes).toBe(1);
    expect((await c.status()).state).toBe("applying");
    // The next generation settles it through boot(), exactly like a real handoff.
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify({ state: "done", at: "x", detail: "updated to 0.1.86 (feedface)", updateId, mode: "update", version: "0.1.86", sha: "feedface00000000" }));
    const booted = h.make();
    await booted.boot();
    expect(h.events.at(-1)).toMatchObject({ state: "done", updateId });
    expect(pendingUpdates(h.dataDir)).toEqual([]);
  });

  it("a plain executor refusal fails the update at once and does not make the next boot wait", async () => {
    stage(h);
    const executor: UpdateExecutor = { ...h.executor(), execute: async () => { throw Object.assign(new Error("staged app changed since it was admitted; re-stage it"), { status: 409 }); } };
    const c = h.make({ executor });
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    expect(c.active).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ state: "failed", updateId, detail: /staged app changed/ });
    expect(h.unquiesced).toBe(1);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    expect((await c.status()).lastResult).toMatchObject({ state: "failed" });
    const started = Date.now();
    await h.make().boot();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.events.at(-1)).toMatchObject({ state: "failed", updateId });
  });

  it("checkpoints, stops, quiesces and hands launchd a one-shot job whose script hash is pinned", async () => {
    stage(h);
    h.turns = [{ botId: "b1", threadId: "t1", kind: "direct", title: "fix the thing" }, { botId: "b2", threadId: "g1", kind: "room", groupId: "geng" }];
    const c = h.make();
    const { updateId } = await c.apply({ force: true });
    expect((await c.status()).updateId).toBe(updateId);
    expect(["checkpointing", "stopping", "applying"]).toContain((await c.status()).state);
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
    expect(plan).toMatchObject({ updateId, mode: "update", version: "0.1.86", sha: "feedface00000000", oldVersion: "0.1.85", oldSha: "2d83ba23aaaaaaaa", live: h.live, force: true, ports: [18799], health: "http://127.0.0.1:18799/api/health", gracefulSeconds: 45, healthSeconds: 90, appPid: 4242, uid: 501, requireLaunchd: false, codesign: false, selfBootout: true, launch: ["/usr/bin/open", "{app}"], label: `ai.bos.bot.update.${updateId.slice(0, 8)}` });
    expect(plan.sandbox).toBeUndefined();
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
    expect(await c.status()).toMatchObject({ state: "ready", lastResult: { state: "failed" } });
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
    expect((await booted.status()).state).toBe("verifying");
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify(result));
    await boot;
    expect(h.events.at(-1)).toMatchObject({ state: "done", updateId, detail: "updated to 0.1.86 (feedface)" });
    expect(h.resumed.map(r => [r.turn.botId, r.turn.threadId, r.turn.kind])).toEqual([["b1", "t1", "direct"], ["b2", "g1", "room"]]);
    expect(h.resumed[0].result.version).toBe("0.1.86");
    const checkpoint = readCheckpoint(h.dataDir, updateId)!;
    expect(checkpoint.turns.every(t => t.resumedAt && t.resumeOutcome === "resumed")).toBe(true);
    expect(await booted.status()).toMatchObject({ state: "ready", lastResult: { state: "done", version: "0.1.86", rollback: result.rollback } });
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    // A second boot (crash right after, or just the next launch) does nothing.
    const again = h.make();
    await again.boot();
    expect(h.resumed).toHaveLength(2);
    expect((await again.status()).lastResult).toMatchObject({ state: "done" });
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
    expect(text).not.toContain("send the invoice"); // never re-issue the request
    expect(text).toMatch(/interrupted, check/);
    expect(text).toMatch(/verify whether it happened before doing it again/);
  });

  it("in the sandbox, describes the staged bundle at the given path and hands the script a sandbox plan", async () => {
    const stagedDir = join(root, "staged");
    const staged = fakeApp(stagedDir, "BOS Bot.app", "sandbox-new");
    writeFileSync(join(staged, "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>1.3.0</string></dict></plist>");
    const c = h.make({}, { sandbox: { stagedPath: staged, fault: "health-fail" }, preflight: undefined });
    expect(await c.status()).toMatchObject({ state: "ready", candidate: { version: "1.3.0", sha: appDigests(staged).server } });
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    const plan = JSON.parse(readFileSync(join(h.dataDir, "updates", updateId, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ staged, live: h.live, sandbox: true, fault: "health-fail", launch: [], selfBootout: false, requireLaunchd: false, codesign: false, version: "1.3.0", sha: appDigests(staged).server });
    expect(h.bootstraps).toHaveLength(1);
  });

  it("escapes plist values", () => {
    expect(updaterPlist("ai.bos.bot.update.1", "/tmp/a&b <c>")).toContain("/tmp/a&amp;b &lt;c&gt;/apply.py");
  });
});
