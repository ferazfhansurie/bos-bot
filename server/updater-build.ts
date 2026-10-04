// The build half of the update button: turn the commit prod points at into a
// staged, stamped, signed candidate bundle that `UpdateCoordinator.apply`
// then hands to the existing installer. Nothing here stops, swaps or
// relaunches anything; it only writes under <dataDir>/updates.
//
// The recipe is the one every hand-run install on this machine used (a
// tree-swap): copy the live bundle, rebuild Contents/Resources/server and
// Contents/Resources/ui from the source commit, carry the updater scripts
// along, stamp the bundle with its source commit (no-downgrade.py stamp), and
// re-sign it with the identity the live bundle already carries so the TCC
// grants keyed on that signature survive. electron-builder is not involved:
// a packaged build needs the release signing secrets this machine does not
// have, and the Electron shell does not change between release commits.
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { CANDIDATE_DIRNAME, appDigests, updatesDir, writeCandidateManifest, type CandidateManifest, type UpdateCheck } from "./updater.ts";

/** Where updates come from. Environment first, then <dataDir>/updates/source.json
 * (the operator's file), then the no-downgrade ledger (seeded by its first
 * `record`), then the defaults. `repo` has no default: without a canonical
 * checkout there is nothing to build from and `check` says so. */
export interface UpdateSource {
  repo?: string; releaseBranch: string; prodBranch: string;
  /** A complete node_modules to link into the build when its lockfile matches (default: <repo>/node_modules). */
  nodeModules?: string;
}

export const DEFAULT_RELEASE_BRANCH = "release/bos-1.0";
export const DEFAULT_PROD_BRANCH = "prod";

function readJsonFile(path: string): Record<string, unknown> | null {
  try { const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function readUpdateSource(dataDir: string, env: NodeJS.ProcessEnv = process.env): UpdateSource {
  const file = readJsonFile(join(updatesDir(dataDir), "source.json")) ?? {};
  const ledger = readJsonFile(join(updatesDir(dataDir), "live-build.json")) ?? {};
  const repo = str(env.OMB_UPDATE_REPO) ?? str(file.repo) ?? str(ledger.repo);
  const releaseBranch = str(env.OMB_UPDATE_RELEASE_BRANCH) ?? str(file.releaseBranch) ?? str(ledger.release_branch) ?? DEFAULT_RELEASE_BRANCH;
  // "" means the prod check is off; only an explicit empty env value may say that.
  const prodBranch = env.OMB_UPDATE_PROD_BRANCH !== undefined ? env.OMB_UPDATE_PROD_BRANCH.trim()
    : str(file.prodBranch) ?? (typeof ledger.prod_branch === "string" ? ledger.prod_branch : undefined) ?? DEFAULT_PROD_BRANCH;
  const nodeModules = str(env.OMB_UPDATE_NODE_MODULES) ?? str(file.nodeModules);
  return { ...(repo ? { repo } : {}), releaseBranch, prodBranch, ...(nodeModules ? { nodeModules } : {}) };
}

export interface CommandResult { code: number; stdout: string; stderr: string }
export type RunCommand = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (line: string) => void }) => Promise<CommandResult>;

/** Default runner: a child process whose output is streamed line by line to
 * `onLine` (the build log) and also collected. Non-zero exit is a result, not
 * a rejection; spawn failures reject. */
export const runCommand: RunCommand = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  const pump = (chunk: Buffer, which: "stdout" | "stderr") => {
    const text = chunk.toString();
    if (which === "stdout") stdout += text; else stderr += text;
    if (options.onLine) for (const line of text.split("\n")) if (line.trim()) options.onLine(line.trimEnd());
  };
  child.stdout?.on("data", chunk => pump(chunk as Buffer, "stdout"));
  child.stderr?.on("data", chunk => pump(chunk as Buffer, "stderr"));
  const timer = options.timeoutMs ? setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${basename(file)} ${args[0] ?? ""} timed out after ${Math.round(options.timeoutMs! / 1000)}s`)); }, options.timeoutMs) : null;
  child.once("error", error => { if (timer) clearTimeout(timer); reject(error); });
  child.once("close", code => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
});

function gitOut(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`git ${args.join(" ")} failed in ${repo}: ${String(stderr).trim().slice(0, 300) || error.message}`));
      resolve(String(stdout));
    });
  });
}

export interface UpdateTarget { sha: string; branch: string; version: string; subject: string }

/** The commit the update would install: the prod head (or the release head
 * when the prod check is off), with the version its package.json declares. */
export async function resolveUpdateTarget(source: UpdateSource): Promise<UpdateTarget> {
  if (!source.repo) throw Object.assign(new Error("update source not configured: set OMB_UPDATE_REPO or updates/source.json to the canonical checkout"), { status: 409 });
  if (!existsSync(join(source.repo, ".git")) && !existsSync(join(source.repo, "HEAD"))) throw Object.assign(new Error(`update source ${source.repo} is not a git checkout`), { status: 409 });
  const branch = source.prodBranch || source.releaseBranch;
  let sha: string;
  try { sha = (await gitOut(source.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).trim(); }
  catch { throw Object.assign(new Error(`branch ${branch} not found in ${source.repo}`), { status: 409 }); }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Object.assign(new Error(`branch ${branch} not found in ${source.repo}`), { status: 409 });
  let version = "unknown";
  try { const pkg = JSON.parse(await gitOut(source.repo, ["show", `${sha}:package.json`])) as { version?: unknown }; if (typeof pkg.version === "string" && pkg.version) version = pkg.version; } catch { /* no package.json at that commit */ }
  const subject = (await gitOut(source.repo, ["log", "-1", "--format=%s", sha]).catch(() => "")).trim();
  return { sha, branch, version: `${version}+${sha.slice(0, 8)}`, subject };
}

export interface PreviewOptions {
  /** no-downgrade.py (the live bundle's copy; the rule set is the same as the one admission runs). */
  script: string;
  ledger: string;
  liveApp: string;
  source: UpdateSource;
  target: UpdateTarget;
  current: { version: string; sha: string };
  run?: RunCommand;
  python?: string;
}
interface PreviewVerdict { ok?: boolean; up_to_date?: boolean; reason?: string; running?: { commit?: string }; candidate?: { commit?: string } }

/** The read-only half of the guard, asked before anything is built: would a
 * build of `target` be accepted for install over the running build? A refusal
 * (exit 2) or an error is an answer, not a failure: the check reports it as
 * the reason there is nothing to install. */
export async function previewUpdate(options: PreviewOptions): Promise<UpdateCheck> {
  const { source, target } = options;
  const args = [options.script, "preview", "--live", options.liveApp, "--commit", target.sha, "--ledger", options.ledger, "--release-branch", source.releaseBranch, "--prod-branch", source.prodBranch];
  if (source.repo) args.push("--repo", source.repo);
  const at = new Date().toISOString();
  let result: CommandResult;
  try { result = await (options.run ?? runCommand)(options.python ?? "/usr/bin/python3", args, { timeoutMs: 120_000 }); }
  catch (error) { return { at, current: options.current, reason: `no-downgrade guard failed: ${error instanceof Error ? error.message : String(error)}` }; }
  let verdict: PreviewVerdict | null = null;
  try { verdict = JSON.parse(result.stdout) as PreviewVerdict; } catch { verdict = null; }
  const reason = verdict?.reason ?? result.stderr.trim().slice(0, 300);
  if (result.code !== 0 || verdict?.ok !== true) return { at, current: options.current, reason: result.code === 2 ? reason || "the no-downgrade guard said no" : `no-downgrade guard failed (exit ${result.code}): ${reason || "no output"}` };
  if (verdict.up_to_date) return { at, current: options.current, reason: reason || `up to date: running ${target.sha.slice(0, 8)} is the ${target.branch} head` };
  return { at, current: options.current, candidate: { version: target.version, sha: target.sha, branch: target.branch, ...(target.subject ? { subject: target.subject } : {}) }, reason };
}

/** PATH for the build tools. The packaged server runs on Electron's node, so
 * the build needs a real node (>= 22) and pnpm from the machine:
 * OMB_UPDATE_TOOLCHAIN_PATH wins, else the newest nvm node plus homebrew. */
export function toolchainPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = str(env.OMB_UPDATE_TOOLCHAIN_PATH);
  const parts: string[] = [];
  if (explicit) parts.push(...explicit.split(":").filter(Boolean));
  else {
    const nvm = join(home, ".nvm", "versions", "node");
    let versions: string[] = [];
    try { versions = readdirSync(nvm).filter(name => /^v\d+\.\d+\.\d+$/.test(name)); } catch { versions = []; }
    const newest = versions
      .map(name => ({ name, nums: name.slice(1).split(".").map(Number) }))
      .filter(entry => entry.nums[0] >= 22)
      .sort((a, b) => b.nums[0] - a.nums[0] || b.nums[1] - a.nums[1] || b.nums[2] - a.nums[2])[0];
    if (newest) parts.push(join(nvm, newest.name, "bin"));
    parts.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const part of (env.PATH ?? "/usr/bin:/bin").split(":")) if (part && !parts.includes(part)) parts.push(part);
  return parts.join(":");
}

export interface BuildOptions {
  dataDir: string;
  /** The bundle that is live now: the Electron shell the candidate copies. */
  liveApp: string;
  source: UpdateSource;
  target: UpdateTarget;
  /** electron/resources/updater/no-downgrade.py from the SOURCE commit (the
   * build dir has it once archived); the stamp it writes is what admission
   * later verifies. */
  python?: string;
  /** codesign identity; default: the first Authority of the live bundle's
   * signature, "-" (ad hoc) when it has none. OMB_UPDATE_SIGN_IDENTITY overrides. */
  signIdentity?: string;
  /** Skip codesign entirely (tests on fake bundles). */
  codesign?: boolean;
  /** node_modules to link into the build dir when its lockfile matches the
   * source commit's; default: <repo>/node_modules. Otherwise `pnpm install --frozen-lockfile` runs. */
  nodeModules?: string;
  run?: RunCommand;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Build timeouts: the whole build, and each command. */
  timeoutMs?: number;
  /** Test seam: the build commands, in order, run in the build dir with
   * PATH set. Default: build:server, then vite build (the ui). */
  commands?: Array<{ file: string; args: string[] }>;
}

export interface BuildOutcome { candidate: CandidateManifest & { dir: string; appPath: string }; buildDir: string; stamp: { commit: string; server_sha256: string; ui_sha256: string }; signed: string | null }

export function buildRoot(dataDir: string): string { return join(updatesDir(dataDir), "build"); }

const DEFAULT_COMMANDS = [
  { file: "pnpm", args: ["run", "build:server"] },
  { file: "pnpm", args: ["exec", "vite", "build"] },
];

/** Declared dependencies (and devDependencies: the build needs them) that are
 * not present in `nodeModules`. */
export function missingPackages(nodeModules: string, packageJson: string): string[] {
  const pkg = readJsonFile(packageJson) ?? {};
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies"]) {
    const block = pkg[key];
    if (block && typeof block === "object") for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
  }
  return [...names].filter(name => !existsSync(join(nodeModules, name, "package.json")));
}

async function signingIdentity(liveApp: string, run: RunCommand, env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = str(env.OMB_UPDATE_SIGN_IDENTITY);
  if (explicit) return explicit;
  const result = await run("/usr/bin/codesign", ["-dvv", liveApp], { timeoutMs: 30_000 }).catch(() => null);
  const authority = /^Authority=(.+)$/m.exec(result?.stderr ?? "")?.[1]?.trim();
  return authority && !/^Apple (Root|Worldwide)/.test(authority) ? authority : "-";
}

/** Build `target` into <dataDir>/updates/candidate. Any earlier candidate is
 * replaced. Throws (status 409/500) with the failing step named; the build
 * directory with its logs is kept for a failed build and removed after a
 * successful one. */
export async function buildCandidate(options: BuildOptions): Promise<BuildOutcome> {
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});
  const env = { ...(options.env ?? process.env) };
  env.PATH = toolchainPath(env);
  delete env.ELECTRON_RUN_AS_NODE;
  const { target, source } = options;
  if (!source.repo) throw Object.assign(new Error("update source not configured"), { status: 409 });
  if (!existsSync(join(options.liveApp, "Contents", "Resources"))) throw Object.assign(new Error(`live bundle missing at ${options.liveApp}`), { status: 409 });
  const buildDir = join(buildRoot(options.dataDir), target.sha.slice(0, 8));
  rmSync(buildDir, { recursive: true, force: true });
  const src = join(buildDir, "src");
  mkdirSync(src, { recursive: true, mode: 0o700 });
  const step = async (name: string, work: () => Promise<void>) => {
    log(`build: ${name}`);
    try { await work(); }
    catch (error) { throw Object.assign(new Error(`build failed at ${name}: ${error instanceof Error ? error.message : String(error)}`), { status: 500, step: name, buildDir }); }
  };
  const sh = async (file: string, args: string[], cwd: string, timeoutMs = options.timeoutMs ?? 20 * 60_000) => {
    const result = await run(file, args, { cwd, env, timeoutMs, onLine: line => log(`  ${line}`) });
    if (result.code !== 0) throw new Error(`${file} ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
    return result;
  };

  // 1. the source tree, exactly the commit, no working-tree state: git archive.
  await step(`checkout ${target.sha.slice(0, 8)}`, async () => {
    const archive = join(buildDir, "src.tar");
    await sh("git", ["-C", source.repo!, "archive", "--format=tar", "-o", archive, target.sha], buildDir, 5 * 60_000);
    await sh("/usr/bin/tar", ["-xf", archive, "-C", src], buildDir, 5 * 60_000);
    rmSync(archive, { force: true });
    if (!existsSync(join(src, "package.json"))) throw new Error("archived tree has no package.json");
  });

  // 2. dependencies: link the canonical checkout's node_modules when the
  //    lockfile is the same, install otherwise.
  await step("dependencies", async () => {
    const nodeModules = options.nodeModules ?? source.nodeModules ?? join(source.repo!, "node_modules");
    const lockHere = readFileSync(join(src, "pnpm-lock.yaml"), "utf8");
    let lockThere: string | null = null;
    try { lockThere = readFileSync(join(dirname(nodeModules), "pnpm-lock.yaml"), "utf8"); } catch { lockThere = null; }
    // The same lockfile is necessary, not sufficient: a checkout can carry a
    // stale install. Every declared package has to be present to link.
    const missing = existsSync(nodeModules) && lockThere === lockHere ? missingPackages(nodeModules, join(src, "package.json")) : null;
    if (missing && !missing.length) { symlinkSync(nodeModules, join(src, "node_modules")); log(`  node_modules linked from ${nodeModules}`); }
    else {
      log(missing ? `  node_modules at ${nodeModules} is missing ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}; installing` : `  no matching node_modules to link; installing`);
      await sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], src);
    }
  });

  // 3. the build itself.
  for (const command of options.commands ?? DEFAULT_COMMANDS) {
    await step(`${command.file} ${command.args.join(" ")}`, async () => { await sh(command.file, command.args, src); });
  }
  const distServer = join(src, "dist-server"); const distUi = join(src, "dist");
  if (!existsSync(join(distServer, "index.js"))) throw Object.assign(new Error("build failed: dist-server/index.js was not produced"), { status: 500, buildDir });
  if (!existsSync(join(distUi, "index.html"))) throw Object.assign(new Error("build failed: dist/index.html was not produced"), { status: 500, buildDir });

  // 4. tree-swap into a copy of the live bundle.
  const appName = basename(options.liveApp);
  const staged = join(buildDir, appName);
  await step("copy live bundle", async () => {
    if (process.platform === "darwin") await sh("/usr/bin/ditto", [options.liveApp, staged], buildDir, 10 * 60_000);
    else cpSync(options.liveApp, staged, { recursive: true, verbatimSymlinks: true });
  });
  const resources = join(staged, "Contents", "Resources");
  await step("swap server and ui trees", async () => {
    for (const name of ["server", "ui"]) rmSync(join(resources, name), { recursive: true, force: true });
    cpSync(distServer, join(resources, "server"), { recursive: true });
    cpSync(distUi, join(resources, "ui"), { recursive: true });
    // the companion sidecar and skills ship beside them in a packaged build;
    // a tree-swap keeps the live ones (they come from the same release line).
    const updaterSrc = join(src, "electron", "resources", "updater");
    if (existsSync(updaterSrc)) { rmSync(join(resources, "updater"), { recursive: true, force: true }); cpSync(updaterSrc, join(resources, "updater"), { recursive: true }); }
    rmSync(join(resources, "build-commit.json"), { force: true });
  });

  // 5. stamp with the source commit (the guard's own script, from the source tree).
  let stamp: BuildOutcome["stamp"] = { commit: target.sha, server_sha256: "", ui_sha256: "" };
  await step("stamp", async () => {
    const script = join(src, "electron", "resources", "updater", "no-downgrade.py");
    if (!existsSync(script)) throw new Error("source commit has no electron/resources/updater/no-downgrade.py; it predates the install guard and cannot be stamped");
    const result = await sh(options.python ?? "/usr/bin/python3", [script, "stamp", "--app", staged, "--commit", target.sha], buildDir, 5 * 60_000);
    const verdict = JSON.parse(result.stdout) as { ok?: boolean; stamp?: BuildOutcome["stamp"] };
    if (verdict.ok !== true || !verdict.stamp) throw new Error("stamp wrote no verdict");
    stamp = verdict.stamp;
    const digests = appDigests(staged);
    if (digests.server !== stamp.server_sha256 || digests.ui !== stamp.ui_sha256) throw new Error("stamp digests do not match the swapped trees");
  });

  // 6. re-sign so the bundle verifies deep+strict and keeps the live identity.
  let signed: string | null = null;
  if (options.codesign ?? true) {
    await step("codesign", async () => {
      const identity = options.signIdentity ?? await signingIdentity(options.liveApp, run, env);
      const entitlements = join(buildDir, "entitlements.plist");
      const current = await run("/usr/bin/codesign", ["-d", "--entitlements", ":-", options.liveApp], { timeoutMs: 30_000 });
      const args = ["--force", "--deep", "--sign", identity, "--options", "runtime", "--timestamp=none"];
      if (current.code === 0 && current.stdout.includes("<plist")) { writeFileSync(entitlements, current.stdout); args.push("--entitlements", entitlements); }
      await sh("/usr/bin/codesign", [...args, staged], buildDir, 10 * 60_000);
      await sh("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], buildDir, 5 * 60_000);
      signed = identity;
    });
  }

  // 7. stage: replace updates/candidate atomically enough (rename in, manifest last).
  const candidateDir = join(updatesDir(options.dataDir), CANDIDATE_DIRNAME);
  let manifest!: CandidateManifest;
  await step("stage candidate", async () => {
    rmSync(candidateDir, { recursive: true, force: true });
    mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
    renameSync(staged, join(candidateDir, appName));
    manifest = writeCandidateManifest(candidateDir, { version: target.version, sha: target.sha, app: appName });
    writeFileAtomic(join(candidateDir, "build.json"), JSON.stringify({ target, stamp, signed, builtAt: new Date().toISOString(), source: { repo: source.repo, releaseBranch: source.releaseBranch, prodBranch: source.prodBranch } }, null, 2), { mode: 0o600 });
  });
  rmSync(buildDir, { recursive: true, force: true });
  log(`build: staged ${target.version} at ${join(candidateDir, appName)}`);
  return { candidate: { ...manifest, dir: candidateDir, appPath: join(candidateDir, appName) }, buildDir, stamp, signed };
}
