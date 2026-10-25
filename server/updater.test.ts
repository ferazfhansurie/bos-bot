import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SERVER_PORT_FAMILIES, UpdateCoordinator, appDigests, isRunningBuild, classifyLaunchdJobs, createDarwinExecutor, discoverCandidate, squirrelInstallPending, jobBlocks, pendingUpdates, preflightVerdict, readCheckpoint, resumePrompt,
  updaterPlist, writeCandidateManifest, type ApplyPlan, type BusyTurn, type CheckpointTurn, type DarwinExecutorOptions, type LaunchdJobDetails, type NoDowngradeOptions, type UpdateEvent, type UpdateExecutor, type UpdateResult, type UpdaterHooks, type UpdaterHost,
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
  details: Record<string, LaunchdJobDetails | null>; preflight: string | null; logs: string[]; calls: string[];
  executor(options?: Partial<DarwinExecutorOptions>): UpdateExecutor;
  make(overrides?: Partial<UpdaterHooks>, executor?: Partial<DarwinExecutorOptions>): UpdateCoordinator;
  settle(): Promise<void>;
}

const PREFLIGHT_OK = JSON.stringify({ ok: true, checks: { health_ok: true, health_pid_is_server: true, single_main_app: true, blocking_jobs: [], idle_jobs: [] } });
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function harness(root: string): Harness {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const live = fakeApp(join(root, "Applications"), "BOS Bot.app", "old");
  const h: Harness = {
    dataDir, live, events: [], turns: [], stopped: 0, quiesced: 0, unquiesced: 0, launchd: "PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n",
    // preflight: what the fake python prints; null = the script failed (non-zero exit)
    bootstraps: [], bootouts: [], resumed: [], details: {}, preflight: PREFLIGHT_OK, logs: [], calls: [],
    executor(options = {}) {
      const host: UpdaterHost = {
        launchdList: async () => { h.calls.push("launchd"); return h.launchd; },
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
        preflight: preflightPath, runPreflight: async () => { h.calls.push("preflight"); if (h.preflight === null) throw new Error("python exploded (exit 1)"); return h.preflight; },
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

it("knows every port family the desktop may bind its server on", async () => {
  const { SERVER_PORTS } = await import(new URL("../electron/release-channel.mjs", import.meta.url).href) as { SERVER_PORTS: number[] };
  expect(SERVER_PORT_FAMILIES).toContainEqual(SERVER_PORTS);
});

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

  it("runs preflight first in admission and admits on ok=true, reporting idle one-shot jobs without blocking", async () => {
    stage(h);
    h.preflight = JSON.stringify({ ok: true, checks: { health_ok: true, health_pid_is_server: true, single_main_app: true, blocking_jobs: [], idle_jobs: ["ai.bos.bos.steer-t9-install"] } });
    const { notes } = await h.make().apply({ force: true });
    expect(h.calls.slice(0, 2)).toEqual(["preflight", "launchd"]); // before the launchd scan, the lock and the plan
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/preflight: idle install jobs loaded, not blocking: ai\.bos\.bos\.steer-t9-install/)]));
    await h.settle();
    expect(h.bootstraps).toHaveLength(1);
  });

  it("refuses at admission when preflight says ok=false, before any lock, plan or handoff", async () => {
    stage(h);
    h.preflight = JSON.stringify({ ok: false, checks: { health_ok: true, health_pid_is_server: false, single_main_app: true, blocking_jobs: [], idle_jobs: [] } });
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /^preflight not ok \(health_pid_is_server\)$/ });
    expect(h.calls).toEqual(["preflight"]); // launchd was never consulted
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    expect(h.bootstraps).toHaveLength(0);
    expect(h.events).toEqual([]);
    // a live install job is its own, named refusal
    h.preflight = JSON.stringify({ ok: false, checks: { blocking_jobs: ["ai.bos.bos.restart-keepalive"], idle_jobs: [] } });
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight found live install jobs: ai\.bos\.bos\.restart-keepalive/ });
    // and so are a crashed script, non-json output and a report with no verdict
    h.preflight = null;
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight refused: python exploded \(exit 1\)/ });
    h.preflight = "Traceback (most recent call last)";
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight refused: its output is not json/ });
    h.preflight = JSON.stringify({ checks: { blocking_jobs: [] } });
    await expect(h.make().apply({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight not ok \(no verdict in its report\)/ });
    expect(h.bootstraps).toHaveLength(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    // restart goes through the same gate
    await expect(h.make().restart({ force: true })).rejects.toMatchObject({ status: 409, message: /preflight not ok/ });
    expect(h.bootstraps).toHaveLength(0);
  });

  it("refuses when the packaged build is missing its preflight script; an unconfigured dev run skips it", async () => {
    stage(h);
    const missing = join(root, "Resources", "updater", "preflight.py");
    await expect(h.make({}, { preflight: missing, requirePreflight: true }).apply({ force: true }))
      .rejects.toMatchObject({ status: 409, message: new RegExp(`preflight script missing at ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; refusing to update`) });
    expect(h.calls).toEqual([]);
    expect(h.bootstraps).toHaveLength(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    // not required (OMB_UPDATER_PREFLIGHT pointed somewhere stale in a dev run): noted, not blocking
    const stale = await h.make({}, { preflight: missing, requirePreflight: false }).apply({ force: true });
    expect(stale.notes).toEqual(expect.arrayContaining([expect.stringMatching(/preflight script not found at .*preflight\.py; skipped/)]));
    await h.settle();
    rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
    const none = await h.make({}, { preflight: undefined }).apply({ force: true });
    expect(none.notes).toEqual(expect.arrayContaining(["preflight not configured; skipped"]));
    await h.settle();
  });

  it("ships the checked-in preflight.py to Contents/Resources/updater via electron-builder, outside the asar", () => {
    const script = join(REPO, "electron", "resources", "updater", "preflight.py");
    expect(existsSync(script)).toBe(true);
    const source = readFileSync(script, "utf8");
    expect(source).toMatch(/never unloads, kills or restarts/);
    expect(source).not.toMatch(/launchctl",\s*"(bootout|unload|kill|kickstart)/);
    expect(source).toMatch(/print\(json\.dumps\(res/);
    execFileSync("/usr/bin/python3", ["-c", `import ast,sys; ast.parse(open(sys.argv[1]).read())`, script], { stdio: "pipe" });
    const config = parseYaml(readFileSync(join(REPO, "electron-builder.yml"), "utf8")) as { files: string[]; mac: { extraResources: Array<{ from: string; to: string }> } };
    expect(config.mac.extraResources).toContainEqual({ from: "electron/resources/updater/preflight.py", to: "updater/preflight.py" });
    expect(config.files).toContain("!electron/resources/updater/**");
  });

  describe("no-downgrade gate", () => {
    type Run = NonNullable<NoDowngradeOptions["run"]>;
    const calls: string[][] = [];
    const guard = (reply: { code: number; stdout: string; stderr?: string } | Error, extra: Partial<NoDowngradeOptions> = {}): NoDowngradeOptions => ({
      script: join(root, "no-downgrade.py"), ledger: join(root, "data", "updates", "live-build.json"), repo: "/repo", releaseBranch: "release/bos-1.0",
      run: (async args => { calls.push(args); h.calls.push("guard"); if (reply instanceof Error) throw reply; return { stderr: "", ...reply }; }) as Run, ...extra,
    });
    beforeEach(() => { calls.length = 0; writeFileSync(join(root, "no-downgrade.py"), "# fake\n"); });

    it("runs right after the preflight on the staged bundle, before launchd, the lock and the plan; its allow note is logged", async () => {
      const staged = stage(h);
      const ok = JSON.stringify({ ok: true, reason: `allowed: candidate 1111111 descends from running 2d83ba23, is on release/bos-1.0 and is the prod head`, running: { commit: "2d83ba23" }, candidate: { commit: "1111111" } });
      const { notes } = await h.make({}, { noDowngrade: guard({ code: 0, stdout: ok }, { prodBranch: "prod" }) }).apply({ force: true });
      expect(h.calls.slice(0, 3)).toEqual(["preflight", "guard", "launchd"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([join(root, "no-downgrade.py"), "check", "--candidate", join(h.dataDir, "updates", "candidate", staged.app), "--live", h.live,
        "--ledger", join(root, "data", "updates", "live-build.json"), "--repo", "/repo", "--release-branch", "release/bos-1.0", "--prod-branch", "prod"]);
      expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/^no-downgrade: allowed: candidate 1111111 descends from running 2d83ba23/)]));
      await h.settle();
    });

    it("refuses an older, sibling, unstamped or non-prod build with the script's own reason, touching nothing", async () => {
      stage(h);
      const refusal = { code: 2, stdout: JSON.stringify({ ok: false, reason: "downgrade refused: running 2d83ba23 is not an ancestor of candidate da37ae2a (older build, or a sibling branch). only a descendant of the running build may be installed." }) };
      await expect(h.make({}, { noDowngrade: guard(refusal) }).apply({ force: true }))
        .rejects.toMatchObject({ status: 409, message: "install refused: downgrade refused: running 2d83ba23 is not an ancestor of candidate da37ae2a (older build, or a sibling branch). only a descendant of the running build may be installed." });
      expect(h.calls).toEqual(["preflight", "guard"]); // launchd never consulted
      expect(h.bootstraps).toHaveLength(0); expect(h.stopped).toBe(0); expect(h.quiesced).toBe(0);
      expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
      expect(h.events).toHaveLength(0);
      // a crash, garbage, or an exit-0 without a verdict all refuse: an unverifiable candidate is never installed
      await expect(h.make({}, { noDowngrade: guard(new Error("python exploded")) }).apply({ force: true })).rejects.toMatchObject({ status: 409, message: /no-downgrade guard failed: python exploded/ });
      await expect(h.make({}, { noDowngrade: guard({ code: 1, stdout: "", stderr: "Traceback: boom" }) }).apply({ force: true })).rejects.toMatchObject({ status: 409, message: /no-downgrade guard failed \(exit 1\): Traceback: boom/ });
      await expect(h.make({}, { noDowngrade: guard({ code: 0, stdout: "not json" }) }).apply({ force: true })).rejects.toMatchObject({ status: 409, message: /exited 0 without an ok verdict/ });
      expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    });

    it("hands the detached job its own copy of the guard: plan.json pins the script's sha256 and carries the ledger, repo and branches", async () => {
      stage(h);
      const ok = JSON.stringify({ ok: true, reason: "allowed", running: { commit: "2d83ba23" }, candidate: { commit: "1111111" } });
      await h.make({}, { noDowngrade: guard({ code: 0, stdout: ok }, { prodBranch: "prod", require: true }) }).apply({ force: true });
      await h.settle();
      expect(h.bootstraps).toHaveLength(1);
      const dir = dirname(h.bootstraps[0]);
      const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as ApplyPlan;
      expect(plan.guardRequired).toBe(true);
      expect(plan.guard).toEqual({
        script: join(dir, "no-downgrade.py"), scriptSha256: createHash("sha256").update("# fake\n").digest("hex"),
        ledger: join(root, "data", "updates", "live-build.json"), repo: "/repo", releaseBranch: "release/bos-1.0", prodBranch: "prod",
      });
      expect(readFileSync(join(dir, "no-downgrade.py"), "utf8")).toBe("# fake\n"); // the exact script admission ran, beside apply.py
      await h.settle();
      // a restart swaps nothing, so it carries no guard and requires none
      rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
      await h.make({}, { noDowngrade: guard({ code: 0, stdout: ok }, { require: true }) }).restart({ force: true });
      await h.settle();
      expect(h.bootstraps).toHaveLength(2);
      const restart = JSON.parse(readFileSync(join(dirname(h.bootstraps[1]), "plan.json"), "utf8")) as ApplyPlan;
      expect(restart).toMatchObject({ mode: "restart", guard: null, guardRequired: false });
      await h.settle();
      // unconfigured (dev run): none, not required
      rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
      stage(h);
      await h.make().apply({ force: true });
      await h.settle();
      expect(h.bootstraps).toHaveLength(3);
      const dev = JSON.parse(readFileSync(join(dirname(h.bootstraps[2]), "plan.json"), "utf8")) as ApplyPlan;
      expect(dev).toMatchObject({ mode: "update", guard: null, guardRequired: false });
      await h.settle();
    });

    it("never runs for a restart (same bundle), and the preflight still gates the restart", async () => {
      await h.make({}, { noDowngrade: guard({ code: 2, stdout: JSON.stringify({ ok: false, reason: "would refuse" }) }) }).restart({ force: true });
      expect(h.calls).toEqual(["preflight", "launchd"]);
      expect(calls).toHaveLength(0);
      await h.settle();
    });

    it("a packaged build without the shipped script refuses; a dev run skips with a note; unconfigured skips", async () => {
      stage(h);
      const missing = join(root, "Resources", "updater", "no-downgrade.py");
      await expect(h.make({}, { noDowngrade: guard({ code: 0, stdout: "{}" }, { script: missing, require: true }) }).apply({ force: true }))
        .rejects.toMatchObject({ status: 409, message: new RegExp(`no-downgrade guard missing at ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; refusing to update`) });
      expect(calls).toHaveLength(0);
      expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
      const dev = await h.make({}, { noDowngrade: guard({ code: 0, stdout: "{}" }, { script: missing, require: false }) }).apply({ force: true });
      expect(dev.notes).toEqual(expect.arrayContaining([expect.stringMatching(/no-downgrade guard not found at .*no-downgrade\.py; skipped/)]));
      await h.settle();
      rmSync(join(h.dataDir, "updates", "apply.lock"), { force: true });
      const none = await h.make().apply({ force: true });
      expect(none.notes).toEqual(expect.arrayContaining(["no-downgrade guard not configured; skipped"]));
      await h.settle();
    });

    it("after a finished update the next boot records the now-live bundle in the ledger; a record failure is logged, not fatal", async () => {
      const updateId = "11111111-2222-3333-4444-555555555555";
      mkdirSync(join(h.dataDir, "updates", updateId), { recursive: true });
      writeFileSync(join(h.dataDir, "updates", updateId, "plan.json"), JSON.stringify({ updateId, mode: "update" }));
      writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify({ state: "done", at: "x", detail: "updated", updateId, mode: "update" }));
      await h.make({}, { noDowngrade: guard({ code: 0, stdout: JSON.stringify({ ok: true, reason: "recorded 1111111 as the running build in ledger" }) }) }).boot();
      expect(calls).toEqual([[join(root, "no-downgrade.py"), "record", "--live", h.live, "--ledger", join(root, "data", "updates", "live-build.json"), "--repo", "/repo", "--release-branch", "release/bos-1.0"]]);
      expect(h.logs).toContain("[update] no-downgrade: recorded 1111111 as the running build in ledger");
      expect(h.events.at(-1)).toMatchObject({ state: "done", updateId });
      // a rolled-back or restart result leaves the ledger alone
      calls.length = 0;
      mkdirSync(join(h.dataDir, "updates", "a" + updateId.slice(1)), { recursive: true });
      writeFileSync(join(h.dataDir, "updates", "a" + updateId.slice(1), "plan.json"), JSON.stringify({ mode: "update" }));
      writeFileSync(join(h.dataDir, "updates", "a" + updateId.slice(1), "result.json"), JSON.stringify({ state: "rolled_back", at: "x", detail: "unhealthy", updateId: "a" + updateId.slice(1), mode: "update" }));
      await h.make({}, { noDowngrade: guard({ code: 0, stdout: "{}" }) }).boot();
      expect(calls).toHaveLength(0);
      // failure path
      mkdirSync(join(h.dataDir, "updates", "b" + updateId.slice(1)), { recursive: true });
      writeFileSync(join(h.dataDir, "updates", "b" + updateId.slice(1), "plan.json"), JSON.stringify({ mode: "update" }));
      writeFileSync(join(h.dataDir, "updates", "b" + updateId.slice(1), "result.json"), JSON.stringify({ state: "done", at: "x", detail: "updated", updateId: "b" + updateId.slice(1), mode: "update" }));
      await h.make({}, { noDowngrade: guard({ code: 2, stdout: JSON.stringify({ ok: false, reason: "Live.app is unstamped; pass --commit" }) }) }).boot();
      expect(h.logs).toContain("[update] no-downgrade ledger not updated: Live.app is unstamped; pass --commit");
      expect(h.events.at(-1)).toMatchObject({ state: "done" });
    });

    it("ships the checked-in no-downgrade.py beside preflight.py via electron-builder, outside the asar", () => {
      const script = join(REPO, "electron", "resources", "updater", "no-downgrade.py");
      expect(existsSync(script)).toBe(true);
      const source = readFileSync(script, "utf8");
      expect(source).toMatch(/Never stops, launches, signs or swaps anything/);
      expect(source).not.toMatch(/launchctl|shutil\.(move|rmtree|copytree)|os\.(rename|replace)\((?!tmp)/);
      execFileSync("/usr/bin/python3", ["-c", `import ast,sys; ast.parse(open(sys.argv[1]).read())`, script], { stdio: "pipe" });
      const config = parseYaml(readFileSync(join(REPO, "electron-builder.yml"), "utf8")) as { files: string[]; mac: { extraResources: Array<{ from: string; to: string }> } };
      expect(config.mac.extraResources).toContainEqual({ from: "electron/resources/updater/no-downgrade.py", to: "updater/no-downgrade.py" });
    });
  });

  it("classifies launchd rows", () => {
    expect(classifyLaunchdJobs("PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n99\t0\tai.bos.bot.update.11111111\n-\t0\tai.bos.bot.update.22222222\n7\t0\tai.bos.steer.keepalive\n-\t0\tcom.openmausbot.installer\n-\t0\tapplication.ai.bos.bot.123.456\n"))
      .toEqual({ running: ["ai.bos.bot.update.11111111", "ai.bos.steer.keepalive"], idle: ["com.openmausbot.installer"], staleOwn: ["ai.bos.bot.update.22222222"] });
    expect(preflightVerdict({})).toEqual({ refuse: "preflight not ok (no verdict in its report)", blocking: [], failed: [], notes: [] });
    expect(preflightVerdict({ ok: true, checks: { blocking_jobs: ["a"], idle_jobs: ["b"] } })).toEqual({ refuse: "preflight found live install jobs: a", blocking: ["a"], failed: [], notes: ["preflight: idle install jobs loaded, not blocking: b"] });
    expect(preflightVerdict({ ok: true, checks: { blocking_jobs: [], idle_jobs: ["b"] } })).toEqual({ refuse: null, blocking: [], failed: [], notes: ["preflight: idle install jobs loaded, not blocking: b"] });
    expect(preflightVerdict({ ok: false, checks: { health_ok: false, single_main_app: false } })).toEqual({ refuse: "preflight not ok (health_ok, single_main_app)", blocking: [], failed: ["health_ok", "single_main_app"], notes: [] });
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
    expect(await c.apply({ force: true })).toEqual({ updateId, inProgress: true });
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
    expect(["draining", "checkpointing", "stopping", "applying"]).toContain((await c.status()).state);
    // The second press is the same update, not a 409 and not a second job.
    expect(await c.apply({ force: true })).toEqual({ updateId, inProgress: true });
    expect(await c.restart()).toEqual({ updateId, inProgress: true });
    await h.settle();
    expect(h.events.map(e => e.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(c.progress()).toMatchObject({ updateId, mode: "update", state: "applying", log: [] });
    expect(c.progress().steps.map(s => s.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(JSON.parse(readFileSync(join(h.dataDir, "updates", updateId, "timeline.json"), "utf8")).steps).toHaveLength(4);
    expect(h.events.every(e => e.kind === "update.state" && e.type === "update.state" && e.updateId === updateId)).toBe(true);
    expect(h.stopped).toBe(1); expect(h.quiesced).toBe(1);
    const dir = join(h.dataDir, "updates", updateId);
    const checkpoint = readCheckpoint(h.dataDir, updateId)!;
    expect(checkpoint.turns).toHaveLength(2);
    expect(checkpoint.steers).toEqual({ t1: [{ queueId: "q1" }] });
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ updateId, mode: "update", version: "0.1.86", sha: "feedface00000000", oldVersion: "0.1.85", oldSha: "2d83ba23aaaaaaaa", live: h.live, force: true, ports: [18799], serverPorts: [18799, 8799, 28799], health: "http://127.0.0.1:18799/api/health", gracefulSeconds: 45, healthSeconds: 90, appPid: 4242, uid: 501, requireLaunchd: false, codesign: false, selfBootout: true, launch: ["/usr/bin/open", "{app}"], label: `ai.bos.bot.update.${updateId.slice(0, 8)}` });
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
    // The drain countdown refines the same state (one event per tick for the ui, one step).
    expect([...new Set(h.events.map(e => e.state))]).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(c.progress().steps.map(s => s.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(h.events[0].detail).toMatch(/waiting for 1 bot: b1 \(up to 5s\)/);
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

  it("names the busy bots while draining and lifts the drain before anything else when the wait is forced", async () => {
    stage(h);
    h.turns = [{ botId: "b1", botName: "pipe", threadId: "t1", kind: "direct" }, { botId: "b2", botName: "pix", threadId: "g1", kind: "room", groupId: "geng" }];
    let drained = 0;
    const c = h.make({ drain: () => { drained++; } });
    expect((await c.status()).busyTurns).toEqual([{ botId: "b1", botName: "pipe", threadId: "t1" }, { botId: "b2", botName: "pix", threadId: "g1" }]);
    const { updateId } = await c.restart({ force: true });
    await h.settle();
    expect(drained).toBe(1);
    expect(h.events.map(e => [e.state, e.detail])).toEqual([
      ["draining", "stopping turns now"], ["checkpointing", "saving 2 interrupted turns"], ["stopping", "interrupting 2 turns"], ["applying", expect.any(String)],
    ]);
    expect(readCheckpoint(h.dataDir, updateId)!.turns.map(turn => turn.botName)).toEqual(["pipe", "pix"]);
  });

  it("builds first, then admits the staged build, then drains: bots keep working through the build", async () => {
    let built = 0; let drainedAtBuild: number | null = null; let drained = 0;
    h.turns = [{ botId: "b1", botName: "pipe", threadId: "t1", kind: "direct" }];
    const target = { version: "0.1.86+feedface", sha: "feedface00000000", branch: "prod", subject: "ship it" };
    const c = h.make({
      drain: () => { drained++; },
      builder: {
        check: async () => ({ at: "2026-10-04T10:00:00Z", current: { version: "0.1.85", sha: "2d83ba23aaaaaaaa" }, candidate: target }),
        build: async (t, log) => { built++; drainedAtBuild = drained; expect(t).toEqual(target); log("archiving feedface"); log("vite built"); stage(h); },
      },
    });
    expect((await c.status()).state).toBe("idle");
    expect(await c.check()).toMatchObject({ candidate: target });
    expect(await c.status()).toMatchObject({ state: "ready", candidate: { version: "0.1.86+feedface", sha: "feedface00000000", branch: "prod" }, lastCheck: { at: "2026-10-04T10:00:00Z" } });
    expect(JSON.parse(readFileSync(join(h.dataDir, "updates", "last-check.json"), "utf8")).candidate.sha).toBe("feedface00000000");
    const { updateId } = await c.apply({ force: true });
    expect(await c.apply()).toEqual({ updateId, inProgress: true });
    await h.settle();
    expect(built).toBe(1); expect(drainedAtBuild).toBe(0); expect(drained).toBe(1);
    expect(h.events.map(e => e.state)).toEqual(["building", "draining", "checkpointing", "stopping", "applying"]);
    expect(h.events[0].detail).toBe("building 0.1.86+feedface from prod");
    expect(h.calls.filter(call => call === "preflight")).toHaveLength(1);
    expect(c.progress().log).toEqual(["archiving feedface", "vite built"]);
    expect(readFileSync(join(h.dataDir, "updates", updateId, "build.log"), "utf8")).toBe("archiving feedface\nvite built\n");
    const plan = JSON.parse(readFileSync(join(h.dataDir, "updates", updateId, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ mode: "update", version: "0.1.86", sha: "feedface00000000", oldSha: "2d83ba23aaaaaaaa" });
    // The staged candidate still shows, now with the branch the check found.
    expect((await c.status()).candidate).toMatchObject({ sha: "feedface00000000", branch: "prod", stagedAt: expect.any(String) });
  });

  it("never offers the running build as an update (same sha, +build metadata ignored)", async () => {
    const running = { version: "1.9.2", sha: "a014552b64ef7b32265c5df04fd0d71a8f3d94c8" };
    expect(isRunningBuild({ version: "1.9.2+a014552b", sha: running.sha }, running)).toBe(true);
    expect(isRunningBuild({ version: "1.9.2+a014552b", sha: "a014552b" }, running)).toBe(true);
    expect(isRunningBuild({ version: "1.9.2", sha: "unknown" }, { version: "1.9.2", sha: "unknown" })).toBe(true);
    expect(isRunningBuild({ version: "1.9.3+beefcafe", sha: "beefcafe00000000" }, running)).toBe(false);
    expect(isRunningBuild({ version: "1.9.2+beefcafe", sha: "beefcafe00000000" }, running)).toBe(false);

    // last-check.json from before the relaunch still names the build that is now running
    mkdirSync(join(h.dataDir, "updates"), { recursive: true });
    const stale = { at: "2026-10-09T22:18:59Z", current: { version: "1.9.2", sha: "83a7f16c1a08d5bd" }, candidate: { version: "1.9.2+a014552b", sha: running.sha, branch: "prod" }, reason: "allowed" };
    writeFileSync(join(h.dataDir, "updates", "last-check.json"), JSON.stringify(stale));
    const builder = { check: async () => stale, build: async () => {} };
    const after = h.make({ current: () => running, builder });
    const status = await after.status();
    expect(status.candidate).toBeUndefined();
    expect(status.state).toBe("idle");
    // the same candidate is still offered to a build that is not running it
    const before = h.make({ current: () => stale.current, builder });
    expect(await before.status()).toMatchObject({ state: "ready", candidate: { sha: running.sha } });
    // and a candidate that slipped through a fresh check is dropped by status
    const fresh = h.make({ current: () => running, builder: { check: async () => ({ at: "x", current: running, candidate: stale.candidate }), build: async () => {} } });
    await fresh.check();
    expect((await fresh.status()).candidate).toBeUndefined();
  });

  it("full staged delivery bypasses the tree builder and keeps admission/checkpoint gates", async () => {
    const manifest = stage(h);
    let built = 0;
    const target = { version: manifest.version, sha: manifest.sha, branch: "prod", delivery: "staged-full" as const };
    const c = h.make({ builder: { check: async () => ({ at: "now", current: { version: "old", sha: "old" }, shellRequired: true, candidate: target }), build: async () => { built++; } } });
    expect(await c.check()).toMatchObject({ candidate: target });
    expect(await c.status()).toMatchObject({ candidate: target, shellRequired: true });
    h.preflight = JSON.stringify({ ok: false, checks: { health_ok: false } });
    await expect(c.apply()).rejects.toMatchObject({ status: 409 });
    expect(h.stopped).toBe(0); expect(h.quiesced).toBe(0);
    h.preflight = PREFLIGHT_OK;
    h.turns = [{ botId: "busy", threadId: "direct", kind: "direct" }];
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    expect(built).toBe(0);
    expect(h.events.map(e => e.state)).toEqual(["draining", "checkpointing", "stopping", "applying"]);
    expect(readCheckpoint(h.dataDir, updateId)?.turns).toHaveLength(1);
    expect(h.bootstraps).toHaveLength(1);
  });

  it("a builder refusal hides stale staging and apply cannot install it", async () => {
    stage(h);
    const c = h.make({ builder: { check: async () => ({ at: "now", current: { version: "old", sha: "old" }, shellRequired: true, reason: "candidate invalid" }), build: async () => { throw new Error("must not build"); } } });
    await c.check();
    expect((await c.status()).candidate).toBeUndefined();
    await expect(c.apply()).rejects.toMatchObject({ status: 409, message: "candidate invalid" });
    expect(h.bootstraps).toHaveLength(0);
  });

  it("with a builder, apply refuses when the check finds nothing and fails cleanly when the build or its admission fails", async () => {
    let check = { at: "2026-10-04T10:00:00Z", current: { version: "0.1.85", sha: "2d83ba23aaaaaaaa" }, reason: "up to date: running 2d83ba23 is the prod head" } as Awaited<ReturnType<UpdateCoordinator["check"]>>;
    let buildError: Error | null = new Error("build failed at build:server: tsc exited 2");
    const c = h.make({ builder: { check: async () => check, build: async () => { if (buildError) throw buildError; stage(h); } } });
    await expect(c.apply()).rejects.toMatchObject({ status: 409, message: /up to date/ });
    expect(h.events).toEqual([]);
    check = { ...check, reason: undefined, candidate: { version: "0.1.86+feedface", sha: "feedface00000000", branch: "prod" } };
    const first = await c.apply();
    await h.settle();
    expect(c.active).toBe(false);
    expect(h.events.map(e => e.state)).toEqual(["building", "failed"]);
    expect(h.events.at(-1)).toMatchObject({ updateId: first.updateId, detail: /build failed at build:server/ });
    expect(h.stopped).toBe(0); expect(h.quiesced).toBe(0); expect(h.unquiesced).toBe(1);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
    expect(pendingUpdates(h.dataDir)).toEqual([]);
    expect((await c.status()).lastResult).toMatchObject({ state: "failed", updateId: first.updateId, from: { sha: "2d83ba23aaaaaaaa" }, to: { sha: "2d83ba23aaaaaaaa" } });
    // The build succeeds but admission (preflight / guard / launchd) says no: same clean failure, nothing drained.
    buildError = null; h.events = []; h.preflight = JSON.stringify({ ok: false, checks: { health_ok: false } });
    const second = await c.apply();
    await h.settle();
    expect(second.updateId).not.toBe(first.updateId);
    expect(h.events.map(e => e.state)).toEqual(["building", "failed"]);
    expect(h.events.at(-1)!.detail).toMatch(/preflight not ok/);
    expect(h.stopped).toBe(0); expect(h.quiesced).toBe(0);
    expect(existsSync(join(h.dataDir, "updates", "apply.lock"))).toBe(false);
  });

  it("check without a builder answers from the staged candidate, and a check that throws is a reason, not an error", async () => {
    const c = h.make();
    expect(await c.check()).toMatchObject({ reason: /no staged update and no build source/ });
    stage(h);
    expect(await c.check()).toMatchObject({ candidate: { version: "0.1.86", sha: "feedface00000000", branch: "staged" } });
    const broken = h.make({ builder: { check: async () => { throw new Error("branch prod not found in /repo"); }, build: async () => {} } });
    expect(await broken.check()).toMatchObject({ reason: "check failed: branch prod not found in /repo" });
    expect((await broken.status()).lastCheck).toMatchObject({ reason: /branch prod not found/ });
  });

  it("the last result says what was running before and after: done moves to the new build, a rollback stays on the old one", async () => {
    stage(h);
    const c = h.make();
    const { updateId } = await c.apply({ force: true });
    await h.settle();
    writeFileSync(join(h.dataDir, "updates", updateId, "result.json"), JSON.stringify({ state: "done", at: "x", detail: "updated to 0.1.86 (feedface)", updateId, mode: "update", version: "0.1.86", sha: "feedface00000000" }));
    const booted = h.make();
    await booted.boot();
    expect((await booted.status()).lastResult).toMatchObject({ state: "done", from: { version: "0.1.85", sha: "2d83ba23aaaaaaaa" }, to: { version: "0.1.86", sha: "feedface00000000" }, attempted: { sha: "feedface00000000" } });
    expect(booted.progress().steps.map(s => s.state)).toEqual(["draining", "checkpointing", "stopping", "applying", "verifying", "done"]);

    // A second update whose health check failed: apply.py restored the backup and said so.
    stage(h, "newer");
    const second = await h.make().apply({ force: true });
    await h.settle();
    writeFileSync(join(h.dataDir, "updates", second.updateId, "result.json"), JSON.stringify({ state: "rolled_back", at: "y", detail: "health check failed; previous build restored", updateId: second.updateId, mode: "update", rollback: "health", version: "0.1.85", sha: "2d83ba23aaaaaaaa" }));
    const again = h.make();
    await again.boot();
    expect((await again.status()).lastResult).toMatchObject({ state: "rolled_back", rollback: "health", updateId: second.updateId, from: { sha: "2d83ba23aaaaaaaa" }, to: { sha: "2d83ba23aaaaaaaa" }, attempted: { version: "0.1.86", sha: "feedface00000000" } });
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

  it("finds a Squirrel.Mac install only while its update bundle is still on disk", () => {
    const caches = join(root, "Caches");
    writeFileSync(join(h.live, "Contents", "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key>\n<string>ai.bos.bot</string></dict></plist>");
    expect(squirrelInstallPending(h.live, caches)).toBeNull();
    const update = fakeApp(join(caches, "ai.bos.bot.ShipIt", "update.abc"), "BOS Bot.app", "squirrel");
    const state = (target: string) => writeFileSync(join(caches, "ai.bos.bot.ShipIt", "ShipItState.plist"),
      JSON.stringify({ launchAfterInstallation: false, targetBundleURL: pathToFileURL(target).href + "/", updateBundleURL: pathToFileURL(update).href + "/", useUpdateBundleName: true }));
    state(h.live);
    expect(squirrelInstallPending(h.live, caches)).toEqual({ bundle: update });
    state(join(root, "Elsewhere", "BOS Bot.app"));
    expect(squirrelInstallPending(h.live, caches)).toBeNull();
    state(h.live);
    rmSync(update, { recursive: true });
    expect(squirrelInstallPending(h.live, caches)).toBeNull();
  });

  it("lets a downloaded Squirrel update install during a restart and refuses a swap that would race it", async () => {
    const pending = () => ({ bundle: "/tmp/update.abc/BOS Bot.app" });
    const { updateId, notes } = await h.make({}, { nativeInstallPending: pending }).restart({ force: true });
    await h.settle();
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/installs during this restart/)]));
    const plan = JSON.parse(readFileSync(join(h.dataDir, "updates", updateId, "plan.json"), "utf8")) as ApplyPlan;
    expect(plan.mode).toBe("restart");
    expect(plan.old).toBeNull();
    stage(h);
    await expect(h.make({}, { nativeInstallPending: pending }).apply({ force: true })).rejects.toMatchObject({ status: 409, message: /restart BOS first/ });
    expect(h.bootstraps).toHaveLength(1);
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
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
