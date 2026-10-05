// Update & restart behind one button (1.3). The server side of the
// /api/update contract: find out whether prod has moved (check), build and
// stage that commit (updater-build.ts), stop taking new turns and let live
// ones finish (drain), checkpoint what is still running, stop it, hand the
// swap to a detached launchd job that outlives the app, and on the next boot
// read that job's result exactly once and resume the interrupted
// conversations exactly once.
//
// Nothing here replays a prompt. A turn interrupted by the update gets ONE
// new continuation turn in its own thread that says what happened and tells
// the bot to check, not repeat, any external action whose outcome it cannot
// see. Room turns are only noted; a room re-dispatch needs the room's own
// scheduler and is not a safe thing to guess at.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { UPDATER_APPLY_SCRIPT } from "./updater-apply-script.ts";

export type UpdateState = "idle" | "ready" | "building" | "draining" | "checkpointing" | "stopping" | "applying" | "relaunching" | "verifying" | "done" | "rolled_back" | "failed";
export type UpdateMode = "update" | "restart";
export interface BusyTurn { botId: string; botName?: string; threadId: string; kind: "direct" | "room"; groupId?: string; title?: string }
export interface CandidateManifest { version: string; sha: string; stagedAt: string; app: string; serverSha256: string; uiSha256: string }
export interface Candidate extends CandidateManifest { dir: string; appPath: string }
export interface UpdateResult { state: "done" | "rolled_back" | "failed"; at: string; detail: string; updateId: string; mode: UpdateMode; rollback?: string; version?: string; sha?: string; manualRecoveryRequired?: boolean; appStillRunning?: boolean }
export interface CheckpointTurn extends BusyTurn { resumedAt?: string; resumeOutcome?: string }
export interface Checkpoint { version: 1; updateId: string; mode: UpdateMode; at: string; stoppedAt?: string; turns: CheckpointTurn[]; steers: unknown; delegations: unknown }
export interface BuildRef { version: string; sha: string }
/** What `check` found: the commit the update would install, or why there is
 * nothing to install. `candidate` is present only when a build of that
 * commit would pass the no-downgrade guard. */
export interface UpdateCheck {
  at: string;
  current: BuildRef;
  candidate?: BuildRef & { branch: string; subject?: string; stagedAt?: string; delivery?: "staged-full" };
  shellRequired?: boolean;
  upToDate?: boolean;
  reason?: string;
}
export interface UpdateLastResult {
  state: UpdateResult["state"]; at: string; detail: string; updateId?: string; mode?: UpdateMode; rollback?: string; version?: string; sha?: string;
  /** The build that was running when the update started, and the one running after it. */
  from?: BuildRef; to?: BuildRef;
  /** The build the update tried to install (differs from `to` after a rollback or failure). */
  attempted?: BuildRef;
}
export interface UpdateStatus {
  state: UpdateState; updateId?: string; detail?: string;
  current: BuildRef;
  /** The staged build, or the one `check` found; `branch` is set when it came from a check. */
  candidate?: BuildRef & { stagedAt?: string; branch?: string; delivery?: "staged-full" };
  shellRequired?: boolean;
  upToDate?: boolean;
  reason?: string;
  busyTurns: Array<{ botId: string; botName?: string; threadId: string }>;
  /** The last `check`, so the ui can show "checked 2 minutes ago: up to date". */
  lastCheck?: { at: string; reason?: string };
  /** The last finished update. Omitted while another one is in flight: then `state` is the whole story. */
  lastResult?: UpdateLastResult;
}
export interface UpdateProgress {
  state: UpdateState; updateId?: string; detail?: string; startedAt?: string; mode?: UpdateMode;
  steps: Array<{ state: UpdateState; at: string; detail: string }>;
  /** The tail of the build output, newest last. */
  log: string[];
}
export interface UpdateEvent { kind: "update.state"; type: "update.state"; state: UpdateState; updateId: string; detail: string }
export interface ApplyPlan {
  updateId: string; label: string; mode: UpdateMode; live: string; staged: string | null; backup: string | null;
  appPid: number | null; appIdentity: string | null; ports: number[]; health: string; expect: { server: string; ui: string } | null;
  old: { server: string; ui: string } | null; oldVersion: string; oldSha: string; version: string; sha: string; force: boolean;
  launch: string[]; resultPath: string; installedPath: string; gracefulSeconds: number; healthSeconds: number;
  codesign: boolean; selfBootout: boolean; requireLaunchd: boolean; uid: number | null; scriptSha256: string;
  /** The no-downgrade guard the detached job runs ITSELF before it stops the
   * app: a copy of the shipped script beside apply.py (sha256 pinned here)
   * plus the ledger, repo and branches admission judged with. null = not
   * configured (dev run, sandbox) or a restart. */
  guard: ApplyGuard | null;
  /** Packaged build: apply.py refuses an update plan that carries no guard,
   * so a plan written by hand cannot skip the check. */
  guardRequired: boolean;
  /** Test-only (OMB_UPDATE_SANDBOX): "the app" is whoever listens on ports[0]; no launchd; relaunch is left to a supervisor. */
  sandbox?: boolean; fault?: string | null;
}
export interface ApplyGuard { script: string; scriptSha256: string; ledger: string; repo?: string; releaseBranch?: string; prodBranch?: string }
/** The platform-neutral part of a plan: what any executor needs to swap or
 * relaunch and to write result.json where boot() will look for it. */
export type ExecutorPlan = Pick<ApplyPlan, "updateId" | "mode" | "version" | "sha" | "oldVersion" | "oldSha" | "force" | "resultPath" | "installedPath" | "health" | "ports" | "gracefulSeconds" | "healthSeconds">;
export interface ExecutorCandidate { version: string; sha: string; stagedAt: string }
type ExecutionCandidate = ExecutorCandidate | null;
/** The platform seam. The coordinator owns admission order, checkpoint,
 * stop, quiesce, plan.json and result/resume; the executor owns how the
 * machine swaps and relaunches. `createDarwinExecutor` wraps launchd and
 * the detached python job; `updater-executor-electron.ts` asks the Electron
 * main process over the private utility port (win32). */
export interface UpdateExecutor {
  /** The staged build, if any. */
  candidate(): Promise<ExecutorCandidate | null>;
  /** Refuse (throw with status 409) when the machine cannot take an update now. Returns notes worth logging. */
  admit(mode: UpdateMode): Promise<string[]>;
  /** Ports the app must own again after relaunch; health is probed on the first. */
  ports(): Promise<number[]>;
  /** Resolves when the handoff is accepted: the executor WILL quit this
   * process and write plan.resultPath afterwards. Resolving is not "finished".
   * A rejection carrying `pending: true` means the executor may already own
   * the handoff; the coordinator then holds its lock and never retries. */
  execute(plan: ExecutorPlan, dir: string): Promise<void>;
  /** After a finished update: record the now-live bundle as the running
   * build (the no-downgrade ledger). Returns a note, or null when there is
   * nothing to record. Never refuses, never touches the app. */
  recordInstalled?(): Promise<string | null>;
}
export interface UpdateBuilder {
  /** Is there something to install? Never builds; answers from git and the ledger. */
  check(): Promise<UpdateCheck>;
  /** Build and stage `target` as the candidate; `log` receives build output. */
  build(target: BuildRef & { branch: string }, log: (line: string) => void): Promise<void>;
}
export interface UpdaterHooks {
  dataDir: string;
  current: () => { version: string; sha: string };
  listBusyTurns: () => BusyTurn[];
  stopAll: () => Promise<void>;
  checkpointExtras: () => { steers: unknown; delegations: unknown };
  /** Stop admitting new turns while the live ones finish (the drain). Lifted by `unquiesce`. */
  drain?: () => void;
  /** Lock the workspace against new work, pause schedulers, flush to disk. */
  quiesce: () => Promise<void>;
  /** Reopen the workspace: lifts the drain and the quiesce, whichever happened. */
  unquiesce: () => void;
  /** When set, `apply` builds the commit `check` found instead of needing a pre-staged candidate. */
  builder?: UpdateBuilder;
  executor: UpdateExecutor;
  emit: (event: UpdateEvent) => void;
  /** Continue one interrupted conversation. Called at most once per turn. */
  resumeTurn: (turn: CheckpointTurn, result: UpdateResult) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stopWaitMs?: number;
  resultWaitMs?: number;
  log?: (line: string) => void;
}

export interface LaunchdJobDetails { keepAlive: boolean; runAtLoad: boolean; program?: string | null; plist?: string | null }
/** What the darwin executor needs from the machine. `updater-host.ts` has
 * the launchd implementation and a sandbox one; tests pass fakes. */
export interface UpdaterHost {
  /** Raw `launchctl list` output. */
  launchdList(): Promise<string>;
  /** KeepAlive/RunAtLoad of a loaded job, or null when launchd will not say. */
  jobDetails(uid: number | null, label: string): Promise<LaunchdJobDetails | null>;
  /** Start the one-shot job described by the plist (launchctl bootstrap). */
  bootstrap(uid: number | null, plistPath: string): Promise<void>;
  /** Remove a finished job of ours so it cannot block the next update. */
  bootout(uid: number | null, label: string): Promise<void>;
  /** Ports the app must own again after relaunch; health is probed on the first. */
  listeningPorts(): Promise<number[]>;
  appProcess(): Promise<{ pid: number | null; identity: string | null }>;
}

export const UPDATE_JOB_PREFIX = "ai.bos.bot.update.";
export const CANDIDATE_DIRNAME = "candidate";

export function updatesDir(dataDir: string): string { return join(dataDir, "updates"); }

/** Same digest as the hand-rolled installers used, so manifests stay comparable. */
export function treeDigest(appPath: string, name: "server" | "ui"): string {
  const root = join(appPath, "Contents", "Resources", name);
  if (!existsSync(root)) throw new Error(`${name} tree missing in ${appPath}`);
  const hash = createHash("sha256");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
  for (const file of walk(root).sort((a, b) => (a.slice(root.length + 1) < b.slice(root.length + 1) ? -1 : 1))) {
    hash.update(file.slice(root.length + 1)); hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

export function appDigests(appPath: string): { server: string; ui: string } {
  return { server: treeDigest(appPath, "server"), ui: treeDigest(appPath, "ui") };
}

const manifestFields: Array<keyof CandidateManifest> = ["version", "sha", "stagedAt", "app", "serverSha256", "uiSha256"];

/** The staged update, if any: <dataDir>/updates/candidate/{manifest.json, <app>}. */
export function discoverCandidate(dataDir: string): Candidate | null {
  const dir = join(updatesDir(dataDir), CANDIDATE_DIRNAME);
  let raw: string;
  try { raw = readFileSync(join(dir, "manifest.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const field of manifestFields) if (typeof parsed[field] !== "string" || !(parsed[field] as string)) throw new Error(`candidate manifest is missing ${field}`);
  const app = parsed.app as string;
  if (app.includes("/") || app.includes("..") || !app.endsWith(".app")) throw new Error("candidate manifest names an app outside its directory");
  const appPath = join(dir, app);
  if (!existsSync(join(appPath, "Contents"))) throw new Error(`staged app missing: ${appPath}`);
  return { ...(parsed as unknown as CandidateManifest), dir, appPath };
}

/** Write a candidate manifest for a staged bundle, hashing its trees. */
export function writeCandidateManifest(dir: string, input: { version: string; sha: string; app: string; stagedAt?: string }): CandidateManifest {
  const appPath = join(dir, input.app);
  const digests = appDigests(appPath);
  const manifest: CandidateManifest = { version: input.version, sha: input.sha, stagedAt: input.stagedAt ?? new Date().toISOString(), app: input.app, serverSha256: digests.server, uiSha256: digests.ui };
  writeFileAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function readInstalled(dataDir: string): { version: string; sha: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(updatesDir(dataDir), "installed.json"), "utf8")) as { version?: unknown; sha?: unknown };
    return typeof parsed.version === "string" && typeof parsed.sha === "string" ? { version: parsed.version, sha: parsed.sha } : null;
  } catch { return null; }
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One-shot launchd agent: runs the detached updater once, never keeps it alive. */
export function updaterPlist(label: string, dir: string, python = "/usr/bin/python3"): string {
  const args = [python, join(dir, "apply.py")].map(arg => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', "<dict>",
    "\t<key>Label</key>", `\t<string>${xml(label)}</string>`,
    "\t<key>ProgramArguments</key>", "\t<array>", args, "\t</array>",
    "\t<key>RunAtLoad</key>", "\t<true/>",
    "\t<key>KeepAlive</key>", "\t<false/>",
    "\t<key>LaunchOnlyOnce</key>", "\t<true/>",
    "\t<key>StandardOutPath</key>", `\t<string>${xml(join(dir, "apply.stdout.log"))}</string>`,
    "\t<key>StandardErrorPath</key>", `\t<string>${xml(join(dir, "apply.stderr.log"))}</string>`,
    "</dict>", "</plist>", "",
  ].join("\n");
}

/** `launchctl list` rows → our own finished one-shots (boot them out), jobs
 * that are running now (refuse), and loaded foreign install/restart jobs that
 * are idle (ask launchd whether they would come back: `jobBlocks`). */
export function classifyLaunchdJobs(listing: string): { running: string[]; idle: string[]; staleOwn: string[] } {
  const running: string[] = []; const idle: string[] = []; const staleOwn: string[] = [];
  for (const line of listing.split("\n").slice(1)) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (!label) continue;
    const live = pid !== undefined && pid !== "-";
    if (label.startsWith(UPDATE_JOB_PREFIX)) { (live ? running : staleOwn).push(label); continue; }
    // The app's own LaunchServices job (application.<bundle id>.<n>) is the app, not an orphan.
    if (label.startsWith("application.")) continue;
    if (/bos|maus/i.test(label) && /install|updat|restart|keepalive|relaunch|steer/i.test(label)) (live ? running : idle).push(label);
  }
  return { running, idle, staleOwn };
}

/** An idle loaded job blocks only when launchd would run it again by itself:
 * KeepAlive, or RunAtLoad on a job whose purpose is to restart/relaunch the
 * app. A finished one-shot install job just sits there; report it. */
export function jobBlocks(label: string, details: LaunchdJobDetails | null): string | null {
  if (!details) return null;
  if (details.keepAlive) return "KeepAlive";
  if (details.runAtLoad && /restart|relaunch|keepalive/i.test(`${label} ${details.program ?? ""}`)) return "RunAtLoad restart";
  return null;
}

/** Output of electron/resources/updater/preflight.py (read-only, prints
 * json; shipped at Contents/Resources/updater/preflight.py). The update is
 * admitted only on ok=true with no live install job; idle one-shot install
 * jobs are reported, never blocking. */
export interface PreflightReport { ok?: boolean; checks?: { blocking_jobs?: string[]; idle_jobs?: string[]; health_ok?: boolean; health_pid_is_server?: boolean; single_main_app?: boolean }; launchd?: Array<{ label?: string; reason?: string; state?: string }> }
export function preflightVerdict(report: PreflightReport): { refuse: string | null; blocking: string[]; failed: string[]; notes: string[] } {
  const checks = report.checks ?? {};
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];
  const blocking = strings(checks.blocking_jobs);
  const idle = strings(checks.idle_jobs);
  const failed = (["health_ok", "health_pid_is_server", "single_main_app"] as const).filter(key => checks[key] === false);
  const notes: string[] = [];
  if (idle.length) notes.push(`preflight: idle install jobs loaded, not blocking: ${idle.join(", ")}`);
  let refuse: string | null = null;
  if (blocking.length) refuse = `preflight found live install jobs: ${blocking.join(", ")}`;
  else if (report.ok !== true) refuse = `preflight not ok${failed.length ? ` (${failed.join(", ")})` : report.ok === false ? "" : " (no verdict in its report)"}`;
  return { refuse, blocking, failed, notes };
}

export function updateDir(dataDir: string, updateId: string): string { return join(updatesDir(dataDir), updateId); }

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function readCheckpoint(dataDir: string, updateId: string): Checkpoint | null {
  return readJson<Checkpoint>(join(updateDir(dataDir, updateId), "checkpoint.json"));
}

export function readResult(dataDir: string, updateId: string): UpdateResult | null {
  return readJson<UpdateResult>(join(updateDir(dataDir, updateId), "result.json"));
}

/** Update directories whose job was started and whose result nobody has read. */
export function pendingUpdates(dataDir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(updatesDir(dataDir)); } catch { return []; }
  return entries.filter(name => /^[0-9a-f-]{36}$/.test(name) &&
    existsSync(join(updatesDir(dataDir), name, "plan.json")) && !existsSync(join(updatesDir(dataDir), name, "consumed.json")))
    .sort((a, b) => statSync(join(updatesDir(dataDir), a, "plan.json")).mtimeMs - statSync(join(updatesDir(dataDir), b, "plan.json")).mtimeMs);
}

export function resumePrompt(_turn: CheckpointTurn, result: UpdateResult): string {
  const what = result.state === "done"
    ? (result.mode === "update" ? `BOS was updated to ${result.version ?? "a new build"} and restarted` : "BOS was restarted")
    : `BOS tried to update, rolled back (${result.detail}) and restarted`;
  // The interrupted request is not quoted back: the transcript already has it,
  // and a quoted instruction reads like a fresh one to do again.
  return `${what} while you were mid-turn in this conversation. Continue from where you stopped. ` +
    "Read the transcript above first. Any external action you started whose outcome is not visible here (a message, a post, a file write, a command, a payment) is " +
    "\"interrupted, check\": verify whether it happened before doing it again, and say so if you cannot tell. Do not redo work that already shows a result.";
}

const err = (message: string, status: number) => Object.assign(new Error(message), { status });
const isPending = (error: unknown): boolean => Boolean(error) && typeof error === "object" && (error as { pending?: unknown }).pending === true;

const BUILD_LOG_TAIL = 200;

export class UpdateCoordinator {
  private state: UpdateState = "idle";
  private updateId: string | null = null;
  private detail = "";
  private mode: UpdateMode | null = null;
  private startedAt: string | null = null;
  private steps: UpdateProgress["steps"] = [];
  private buildLog: string[] = [];
  private lastCheck: UpdateCheck | null = null;
  private checking: Promise<UpdateCheck> | null = null;
  private lastResult: UpdateLastResult | undefined;
  private running = false;
  private readonly hooks: UpdaterHooks;
  constructor(hooks: UpdaterHooks) {
    this.hooks = hooks;
    mkdirSync(updatesDir(hooks.dataDir), { recursive: true });
    this.lastResult = readJson<UpdateLastResult>(join(updatesDir(hooks.dataDir), "last-result.json")) ?? undefined;
    this.lastCheck = readJson<UpdateCheck>(join(updatesDir(hooks.dataDir), "last-check.json"));
  }
  private now(): Date { return (this.hooks.now ?? (() => new Date()))(); }
  private sleep(ms: number): Promise<void> { return (this.hooks.sleep ?? (m => new Promise(resolve => setTimeout(resolve, m))))(ms); }
  private log(line: string): void { (this.hooks.log ?? (() => {}))(`[update] ${line}`); }
  private set(state: UpdateState, detail = ""): void {
    this.state = state; this.detail = detail;
    this.log(`${state}${detail ? `: ${detail}` : ""}`);
    this.steps.push({ state, at: this.now().toISOString(), detail });
    if (this.updateId) {
      try { writeFileAtomic(join(updateDir(this.hooks.dataDir, this.updateId), "timeline.json"), JSON.stringify({ mode: this.mode, startedAt: this.startedAt, steps: this.steps }), { mode: 0o600 }); }
      catch { /* the directory is gone or not ours; the event still goes out */ }
    }
    this.hooks.emit({ kind: "update.state", type: "update.state", state, updateId: this.updateId ?? "", detail });
  }
  /** Replace the detail of the current state without a new step (the drain countdown). */
  private refine(detail: string): void {
    if (detail === this.detail) return;
    this.detail = detail;
    const last = this.steps.at(-1);
    if (last && last.state === this.state) last.detail = detail;
    this.hooks.emit({ kind: "update.state", type: "update.state", state: this.state, updateId: this.updateId ?? "", detail });
  }

  /** The update this process is driving or finishing, if any. */
  get id(): string | null { return this.running ? this.updateId : null; }

  private busySummary(turns: BusyTurn[]): string {
    const names = [...new Set(turns.map(turn => turn.botName ?? turn.botId))];
    return names.length ? `waiting for ${names.length} bot${names.length === 1 ? "" : "s"}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}` : "no bots busy";
  }

  async status(): Promise<UpdateStatus> {
    const staged = await this.candidateSafe();
    const found = this.lastCheck?.candidate;
    const candidate: UpdateStatus["candidate"] | undefined = this.hooks.builder ? (found ? { ...found, ...(staged && staged.sha === found.sha ? { stagedAt: staged.stagedAt } : {}) } : undefined) : staged
      ? { version: staged.version, sha: staged.sha, stagedAt: staged.stagedAt, ...(found && found.sha === staged.sha ? { branch: found.branch } : {}) }
      : found ? { version: found.version, sha: found.sha, branch: found.branch } : undefined;
    const state: UpdateState = this.running ? this.state : candidate ? "ready" : "idle";
    return {
      state, ...(this.updateId ? { updateId: this.updateId } : {}), ...(this.detail ? { detail: this.detail } : {}),
      current: this.hooks.current(),
      ...(this.lastCheck ? { shellRequired: this.lastCheck.shellRequired, upToDate: this.lastCheck.upToDate, reason: this.lastCheck.reason } : {}),
      ...(candidate ? { candidate } : {}),
      busyTurns: this.hooks.listBusyTurns().map(turn => ({ botId: turn.botId, ...(turn.botName ? { botName: turn.botName } : {}), threadId: turn.threadId })),
      ...(this.lastCheck ? { lastCheck: { at: this.lastCheck.at, ...(this.lastCheck.reason ? { reason: this.lastCheck.reason } : {}) } } : {}),
      ...(this.lastResult && !this.running ? { lastResult: this.lastResult } : {}),
    };
  }
  progress(): UpdateProgress {
    return {
      state: this.running ? this.state : (this.steps.at(-1)?.state ?? "idle"), ...(this.updateId ? { updateId: this.updateId } : {}), ...(this.detail ? { detail: this.detail } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}), ...(this.mode ? { mode: this.mode } : {}),
      steps: [...this.steps], log: this.buildLog.slice(-BUILD_LOG_TAIL),
    };
  }
  private async candidateSafe(): Promise<ExecutorCandidate | null> {
    try { return await this.hooks.executor.candidate(); }
    catch (error) { this.log(`candidate unreadable: ${error instanceof Error ? error.message : String(error)}`); return null; }
  }

  /** Ask the builder whether prod has moved past the running build. Cheap
   * (git + the ledger), never builds. Concurrent calls share one run. The
   * answer is kept so `status` can show it. Without a builder, the staged
   * candidate (if any) is the answer. */
  check(): Promise<UpdateCheck> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let result: UpdateCheck;
      if (this.hooks.builder) {
        try { result = await this.hooks.builder.check(); }
        catch (error) { result = { at: this.now().toISOString(), current: this.hooks.current(), reason: `check failed: ${error instanceof Error ? error.message : String(error)}` }; }
      } else {
        const staged = await this.candidateSafe();
        result = { at: this.now().toISOString(), current: this.hooks.current(), ...(staged ? { candidate: { version: staged.version, sha: staged.sha, branch: "staged", stagedAt: staged.stagedAt } } : { reason: "no staged update and no build source configured" }) };
      }
      this.lastCheck = result;
      this.log(`check: ${result.candidate ? `candidate ${result.candidate.version} (${result.candidate.sha.slice(0, 8)}) on ${result.candidate.branch}` : result.reason ?? "nothing"}`);
      try { writeFileAtomic(join(updatesDir(this.hooks.dataDir), "last-check.json"), JSON.stringify(result), { mode: 0o600 }); } catch { /* informational */ }
      return result;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  apply(options: { force?: boolean } = {}): Promise<{ updateId: string; notes?: string[]; inProgress?: boolean }> { return this.start("update", Boolean(options.force)); }
  restart(options: { force?: boolean } = {}): Promise<{ updateId: string; notes?: string[]; inProgress?: boolean }> { return this.start("restart", Boolean(options.force)); }

  private async start(mode: UpdateMode, force: boolean): Promise<{ updateId: string; notes?: string[]; inProgress?: boolean }> {
    // Idempotent: a second press while one is running is the same update.
    if (this.running && this.updateId) return { updateId: this.updateId, inProgress: true };
    const builds = mode === "update" && Boolean(this.hooks.builder);
    let candidate: ExecutorCandidate | null = null;
    let target: UpdateCheck["candidate"] | undefined;
    let notes: string[] = [];
    if (builds) {
      // The build comes first (bots keep working through it), so admission of
      // the staged bundle (preflight, guard, launchd) happens in drive() once
      // there is something to admit. The check is the cheap pre-answer.
      const check = await this.check();
      if (!check.candidate) throw err(check.reason ?? "nothing to update", 409);
      if (check.candidate.delivery === "staged-full") {
        candidate = await this.hooks.executor.candidate();
        if (!candidate || candidate.sha !== check.candidate.sha || candidate.version !== check.candidate.version) throw err("full candidate changed since check; stage and check again", 409);
        notes = await this.hooks.executor.admit(mode);
        for (const note of notes) this.log(note);
      } else target = check.candidate;
    } else {
      candidate = mode === "update" ? await this.hooks.executor.candidate() : null;
      if (mode === "update" && !candidate) throw err("no staged update to apply", 409);
      notes = await this.hooks.executor.admit(mode);
      for (const note of notes) this.log(note);
    }
    const lockPath = join(updatesDir(this.hooks.dataDir), "apply.lock");
    const updateId = randomUUID();
    // One owner. The in-memory flag guards this process; the file guards
    // against a second server on the same data dir. boot() clears it.
    if (this.running && this.updateId) return { updateId: this.updateId, inProgress: true };
    if (existsSync(lockPath)) throw err("another update owns the lock; restart BOS if nothing is running", 409);
    try { writeFileSync(lockPath, JSON.stringify({ updateId, pid: process.pid, at: this.now().toISOString() }), { flag: "wx", mode: 0o600 }); }
    catch { throw err("another update owns the lock; restart BOS if nothing is running", 409); }
    this.running = true; this.updateId = updateId; this.mode = mode; this.startedAt = this.now().toISOString(); this.steps = []; this.buildLog = []; this.detail = "";
    const dir = updateDir(this.hooks.dataDir, updateId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Everything after this runs detached from the request: the caller gets
    // 202 + updateId now and follows update.state events.
    void this.drive(mode, force, candidate, target, dir).catch(error => this.fail(updateId, mode, error));
    return { updateId, ...(notes.length ? { notes } : {}) };
  }

  /** The handoff never happened: say so, and if plan.json already exists make
   * sure the next boot does not wait for a job that was never started. */
  private fail(updateId: string, mode: UpdateMode, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (existsSync(join(updateDir(this.hooks.dataDir, updateId), "plan.json"))) {
      if (!readResult(this.hooks.dataDir, updateId)) this.consume(updateId, { state: "failed", at: this.now().toISOString(), detail, updateId, mode });
    } else {
      // Nothing was planned, so nothing changed: the running build is still
      // the live one. Still the last thing that happened, so the ui shows it.
      const current = this.hooks.current();
      this.lastResult = { state: "failed", at: this.now().toISOString(), detail, updateId, mode, from: current, to: current };
      try { writeFileAtomic(join(updatesDir(this.hooks.dataDir), "last-result.json"), JSON.stringify(this.lastResult), { mode: 0o600 }); } catch { /* informational */ }
    }
    this.set("failed", detail);
    this.finish();
  }

  private finish(): void {
    this.running = false;
    try { this.hooks.unquiesce(); } catch { /* nothing to resume */ }
    try { unlinkSync(join(updatesDir(this.hooks.dataDir), "apply.lock")); } catch { /* already gone */ }
  }

  private async drive(mode: UpdateMode, force: boolean, candidate: ExecutionCandidate, target: UpdateCheck["candidate"] | undefined, dir: string): Promise<void> {
    const updateId = this.updateId!;
    if (target && this.hooks.builder) {
      this.set("building", `building ${target.version} from ${target.branch}`);
      const logPath = join(dir, "build.log");
      await this.hooks.builder.build(target, line => {
        this.buildLog.push(line); if (this.buildLog.length > BUILD_LOG_TAIL * 2) this.buildLog.splice(0, this.buildLog.length - BUILD_LOG_TAIL);
        try { appendFileSync(logPath, `${line}\n`); } catch { /* log only */ }
      });
      // Now there is a staged bundle: preflight, the no-downgrade guard and
      // launchd judge it exactly as a pre-staged one. A refusal here fails
      // the update with nothing touched (no drain happened yet).
      const notes = await this.hooks.executor.admit("update");
      for (const note of notes) this.log(note);
      candidate = await this.hooks.executor.candidate();
      if (!candidate) throw err("the build left no staged candidate", 500);
      if (candidate.sha !== target.sha) throw err(`staged candidate is ${candidate.sha.slice(0, 8)}, not the ${target.sha.slice(0, 8)} that was checked`, 409);
    }

    // Drain: no new turns; live ones get a bounded chance to finish. The
    // press is the approval to interrupt whatever is left when time is up.
    const waitMs = this.hooks.stopWaitMs ?? 90_000;
    let busy = this.hooks.listBusyTurns();
    this.hooks.drain?.();
    this.set("draining", force ? "stopping turns now" : busy.length ? `${this.busySummary(busy)} (up to ${Math.round(waitMs / 1000)}s)` : "no bots busy");
    if (!force) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && busy.length) {
        await this.sleep(500);
        busy = this.hooks.listBusyTurns();
        if (busy.length) this.refine(`${this.busySummary(busy)} (${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s left)`);
      }
    }
    // Whatever is still running now is what the update interrupts: save it first.
    this.set("checkpointing", busy.length ? `saving ${busy.length} interrupted turn${busy.length === 1 ? "" : "s"}` : "");
    const extras = this.hooks.checkpointExtras();
    const checkpoint: Checkpoint = { version: 1, updateId, mode, at: this.now().toISOString(), turns: this.hooks.listBusyTurns(), ...extras };
    checkpoint.stoppedAt = this.now().toISOString();
    writeFileAtomic(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });

    this.set("stopping", checkpoint.turns.length ? `interrupting ${checkpoint.turns.length} turn${checkpoint.turns.length === 1 ? "" : "s"}` : "");
    await this.hooks.stopAll();
    const settle = Date.now() + 15_000;
    while (Date.now() < settle && this.hooks.listBusyTurns().length) await this.sleep(250);
    await this.hooks.quiesce();

    this.set("applying", mode === "update" ? `installing ${candidate!.version} (${candidate!.sha.slice(0, 8)})` : "restarting");
    const ports = await this.hooks.executor.ports();
    if (!ports.length) throw err("cannot tell which port the app is listening on", 409);
    const current = this.hooks.current();
    const plan: ExecutorPlan = {
      updateId, mode, version: candidate?.version ?? current.version, sha: candidate?.sha ?? current.sha, oldVersion: current.version, oldSha: current.sha, force,
      resultPath: join(dir, "result.json"), installedPath: join(updatesDir(this.hooks.dataDir), "installed.json"),
      health: `http://127.0.0.1:${ports[0]}/api/health`, ports, gracefulSeconds: 45, healthSeconds: 90,
    };
    // plan.json is what marks this update as pending for the next boot. The
    // darwin executor rewrites it with its own extras before launchd starts.
    writeFileAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
    try { await this.hooks.executor.execute(plan, dir); }
    catch (error) {
      if (!isPending(error)) throw error;
      // The executor may already own the handoff (it recorded intent and
      // then could not tell us whether it dispatched). Nothing here may run
      // again: keep the lock and the quiesced workspace, keep watching for a
      // result, and let a restart (ours or the user's) settle it through boot().
      this.set("applying", `handoff uncertain: ${error instanceof Error ? error.message : String(error)}. holding the workspace until BOS restarts`);
      void this.watch(updateId);
      return;
    }
    void this.watch(updateId);
  }

  /** The executor quits this process. If instead a result shows up while we
   * are still alive, the job gave up before the swap: report it and reopen. */
  private async watch(updateId: string): Promise<void> {
    const deadline = Date.now() + (this.hooks.resultWaitMs ?? 180_000);
    while (Date.now() < deadline) {
      await this.sleep(1000);
      const result = readResult(this.hooks.dataDir, updateId);
      if (result) {
        this.consume(updateId, result);
        this.set(result.state, result.detail);
        this.finish();
        return;
      }
    }
  }

  private consume(updateId: string, result: UpdateResult): void {
    const dir = updateDir(this.hooks.dataDir, updateId);
    const plan = readJson<Partial<ExecutorPlan>>(join(dir, "plan.json"));
    const from: BuildRef | undefined = plan?.oldVersion && plan.oldSha ? { version: plan.oldVersion, sha: plan.oldSha } : undefined;
    const attempted: BuildRef | undefined = plan?.mode === "update" && plan.version && plan.sha ? { version: plan.version, sha: plan.sha } : undefined;
    // After a rollback or a failure the old build is still the live one.
    const to: BuildRef | undefined = result.state === "done" && result.version && result.sha ? { version: result.version, sha: result.sha } : from;
    this.lastResult = { state: result.state, at: result.at, detail: result.detail, updateId, mode: result.mode, ...(result.rollback ? { rollback: result.rollback } : {}),
      ...(result.version ? { version: result.version } : {}), ...(result.sha ? { sha: result.sha } : {}),
      ...(from ? { from } : {}), ...(to ? { to } : {}), ...(attempted ? { attempted } : {}) };
    writeFileAtomic(join(updatesDir(this.hooks.dataDir), "last-result.json"), JSON.stringify(this.lastResult), { mode: 0o600 });
    writeFileAtomic(join(dir, "consumed.json"), JSON.stringify({ at: this.now().toISOString(), pid: process.pid }), { mode: 0o600 });
  }

  /** Call once after the server is listening. Finds the update that quit the
   * previous process, waits for its job to write a result (the job finishes
   * its health check after we are already up), records it once, and resumes
   * each interrupted turn exactly once. */
  async boot(): Promise<void> {
    // A fresh process means no update is driving from memory; a leftover
    // lock belongs to the process that just quit (or died mid-admission).
    try { unlinkSync(join(updatesDir(this.hooks.dataDir), "apply.lock")); } catch { /* none */ }
    const pending = pendingUpdates(this.hooks.dataDir);
    if (!pending.length) return;
    this.running = true;
    for (const updateId of pending) {
      this.updateId = updateId;
      const timeline = readJson<{ mode?: UpdateMode; startedAt?: string; steps?: UpdateProgress["steps"] }>(join(updateDir(this.hooks.dataDir, updateId), "timeline.json"));
      this.mode = timeline?.mode ?? null; this.startedAt = timeline?.startedAt ?? null; this.steps = timeline?.steps ?? [];
      this.set("verifying", "finishing the previous update");
      const deadline = Date.now() + (this.hooks.resultWaitMs ?? 180_000);
      let result = readResult(this.hooks.dataDir, updateId);
      while (!result && Date.now() < deadline) { await this.sleep(1000); result = readResult(this.hooks.dataDir, updateId); }
      result ??= { state: "failed", at: this.now().toISOString(), detail: "the updater left no result; the app is running whatever is installed", updateId, mode: "update" };
      this.consume(updateId, result);
      if (result.state === "done" && result.mode === "update" && this.hooks.executor.recordInstalled) {
        try { const note = await this.hooks.executor.recordInstalled(); if (note) this.log(note); }
        catch (error) { this.log(`no-downgrade ledger not updated: ${error instanceof Error ? error.message : String(error)}`); }
      }
      this.set(result.state, result.detail);
      await this.resumeInterrupted(updateId, result);
    }
    this.running = false;
  }

  private async resumeInterrupted(updateId: string, result: UpdateResult): Promise<void> {
    const checkpoint = readCheckpoint(this.hooks.dataDir, updateId);
    if (!checkpoint) return;
    const path = join(updateDir(this.hooks.dataDir, updateId), "checkpoint.json");
    for (const turn of checkpoint.turns) {
      if (turn.resumedAt) continue;
      // Mark before dispatch: a crash in between loses one continuation
      // rather than sending it twice.
      turn.resumedAt = this.now().toISOString();
      writeFileAtomic(path, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
      try { turn.resumeOutcome = await this.hooks.resumeTurn(turn, result); }
      catch (error) { turn.resumeOutcome = `failed: ${error instanceof Error ? error.message : String(error)}`; }
      writeFileAtomic(path, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
    }
  }

  /** Test seam: wait for the detached watcher. */
  get active(): boolean { return this.running; }
}

// ── darwin executor: launchd + the detached python job ────────────────────

export interface DarwinExecutorOptions {
  dataDir: string;
  liveApp: string;
  codesign?: boolean;
  requireLaunchd?: boolean;
  uid?: number | null;
  /** Contents/Resources/updater/preflight.py (process.resourcesPath in the
   * packaged app; OMB_UPDATER_PREFLIGHT overrides for dev/test). Undefined =
   * no preflight configured (dev run): skipped with a note. */
  preflight?: string;
  /** Packaged build: a missing preflight script refuses the update instead of skipping it. */
  requirePreflight?: boolean;
  /** Test-only (OMB_UPDATE_SANDBOX=1): a staged bundle outside updates/candidate and a fault to inject. */
  sandbox?: { stagedPath?: string; fault?: string };
  /** Contents/Resources/updater/no-downgrade.py: refuses any staged build that
   * is not stamped, not newer than the running build, not on the release
   * branch, or not the prod head. Undefined = not configured (dev run,
   * sandbox): skipped with a note. */
  noDowngrade?: NoDowngradeOptions;
  runPreflight?: (path: string) => Promise<string>;
  log?: (line: string) => void;
}

/** A bundle at an arbitrary path described like a staged candidate: version
 * from its Info.plist, sha = its server tree digest. Sandbox only. */
export function describeStagedApp(appPath: string): Candidate {
  const digests = appDigests(appPath);
  let version = "unknown";
  try {
    const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
    version = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() || version;
  } catch { /* no plist */ }
  return { version, sha: digests.server, stagedAt: statSync(appPath).mtime.toISOString(), app: basename(appPath), serverSha256: digests.server, uiSha256: digests.ui, dir: dirname(appPath), appPath };
}

export interface NoDowngradeOptions {
  /** The shipped script (OMB_UPDATER_NO_DOWNGRADE overrides for dev/test). */
  script: string;
  /** <dataDir>/updates/live-build.json: what is running, and what ran before it. */
  ledger: string;
  /** Canonical checkout the ancestry is checked in; the ledger's value when omitted. */
  repo?: string;
  /** Branch every live build must be reachable from; the ledger's value when omitted. */
  releaseBranch?: string;
  /** Branch whose head is the only build allowed to go live; "" turns the prod check off. The script defaults to "prod". */
  prodBranch?: string;
  /** Packaged build: a missing script refuses the update instead of skipping the guard. */
  require?: boolean;
  /** Test seam: runs the script with its arguments; exit 2 = refused, 0 = allowed. */
  run?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface NoDowngradeVerdict { ok?: boolean; reason?: string; running?: { commit?: string }; candidate?: { commit?: string | null } }

function defaultRunGuard(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/python3", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
      if (error && code < 0) return reject(new Error(`${String(stderr).trim().slice(0, 300) || error.message}`));
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function guardArgs(options: NoDowngradeOptions, command: "check" | "record", rest: string[]): string[] {
  const args = [options.script, command, ...rest, "--ledger", options.ledger];
  if (options.repo) args.push("--repo", options.repo);
  if (options.releaseBranch) args.push("--release-branch", options.releaseBranch);
  if (options.prodBranch !== undefined) args.push("--prod-branch", options.prodBranch);
  return args;
}

/** The no-downgrade gate, right after the preflight in admission of an
 * update: the staged bundle is checked against the live one before anything
 * is locked, planned or swapped. Exit 2 is the script's refusal (its reason
 * names both commits); any other failure refuses too, since an unverifiable
 * candidate is never installed. */
export async function runNoDowngradeGate(options: NoDowngradeOptions | undefined, candidateApp: string, liveApp: string): Promise<string[]> {
  if (!options) return ["no-downgrade guard not configured; skipped"];
  if (!existsSync(options.script)) {
    if (options.require) throw err(`no-downgrade guard missing at ${options.script}; refusing to update`, 409);
    return [`no-downgrade guard not found at ${options.script}; skipped`];
  }
  let result: { code: number; stdout: string; stderr: string };
  try { result = await (options.run ?? defaultRunGuard)(guardArgs(options, "check", ["--candidate", candidateApp, "--live", liveApp])); }
  catch (error) { throw err(`no-downgrade guard failed: ${error instanceof Error ? error.message : String(error)}`, 409); }
  let verdict: NoDowngradeVerdict | null = null;
  try { verdict = JSON.parse(result.stdout) as NoDowngradeVerdict; } catch { verdict = null; }
  const reason = verdict?.reason ?? result.stderr.trim().slice(0, 300) ?? "";
  if (result.code === 2) throw err(`install refused: ${reason || "the no-downgrade guard said no"}`, 409);
  if (result.code !== 0) throw err(`no-downgrade guard failed (exit ${result.code}): ${reason || "no output"}`, 409);
  if (!verdict || verdict.ok !== true) throw err(`no-downgrade guard failed: it exited 0 without an ok verdict`, 409);
  return [`no-downgrade: ${reason}`];
}

/** The guard the detached job runs: a copy of the shipped script written
 * beside apply.py, its sha256 pinned in the plan. A copy, because the live
 * bundle's own Contents/Resources/updater is renamed away mid-swap and
 * because the job must run exactly the script admission ran. Packaged
 * builds (require) refuse without it; a dev run goes without. */
export function stageApplyGuard(options: NoDowngradeOptions | undefined, dir: string): ApplyGuard | null {
  if (!options) return null;
  if (!existsSync(options.script)) {
    if (options.require) throw err(`no-downgrade guard missing at ${options.script}; refusing to update`, 409);
    return null;
  }
  const source = readFileSync(options.script, "utf8");
  const script = join(dir, "no-downgrade.py");
  writeFileAtomic(script, source, { mode: 0o700 });
  return {
    script, scriptSha256: createHash("sha256").update(source).digest("hex"), ledger: options.ledger,
    ...(options.repo ? { repo: options.repo } : {}), ...(options.releaseBranch ? { releaseBranch: options.releaseBranch } : {}),
    ...(options.prodBranch !== undefined ? { prodBranch: options.prodBranch } : {}),
  };
}

function defaultRunPreflight(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/python3", [path], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ` (exit ${String((error as { code?: unknown }).code)})` : "";
        return reject(new Error(`preflight exited with an error${code}: ${String(stderr).trim().slice(0, 300) || error.message}`));
      }
      resolve(String(stdout));
    });
  });
}

/** The preflight gate, first thing in admission: nothing is locked, planned
 * or swapped until the shipped script says ok. Refuses on a missing script
 * (packaged), a failed run, unreadable json, ok=false, or a live install job. */
async function runPreflightGate(options: DarwinExecutorOptions): Promise<string[]> {
  if (!options.preflight) return ["preflight not configured; skipped"];
  if (!existsSync(options.preflight)) {
    if (options.requirePreflight) throw err(`preflight script missing at ${options.preflight}; refusing to update`, 409);
    return [`preflight script not found at ${options.preflight}; skipped`];
  }
  let output: string;
  try { output = await (options.runPreflight ?? defaultRunPreflight)(options.preflight); }
  catch (error) { throw err(`preflight refused: ${error instanceof Error ? error.message : String(error)}`, 409); }
  let report: PreflightReport;
  try { report = JSON.parse(output) as PreflightReport; }
  catch (error) { throw err(`preflight refused: its output is not json (${error instanceof Error ? error.message : String(error)})`, 409); }
  if (!report || typeof report !== "object") throw err("preflight refused: its output is not a report", 409);
  const verdict = preflightVerdict(report);
  if (verdict.refuse) throw err(verdict.refuse, 409);
  return verdict.notes;
}

export function createDarwinExecutor(host: UpdaterHost, options: DarwinExecutorOptions): UpdateExecutor {
  const log = options.log ?? (() => {});
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const sandbox = options.sandbox;
  const candidate = async (): Promise<Candidate | null> => sandbox?.stagedPath
    ? (existsSync(join(sandbox.stagedPath, "Contents")) ? describeStagedApp(sandbox.stagedPath) : null)
    : discoverCandidate(options.dataDir);
  return {
    candidate,
    async admit(mode) {
      const notes: string[] = await runPreflightGate(options);
      if (mode === "update") {
        const staged = await candidate();
        if (!staged) throw err("no staged update to apply", 409);
        notes.push(...await runNoDowngradeGate(options.noDowngrade, staged.appPath, options.liveApp));
      }
      const { running, idle, staleOwn } = classifyLaunchdJobs(await host.launchdList());
      const blocking = running.map(label => `${label} (running)`);
      for (const label of idle) {
        const details = await host.jobDetails(uid, label).catch(() => null);
        const why = jobBlocks(label, details);
        if (why) blocking.push(`${label} (${why})`);
        else notes.push(`loaded but idle, not blocking: ${label}${details ? "" : " (launchd gave no details)"}`);
      }
      if (blocking.length) throw err(`another installer or restart job is active: ${blocking.join(", ")}`, 409);
      for (const label of staleOwn) {
        log(`[update] removing finished update job ${label}`);
        try { await host.bootout(uid, label); } catch (error) { log(`[update] bootout ${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return notes;
    },
    ports: () => host.listeningPorts(),
    async recordInstalled() {
      const guard = options.noDowngrade;
      if (!guard || !existsSync(guard.script)) return null;
      const result = await (guard.run ?? defaultRunGuard)(guardArgs(guard, "record", ["--live", options.liveApp]));
      let verdict: NoDowngradeVerdict | null = null;
      try { verdict = JSON.parse(result.stdout) as NoDowngradeVerdict; } catch { verdict = null; }
      if (result.code !== 0) throw new Error(verdict?.reason ?? result.stderr.trim().slice(0, 300));
      return `no-downgrade: ${verdict?.reason ?? "recorded the live build"}`;
    },
    async execute(plan, dir) {
      const staged = plan.mode === "update" ? await candidate() : null;
      if (plan.mode === "update" && (!staged || staged.version !== plan.version || staged.sha !== plan.sha)) throw err("staged app changed since it was admitted; re-stage it", 409);
      if (staged && appDigests(staged.appPath).server !== staged.serverSha256) throw err("staged app changed since it was staged; re-stage it", 409);
      const live = options.liveApp;
      let old: ApplyPlan["old"] = null;
      try { old = appDigests(live); } catch { old = null; }
      const proc = await host.appProcess();
      const script = UPDATER_APPLY_SCRIPT;
      // The job judges the swap again on its own, from its own copy of the guard.
      const guard = plan.mode === "update" ? stageApplyGuard(options.noDowngrade, dir) : null;
      const full: ApplyPlan = {
        ...plan, label: `${UPDATE_JOB_PREFIX}${plan.updateId.slice(0, 8)}`, live,
        staged: staged?.appPath ?? null,
        backup: staged ? join(dirname(live), `${basename(live, ".app")}.previous-${plan.oldSha.slice(0, 8) || "unknown"}-${plan.updateId.slice(0, 8)}.app-disabled`) : null,
        appPid: proc.pid, appIdentity: proc.identity,
        expect: staged ? { server: staged.serverSha256, ui: staged.uiSha256 } : null, old,
        launch: sandbox ? [] : ["/usr/bin/open", "{app}"],
        codesign: options.codesign ?? true, selfBootout: !sandbox, requireLaunchd: options.requireLaunchd ?? true,
        uid, scriptSha256: createHash("sha256").update(script).digest("hex"),
        guard, guardRequired: plan.mode === "update" && Boolean(options.noDowngrade?.require),
        ...(sandbox ? { sandbox: true, fault: sandbox.fault ?? null } : {}),
      };
      writeFileAtomic(join(dir, "apply.py"), script, { mode: 0o700 });
      writeFileAtomic(join(dir, "plan.json"), JSON.stringify(full, null, 2), { mode: 0o600 });
      const plistPath = join(dir, `${full.label}.plist`);
      writeFileAtomic(plistPath, updaterPlist(full.label, dir), { mode: 0o600 });
      await host.bootstrap(uid, plistPath);
    },
  };
}
