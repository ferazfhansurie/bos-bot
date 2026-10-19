import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as require_dir, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisor, pruneRollbacks, swapBack, swapIn } from "./launch.mjs";

const OLD = "a".repeat(40), NEW = "b".repeat(40);
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const json = file => JSON.parse(readFileSync(file, "utf8"));

function tree(root, label, commit) {
  mkdirSync(join(root, "server"), { recursive: true }); mkdirSync(join(root, "ui"), { recursive: true }); mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "server", "index.js"), `// ${label}\n`);
  writeFileSync(join(root, "ui", "index.html"), label);
  writeFileSync(join(root, "build-commit.json"), JSON.stringify({ commit }));
}

/** A standalone install with the old build live, the new one staged and a handoff waiting. */
function install(mode = "update") {
  const root = mkdtempSync(join(tmpdir(), "bos-launch-")); dirs.push(root);
  const resources = join(root, "resources"), data = join(root, "data"), job = join(data, "updates", "u1");
  tree(resources, "old", OLD);
  mkdirSync(job, { recursive: true });
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ resources, dataDir: data, port: 38799, version: "2.0.2", logsDir: join(root, "logs"), maintenanceMarker: join(root, "maintenance") }));
  if (mode === "update") {
    tree(join(root, "updates", "staged"), "new", NEW);
    writeFileSync(join(root, "updates", "staged", "staged.json"), JSON.stringify({ version: "2.0.3", sha: NEW, stagedAt: "x", publishedAt: "2026-10-15T00:00:00.000Z", channel: "enterprise" }));
  }
  const plan = { updateId: "u1", mode, version: mode === "update" ? "2.0.3" : "2.0.2", sha: mode === "update" ? NEW : OLD, oldVersion: "2.0.2", oldSha: OLD,
    resultPath: join(job, "result.json"), installedPath: join(data, "updates", "installed.json"), healthSeconds: 1 };
  writeFileSync(join(job, "plan.json"), JSON.stringify(plan));
  mkdirSync(join(root, "updates"), { recursive: true });
  writeFileSync(join(root, "updates", "request.json"), JSON.stringify({ plan: join(job, "plan.json"), updateId: "u1", mode }));
  return { root, resources, configPath, plan };
}

/** A fake server process; `crash` makes it exit right after starting. */
function fakeChildren(crash = [], crashAfterMs = 5) {
  const started = [];
  const startChild = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit("exit", 0); } };
    started.push(child);
    if (crash[started.length - 1]) setTimeout(() => { child.exitCode = 1; child.emit("exit", 1); }, crashAfterMs);
    return child;
  };
  return { started, startChild };
}

describe("standalone launcher", () => {
  it("swaps in a healthy update and records it", async () => {
    const { root, resources, configPath, plan } = install();
    const { started, startChild } = fakeChildren();
    const sup = createSupervisor(configPath, { startChild, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 10 });
    const running = await sup.handle(json(join(root, "updates", "request.json")));
    expect(running).toBeTruthy();
    expect(started).toHaveLength(1);
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("new");
    expect(json(plan.resultPath)).toMatchObject({ state: "done", version: "2.0.3", sha: NEW, updateId: "u1" });
    expect(json(plan.installedPath)).toEqual({ version: "2.0.3", sha: NEW });
    expect(json(configPath).version).toBe("2.0.3");
    expect(json(join(root, "updates", "feed-state.json")).commit).toBe(NEW);
    expect(existsSync(join(root, "updates", "request.json"))).toBe(false);
    expect(existsSync(join(root, "updates", "swap-journal.json"))).toBe(false);
    expect(readFileSync(join(root, "updates", "rollback-u1", "ui", "index.html"), "utf8")).toBe("old");
  });

  it("rolls back when the new build never answers its health check", async () => {
    const { root, resources, configPath, plan } = install();
    const { started, startChild } = fakeChildren();
    const sup = createSupervisor(configPath, { startChild, healthy: async () => false, log: () => undefined, pollMs: 5 });
    expect(await sup.handle(json(join(root, "updates", "request.json")))).toBe(false);
    expect(started[0].exitCode).toBe(0);
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("old");
    expect(json(plan.resultPath)).toMatchObject({ state: "rolled_back", version: "2.0.2", sha: OLD });
    expect(json(plan.installedPath)).toEqual({ version: "2.0.2", sha: OLD });
    expect(json(configPath).version).toBe("2.0.2");
  });

  it("rolls back when the new build crashes on start", async () => {
    const { root, resources, configPath, plan } = install();
    const { startChild } = fakeChildren([true]);
    const sup = createSupervisor(configPath, { startChild, healthy: async () => false, log: () => undefined, pollMs: 5 });
    expect(await sup.handle(json(join(root, "updates", "request.json")))).toBe(false);
    expect(readFileSync(join(resources, "server", "index.js"), "utf8")).toBe("// old\n");
    expect(json(plan.resultPath).state).toBe("rolled_back");
  });

  it("refuses a staged build that is not the planned one", async () => {
    const { root, resources, configPath, plan } = install();
    writeFileSync(join(root, "updates", "staged", "staged.json"), JSON.stringify({ version: "2.0.4", sha: "c".repeat(40) }));
    const sup = createSupervisor(configPath, { startChild: fakeChildren().startChild, healthy: async () => true, log: () => undefined });
    expect(await sup.handle(json(join(root, "updates", "request.json")))).toBe(false);
    expect(json(plan.resultPath).state).toBe("failed");
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("old");
  });

  it("restarts without swapping", async () => {
    const { root, resources, configPath, plan } = install("restart");
    const sup = createSupervisor(configPath, { startChild: fakeChildren().startChild, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 10 });
    expect(await sup.handle(json(join(root, "updates", "request.json")))).toBeTruthy();
    expect(json(plan.resultPath)).toMatchObject({ state: "done", detail: "restarted", sha: OLD });
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("old");
  });

  it("undoes a swap cut short by a crash", () => {
    const { root, resources, configPath, plan } = install();
    const rollback = join(root, "updates", "rollback-u1");
    swapIn({ resources, staged: join(root, "updates", "staged"), rollback, journal: join(root, "updates", "swap-journal.json"), updateId: "u1", oldVersion: "2.0.2", plan: join(root, "data", "updates", "u1", "plan.json") });
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("new");
    createSupervisor(configPath, { log: () => undefined }).recoverInterrupted();
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("old");
    expect(json(plan.resultPath).state).toBe("rolled_back");
    expect(existsSync(join(root, "updates", "swap-journal.json"))).toBe(false);
  });

  it("swapBack restores a partly swapped tree", () => {
    const root = mkdtempSync(join(tmpdir(), "bos-launch-")); dirs.push(root);
    const resources = join(root, "r"), rollback = join(root, "rb");
    tree(rollback, "old", OLD);
    mkdirSync(join(resources, "server"), { recursive: true });
    writeFileSync(join(resources, "server", "index.js"), "// new\n");
    swapBack({ resources, rollback });
    expect(readFileSync(join(resources, "server", "index.js"), "utf8")).toBe("// old\n");
    expect(readFileSync(join(rollback, "failed", "server", "index.js"), "utf8")).toBe("// new\n");
  });

  it("keeps the two newest rollbacks", () => {
    const root = mkdtempSync(join(tmpdir(), "bos-launch-")); dirs.push(root);
    for (const [name, at] of [["rollback-a", "2026-10-01"], ["rollback-b", "2026-10-03"], ["rollback-c", "2026-10-02"]]) {
      mkdirSync(join(root, name)); writeFileSync(join(root, name, "rollback.json"), JSON.stringify({ at }));
    }
    pruneRollbacks(root);
    expect(existsSync(join(root, "rollback-a"))).toBe(false);
    expect(existsSync(join(root, "rollback-b")) && existsSync(join(root, "rollback-c"))).toBe(true);
  });

  it("loop applies a handoff the server left on exit", async () => {
    const { root, resources, configPath } = install();
    const { started, startChild } = fakeChildren();
    const sup = createSupervisor(configPath, { startChild, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 10 });
    const done = sup.loop({ once: true });
    await new Promise(r => setTimeout(r, 50));
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("new");
    started[0].kill();
    await done;
  });

  it("carries server/vendor into the new tree and back on rollback", async () => {
    const { root, resources, configPath } = install();
    mkdirSync(join(resources, "server", "vendor")); writeFileSync(join(resources, "server", "vendor", "pty.node"), "native");
    const ok = createSupervisor(configPath, { startChild: fakeChildren().startChild, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 10 });
    await ok.handle(json(join(root, "updates", "request.json")));
    expect(readFileSync(join(resources, "server", "vendor", "pty.node"), "utf8")).toBe("native");

    const second = install();
    mkdirSync(join(second.resources, "server", "vendor")); writeFileSync(join(second.resources, "server", "vendor", "pty.node"), "native");
    const bad = createSupervisor(second.configPath, { startChild: fakeChildren().startChild, healthy: async () => false, log: () => undefined, pollMs: 5 });
    await bad.handle(json(join(second.root, "updates", "request.json")));
    expect(readFileSync(join(second.resources, "server", "index.js"), "utf8")).toBe("// old\n");
    expect(readFileSync(join(second.resources, "server", "vendor", "pty.node"), "utf8")).toBe("native");
  });

  it("rolls back a build that dies right after passing its health check", async () => {
    const { root, resources, configPath, plan } = install();
    writeFileSync(join(require_dir(plan.resultPath), "consumed.json"), "{}");
    const sup = createSupervisor(configPath, { startChild: fakeChildren([true], 30).startChild, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 500 });
    expect(await sup.handle(json(join(root, "updates", "request.json")))).toBe(false);
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("old");
    expect(json(plan.resultPath).state).toBe("rolled_back");
    expect(existsSync(join(require_dir(plan.resultPath), "consumed.json"))).toBe(false);
    expect(existsSync(join(root, "updates", "swap-journal.json"))).toBe(false);
    expect(existsSync(join(root, "updates", "feed-state.json"))).toBe(false);
  });

  it("keeps an update that was healthy when the launcher stopped", () => {
    const { root, resources, configPath, plan } = install();
    swapIn({ resources, staged: join(root, "updates", "staged"), rollback: join(root, "updates", "rollback-u1"), journal: join(root, "updates", "swap-journal.json"), updateId: "u1", oldVersion: "2.0.2", plan: join(root, "data", "updates", "u1", "plan.json"), publishedAt: "2026-10-15T00:00:00.000Z" });
    writeFileSync(plan.resultPath, JSON.stringify({ state: "done", sha: NEW }));
    createSupervisor(configPath, { log: () => undefined }).recoverInterrupted();
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("new");
    expect(json(join(root, "updates", "feed-state.json")).publishedAt).toBe("2026-10-15T00:00:00.000Z");
    expect(existsSync(join(root, "updates", "swap-journal.json"))).toBe(false);
  });

  it("loop keeps the server up when a handoff throws", async () => {
    const { root, configPath } = install("restart");
    const { started, startChild } = fakeChildren();
    let first = true;
    const flaky = () => { if (first) { first = false; throw new Error("spawn EAGAIN"); } return startChild(); };
    const sup = createSupervisor(configPath, { startChild: flaky, healthy: async () => true, log: () => undefined, pollMs: 5, stableMs: 10 });
    const done = sup.loop({ once: true });
    await new Promise(r => setTimeout(r, 30));
    expect(started).toHaveLength(1);
    expect(existsSync(join(root, "updates", "request.json"))).toBe(false);
    started[0].kill();
    await done;
  });
});
