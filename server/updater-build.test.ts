// server/updater-build.ts: the build half of the update button. Driven with
// a throwaway git repo that carries the real no-downgrade.py, a fake live
// bundle, and build commands replaced by a shell script that writes the
// dist trees, so the recipe (archive, link deps, build, tree-swap, stamp,
// stage) is exercised end to end without pnpm, vite or codesign.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDigests, discoverCandidate } from "./updater.ts";
import { DEFAULT_PROD_BRANCH, DEFAULT_RELEASE_BRANCH, buildCandidate, buildRoot, missingPackages, previewUpdate, readUpdateSource, resolveUpdateTarget, runCommand, toolchainPath, type RunCommand } from "./updater-build.ts";

const PYTHON = "/usr/bin/python3";
const hasPython = existsSync(PYTHON) && spawnSync(PYTHON, ["--version"]).status === 0;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "electron", "resources", "updater", "no-downgrade.py");

function fakeApp(root: string, name: string, stamp: string): string {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "updater"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), `// server ${stamp}\n`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), `<html>${stamp}</html>`);
  writeFileSync(join(app, "Contents", "Resources", "updater", "old.py"), "# old\n");
  writeFileSync(join(app, "Contents", "Resources", "build-commit.json"), JSON.stringify({ commit: "0".repeat(40) }));
  writeFileSync(join(app, "Contents", "MacOS", "BOS Bot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return app;
}

interface Repo { dir: string; a: string; b: string; g: (...args: string[]) => string }

/** A → B on release/bos-1.0, prod = B; every commit carries package.json,
 * pnpm-lock.yaml and the real guard script. */
function makeRepo(root: string): Repo {
  const dir = join(root, "repo");
  mkdirSync(dir);
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  g("init", "-q", "-b", DEFAULT_RELEASE_BRANCH);
  mkdirSync(join(dir, "electron", "resources", "updater"), { recursive: true });
  writeFileSync(join(dir, "electron", "resources", "updater", "no-downgrade.py"), readFileSync(SCRIPT));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  const commit = (version: string, msg: string) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bos-bot", version, dependencies: { "left-pad": "1.0.0" }, devDependencies: { vite: "7.0.0" } }));
    writeFileSync(join(dir, "src.txt"), msg);
    g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD");
  };
  const a = commit("1.3.0", "A: first"); const b = commit("1.3.1", "B: ship the button");
  g("branch", DEFAULT_PROD_BRANCH, b);
  return { dir, a, b, g };
}

/** The "build": a shell script that writes what build:server and vite would. */
const FAKE_BUILD = [{ file: "/bin/sh", args: ["-c", "mkdir -p dist-server dist && printf '// built %s\\n' \"$(cat src.txt)\" > dist-server/index.js && printf '<html>%s</html>' \"$(cat src.txt)\" > dist/index.html && echo built"] }];

describe.skipIf(!hasPython)("update build", () => {
  let root: string; let repo: Repo; let live: string; let dataDir: string; let nodeModules: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-update-build-"));
    repo = makeRepo(root);
    live = fakeApp(join(root, "Applications"), "BOS Bot.app", "live");
    dataDir = join(root, "data"); mkdirSync(dataDir);
    // the canonical checkout's node_modules, with the same lockfile beside it
    nodeModules = join(repo.dir, "node_modules");
    for (const name of ["left-pad", "vite"]) { mkdirSync(join(nodeModules, name), { recursive: true }); writeFileSync(join(nodeModules, name, "package.json"), `{"name":"${name}"}`); }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the update source from env, then updates/source.json, then the ledger, then defaults", () => {
    expect(readUpdateSource(dataDir, {})).toEqual({ releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH });
    mkdirSync(join(dataDir, "updates"));
    writeFileSync(join(dataDir, "updates", "live-build.json"), JSON.stringify({ repo: "/ledger/repo", release_branch: "release/x", prod_branch: "prod-x" }));
    expect(readUpdateSource(dataDir, {})).toEqual({ repo: "/ledger/repo", releaseBranch: "release/x", prodBranch: "prod-x" });
    writeFileSync(join(dataDir, "updates", "source.json"), JSON.stringify({ repo: "/file/repo", prodBranch: "prod-file" }));
    expect(readUpdateSource(dataDir, {})).toEqual({ repo: "/file/repo", releaseBranch: "release/x", prodBranch: "prod-file" });
    expect(readUpdateSource(dataDir, { OMB_UPDATE_REPO: "/env/repo", OMB_UPDATE_PROD_BRANCH: "", OMB_UPDATE_NODE_MODULES: "/nm" })).toEqual({ repo: "/env/repo", releaseBranch: "release/x", prodBranch: "", nodeModules: "/nm" });
    expect(missingPackages(nodeModules, join(repo.dir, "package.json"))).toEqual([]);
    rmSync(join(nodeModules, "vite"), { recursive: true });
    expect(missingPackages(nodeModules, join(repo.dir, "package.json"))).toEqual(["vite"]);
    expect(toolchainPath({ OMB_UPDATE_TOOLCHAIN_PATH: "/x/bin", PATH: "/usr/bin" })).toBe("/x/bin:/usr/bin");
    expect(toolchainPath({ PATH: "/usr/bin" }, join(root, "nohome"))).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  it("resolves the prod head with the version its package.json declares, and says why when it cannot", async () => {
    await expect(resolveUpdateTarget({ releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH })).rejects.toMatchObject({ status: 409, message: /not configured/ });
    await expect(resolveUpdateTarget({ repo: join(root, "nope"), releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH })).rejects.toMatchObject({ status: 409, message: /not a git checkout/ });
    await expect(resolveUpdateTarget({ repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: "nope" })).rejects.toMatchObject({ status: 409, message: /branch nope not found/ });
    expect(await resolveUpdateTarget({ repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH })).toEqual({ sha: repo.b, branch: DEFAULT_PROD_BRANCH, version: `1.3.1+${repo.b.slice(0, 8)}`, subject: "B: ship the button" });
    // prod check off: the release head is the target
    repo.g("branch", "-f", DEFAULT_PROD_BRANCH, repo.a);
    expect((await resolveUpdateTarget({ repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: "" })).sha).toBe(repo.b);
    expect((await resolveUpdateTarget({ repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH })).sha).toBe(repo.a);
  });

  it("preview turns the guard's verdicts into a check: candidate only when a build would be admitted", async () => {
    const source = { repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH };
    const ledger = join(dataDir, "updates", "live-build.json");
    const current = { version: "1.3.0", sha: repo.a };
    const target = await resolveUpdateTarget(source);
    // unknown running build: a reason, no candidate
    expect(await previewUpdate({ script: SCRIPT, ledger, liveApp: live, source, target, current })).toMatchObject({ current, reason: expect.stringMatching(/running build|record/i) });
    // record A as running: B is the candidate
    expect(spawnSync(PYTHON, [SCRIPT, "record", "--live", live, "--commit", repo.a, "--ledger", ledger, "--repo", repo.dir, "--release-branch", DEFAULT_RELEASE_BRANCH], { encoding: "utf8" }).status).toBe(0);
    const found = await previewUpdate({ script: SCRIPT, ledger, liveApp: live, source, target, current });
    expect(found).toMatchObject({ current, candidate: { version: `1.3.1+${repo.b.slice(0, 8)}`, sha: repo.b, branch: DEFAULT_PROD_BRANCH, subject: "B: ship the button" } });
    expect(found.candidate).toBeDefined();
    // running B already: up to date
    spawnSync(PYTHON, [SCRIPT, "record", "--live", live, "--commit", repo.b, "--ledger", ledger, "--repo", repo.dir, "--release-branch", DEFAULT_RELEASE_BRANCH]);
    expect(await previewUpdate({ script: SCRIPT, ledger, liveApp: live, source, target, current: { version: "1.3.1", sha: repo.b } })).toMatchObject({ reason: /up to date/ });
    // an older target (prod moved back): refused, reason carried
    spawnSync(PYTHON, [SCRIPT, "record", "--live", live, "--commit", repo.b, "--ledger", ledger, "--repo", repo.dir, "--release-branch", DEFAULT_RELEASE_BRANCH]);
    const older = await previewUpdate({ script: SCRIPT, ledger, liveApp: live, source, target: { ...target, sha: repo.a, version: "1.3.0+old" }, current });
    expect(older.candidate).toBeUndefined(); expect(older.reason).toMatch(/refused|older|ancestor|behind|prod/i);
    // the script itself failing is a reason too
    expect(await previewUpdate({ script: join(root, "missing.py"), ledger, liveApp: live, source, target, current })).toMatchObject({ reason: /no-downgrade guard failed/ });
  });

  it("archives the commit, links deps, builds, tree-swaps into a copy of the live bundle, stamps and stages", async () => {
    const source = { repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH };
    const target = await resolveUpdateTarget(source);
    const log: string[] = [];
    const outcome = await buildCandidate({ dataDir, liveApp: live, source, target, codesign: false, commands: FAKE_BUILD, log: line => log.push(line) });
    expect(outcome.signed).toBeNull();
    expect(outcome.stamp.commit).toBe(repo.b);
    expect(existsSync(outcome.buildDir)).toBe(false);
    const staged = discoverCandidate(dataDir)!;
    expect(staged).toMatchObject({ version: target.version, sha: repo.b, appPath: join(dataDir, "updates", "candidate", "BOS Bot.app") });
    expect(appDigests(staged.appPath)).toEqual({ server: outcome.stamp.server_sha256, ui: outcome.stamp.ui_sha256 });
    const resources = join(staged.appPath, "Contents", "Resources");
    expect(readFileSync(join(resources, "server", "index.js"), "utf8")).toBe("// built B: ship the button\n");
    expect(readFileSync(join(resources, "ui", "index.html"), "utf8")).toBe("<html>B: ship the button</html>");
    expect(JSON.parse(readFileSync(join(resources, "build-commit.json"), "utf8"))).toMatchObject({ commit: repo.b });
    // the updater scripts come from the source commit; the rest of the shell is the live one
    expect(readdirSync(join(resources, "updater"))).toEqual(["no-downgrade.py"]);
    expect(readFileSync(join(staged.appPath, "Contents", "MacOS", "BOS Bot"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    const build = JSON.parse(readFileSync(join(dataDir, "updates", "candidate", "build.json"), "utf8"));
    expect(build).toMatchObject({ target: { sha: repo.b }, signed: null, source: { repo: repo.dir, prodBranch: DEFAULT_PROD_BRANCH } });
    expect(log.some(line => line.includes("node_modules linked from"))).toBe(true);
    expect(log.at(-1)).toMatch(/build: staged 1\.3\.1\+/);
    // the live bundle was only read
    expect(readFileSync(join(live, "Contents", "Resources", "server", "index.js"), "utf8")).toBe("// server live\n");
    // the staged bundle passes the guard against a live bundle recorded as A
    const ledger = join(dataDir, "updates", "live-build.json");
    spawnSync(PYTHON, [SCRIPT, "record", "--live", live, "--commit", repo.a, "--ledger", ledger, "--repo", repo.dir, "--release-branch", DEFAULT_RELEASE_BRANCH]);
    const check = spawnSync(PYTHON, [SCRIPT, "check", "--candidate", staged.appPath, "--live", live, "--ledger", ledger], { encoding: "utf8" });
    expect(check.status).toBe(0); expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, candidate: { commit: repo.b, source: "stamp" } });
    // a second build replaces the candidate
    const again = await buildCandidate({ dataDir, liveApp: live, source, target, codesign: false, commands: FAKE_BUILD });
    expect(again.stamp).toMatchObject({ commit: repo.b, server_sha256: outcome.stamp.server_sha256, ui_sha256: outcome.stamp.ui_sha256 });
    expect(readdirSync(join(dataDir, "updates", "candidate")).sort()).toEqual(["BOS Bot.app", "build.json", "manifest.json"]);
  });

  it("installs instead of linking when the lockfile differs, names the failing step and keeps the build dir", async () => {
    const source = { repo: repo.dir, releaseBranch: DEFAULT_RELEASE_BRANCH, prodBranch: DEFAULT_PROD_BRANCH };
    const target = await resolveUpdateTarget(source);
    // same lockfile, stale install: vite is declared but absent, so the link is refused and pnpm installs
    rmSync(join(nodeModules, "vite"), { recursive: true });
    const calls: string[] = [];
    const run: RunCommand = async (file, args, options) => {
      calls.push([file, ...args].join(" "));
      if (file === "pnpm") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "-c") return { code: 2, stdout: "", stderr: "src/index.ts(1,1): error TS2304: Cannot find name 'x'.\nbuild failed" };
      return runCommand(file, args, options);
    };
    const error = await buildCandidate({ dataDir, liveApp: live, source, target, codesign: false, commands: FAKE_BUILD, run }).then(() => { throw new Error("built"); }, e => e as Error & { status: number; step: string; buildDir: string });
    expect(error).toMatchObject({ status: 500, step: expect.stringMatching(/^\/bin\/sh -c mkdir/), buildDir: join(buildRoot(dataDir), repo.b.slice(0, 8)) });
    expect(error.message).toMatch(/^build failed at \/bin\/sh -c.*exited 2: .*TS2304.*build failed/);
    expect(calls.some(call => call.startsWith("pnpm install --frozen-lockfile"))).toBe(true);
    expect(existsSync(join(buildRoot(dataDir), repo.b.slice(0, 8), "src", "node_modules"))).toBe(false);
    expect(existsSync(join(buildRoot(dataDir), repo.b.slice(0, 8), "src", "package.json"))).toBe(true);
    expect(discoverCandidate(dataDir)).toBeNull();
    // a commit from before the guard existed cannot be stamped, so it cannot be built
    rmSync(join(repo.dir, "electron"), { recursive: true });
    mkdirSync(join(nodeModules, "vite")); writeFileSync(join(nodeModules, "vite", "package.json"), "{}");
    repo.g("add", "-A"); repo.g("commit", "-q", "-m", "C: drop the guard");
    const c = repo.g("rev-parse", "HEAD");
    await expect(buildCandidate({ dataDir, liveApp: live, source, target: { ...target, sha: c }, codesign: false, commands: FAKE_BUILD })).rejects.toMatchObject({ step: "stamp", message: /predates the install guard/ });
  });
});
