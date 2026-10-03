// Update & restart behind one button (1.3). The server side of the
// /api/update contract: discover a staged candidate, checkpoint what is
// running, stop turns, hand the swap to a detached launchd job that outlives
// the app, and on the next boot read that job's result exactly once and
// resume the interrupted conversations exactly once.
//
// Nothing here replays a prompt. A turn interrupted by the update gets ONE
// new continuation turn in its own thread that says what happened and tells
// the bot to check, not repeat, any external action whose outcome it cannot
// see. Room turns are only noted; a room re-dispatch needs the room's own
// scheduler and is not a safe thing to guess at.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { UPDATER_APPLY_SCRIPT } from "./updater-apply-script.ts";

export type UpdateState = "idle" | "ready" | "checkpointing" | "stopping" | "applying" | "relaunching" | "verifying" | "done" | "rolled_back" | "failed";
export type UpdateMode = "update" | "restart";
export interface BusyTurn { botId: string; threadId: string; kind: "direct" | "room"; groupId?: string; title?: string }
export interface CandidateManifest { version: string; sha: string; stagedAt: string; app: string; serverSha256: string; uiSha256: string }
export interface Candidate extends CandidateManifest { dir: string; appPath: string }
export interface UpdateResult { state: "done" | "rolled_back" | "failed"; at: string; detail: string; updateId: string; mode: UpdateMode; rollback?: string; version?: string; sha?: string; manualRecoveryRequired?: boolean; appStillRunning?: boolean }
export interface CheckpointTurn extends BusyTurn { resumedAt?: string; resumeOutcome?: string }
export interface Checkpoint { version: 1; updateId: string; mode: UpdateMode; at: string; stoppedAt?: string; turns: CheckpointTurn[]; steers: unknown; delegations: unknown }
export interface UpdateStatus {
  state: UpdateState; updateId?: string; detail?: string;
  current: { version: string; sha: string };
  candidate?: { version: string; sha: string; stagedAt: string };
  busyTurns: Array<{ botId: string; threadId: string }>;
  lastResult?: { state: UpdateResult["state"]; at: string; detail: string; rollback?: string; version?: string; sha?: string };
}
export interface UpdateEvent { kind: "update.state"; type: "update.state"; state: UpdateState; updateId: string; detail: string }
export interface ApplyPlan {
  updateId: string; label: string; mode: UpdateMode; live: string; staged: string | null; backup: string | null;
  appPid: number | null; appIdentity: string | null; ports: number[]; health: string; expect: { server: string; ui: string } | null;
  old: { server: string; ui: string } | null; oldVersion: string; oldSha: string; version: string; sha: string; force: boolean;
  launch: string[]; resultPath: string; installedPath: string; gracefulSeconds: number; healthSeconds: number;
  codesign: boolean; selfBootout: boolean; requireLaunchd: boolean; uid: number | null; scriptSha256: string;
}
export interface UpdaterHooks {
  dataDir: string;
  liveApp: string;
  current: () => { version: string; sha: string };
  listBusyTurns: () => BusyTurn[];
  stopAll: () => Promise<void>;
  checkpointExtras: () => { steers: unknown; delegations: unknown };
  /** Lock the workspace against new work, pause schedulers, flush to disk. */
  quiesce: () => Promise<void>;
  unquiesce: () => void;
  host: UpdaterHost;
  emit: (event: UpdateEvent) => void;
  /** Continue one interrupted conversation. Called at most once per turn. */
  resumeTurn: (turn: CheckpointTurn, result: UpdateResult) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stopWaitMs?: number;
  resultWaitMs?: number;
  codesign?: boolean;
  requireLaunchd?: boolean;
  uid?: number | null;
  log?: (line: string) => void;
}

/** What the coordinator needs from the machine. `updater-host.ts` has the
 * darwin implementation; tests pass fakes. */
export interface UpdaterHost {
  /** Raw `launchctl list` output. */
  launchdList(): Promise<string>;
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

/** `launchctl list` rows → labels that must stop an update from starting.
 * Our own finished one-shots (no pid) are returned separately so the caller
 * can boot them out instead of refusing. */
export function classifyLaunchdJobs(listing: string): { blocking: string[]; staleOwn: string[] } {
  const blocking: string[] = []; const staleOwn: string[] = [];
  for (const line of listing.split("\n").slice(1)) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (!label) continue;
    const running = pid !== undefined && pid !== "-";
    if (label.startsWith(UPDATE_JOB_PREFIX)) { (running ? blocking : staleOwn).push(label); continue; }
    if (/bos|maus/i.test(label) && /install|updat|restart|keepalive|relaunch|steer/i.test(label)) blocking.push(label);
  }
  return { blocking, staleOwn };
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

export function resumePrompt(turn: CheckpointTurn, result: UpdateResult): string {
  const what = result.state === "done"
    ? (result.mode === "update" ? `BOS was updated to ${result.version ?? "a new build"} and restarted` : "BOS was restarted")
    : `BOS tried to update, rolled back (${result.detail}) and restarted`;
  const where = turn.title ? ` ("${turn.title}")` : "";
  return `${what} while you were mid-turn in this conversation${where}. Continue from where you stopped. ` +
    "Read the transcript above first. Any external action you started whose outcome is not visible here (a message, a post, a file write, a command, a payment) is " +
    "\"interrupted, check\": verify whether it happened before doing it again, and say so if you cannot tell. Do not redo work that already shows a result.";
}

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

export class UpdateCoordinator {
  private state: UpdateState = "idle";
  private updateId: string | null = null;
  private detail = "";
  private lastResult: UpdateStatus["lastResult"] | undefined;
  private running = false;
  private readonly hooks: UpdaterHooks;
  constructor(hooks: UpdaterHooks) {
    this.hooks = hooks;
    mkdirSync(updatesDir(hooks.dataDir), { recursive: true });
    this.lastResult = readJson<UpdateStatus["lastResult"]>(join(updatesDir(hooks.dataDir), "last-result.json")) ?? undefined;
  }
  private now(): Date { return (this.hooks.now ?? (() => new Date()))(); }
  private sleep(ms: number): Promise<void> { return (this.hooks.sleep ?? (m => new Promise(resolve => setTimeout(resolve, m))))(ms); }
  private log(line: string): void { (this.hooks.log ?? (() => {}))(`[update] ${line}`); }
  private set(state: UpdateState, detail = ""): void {
    this.state = state; this.detail = detail;
    this.log(`${state}${detail ? `: ${detail}` : ""}`);
    this.hooks.emit({ kind: "update.state", type: "update.state", state, updateId: this.updateId ?? "", detail });
  }

  status(): UpdateStatus {
    const candidate = this.candidateSafe();
    const state: UpdateState = this.running ? this.state : candidate ? "ready" : "idle";
    return {
      state, ...(this.updateId ? { updateId: this.updateId } : {}), ...(this.detail ? { detail: this.detail } : {}),
      current: this.hooks.current(),
      ...(candidate ? { candidate: { version: candidate.version, sha: candidate.sha, stagedAt: candidate.stagedAt } } : {}),
      busyTurns: this.hooks.listBusyTurns().map(turn => ({ botId: turn.botId, threadId: turn.threadId })),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }
  private candidateSafe(): Candidate | null {
    try { return discoverCandidate(this.hooks.dataDir); }
    catch (error) { this.log(`candidate unreadable: ${error instanceof Error ? error.message : String(error)}`); return null; }
  }

  apply(options: { force?: boolean } = {}): Promise<{ updateId: string }> { return this.start("update", Boolean(options.force)); }
  restart(options: { force?: boolean } = {}): Promise<{ updateId: string }> { return this.start("restart", Boolean(options.force)); }

  private async start(mode: UpdateMode, force: boolean): Promise<{ updateId: string }> {
    if (this.running) throw err(`an update is already running (${this.updateId})`, 409);
    const candidate = mode === "update" ? discoverCandidate(this.hooks.dataDir) : null;
    if (mode === "update" && !candidate) throw err("no staged update to apply", 409);
    const { blocking, staleOwn } = classifyLaunchdJobs(await this.hooks.host.launchdList());
    if (blocking.length) throw err(`another installer or restart job is active: ${blocking.join(", ")}`, 409);
    for (const label of staleOwn) {
      this.log(`removing finished update job ${label}`);
      try { await this.hooks.host.bootout(this.uid(), label); } catch (error) { this.log(`bootout ${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const lockPath = join(updatesDir(this.hooks.dataDir), "apply.lock");
    const updateId = randomUUID();
    // One owner. The in-memory flag guards this process; the file guards
    // against a second server on the same data dir. boot() clears it.
    if (existsSync(lockPath)) throw err("another update owns the lock; restart BOS if nothing is running", 409);
    writeFileAtomic(lockPath, JSON.stringify({ updateId, pid: process.pid, at: this.now().toISOString() }), { mode: 0o600 });
    this.running = true; this.updateId = updateId;
    const dir = updateDir(this.hooks.dataDir, updateId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Everything after admission runs detached from the request: the caller
    // gets 202 + updateId now and follows update.state events.
    void this.drive(mode, force, candidate, dir).catch(error => {
      this.set("failed", error instanceof Error ? error.message : String(error));
      this.finish();
    });
    return { updateId };
  }

  private finish(): void {
    this.running = false;
    try { this.hooks.unquiesce(); } catch { /* nothing to resume */ }
    try { unlinkSync(join(updatesDir(this.hooks.dataDir), "apply.lock")); } catch { /* already gone */ }
  }

  private uid(): number | null { return this.hooks.uid === undefined ? (process.getuid?.() ?? null) : this.hooks.uid; }

  private async drive(mode: UpdateMode, force: boolean, candidate: Candidate | null, dir: string): Promise<void> {
    const updateId = this.updateId!;
    this.set("checkpointing");
    const extras = this.hooks.checkpointExtras();
    const checkpoint: Checkpoint = { version: 1, updateId, mode, at: this.now().toISOString(), turns: this.hooks.listBusyTurns(), ...extras };
    writeFileAtomic(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });

    this.set("stopping", force ? "stopping turns now" : `waiting up to ${Math.round((this.hooks.stopWaitMs ?? 90_000) / 1000)}s for turns to finish`);
    if (!force) {
      const deadline = Date.now() + (this.hooks.stopWaitMs ?? 90_000);
      while (Date.now() < deadline && this.hooks.listBusyTurns().length) await this.sleep(500);
    }
    // Whatever is still running now is what the update interrupts.
    checkpoint.turns = this.hooks.listBusyTurns();
    checkpoint.stoppedAt = this.now().toISOString();
    writeFileAtomic(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
    await this.hooks.stopAll();
    const settle = Date.now() + 15_000;
    while (Date.now() < settle && this.hooks.listBusyTurns().length) await this.sleep(250);
    await this.hooks.quiesce();

    this.set("applying", mode === "update" ? `installing ${candidate!.version} (${candidate!.sha.slice(0, 8)})` : "restarting");
    const live = this.hooks.liveApp;
    const old = this.safeDigests(live);
    const ports = await this.hooks.host.listeningPorts();
    if (!ports.length) throw err("cannot tell which port the app is listening on", 409);
    const proc = await this.hooks.host.appProcess();
    const current = this.hooks.current();
    const script = UPDATER_APPLY_SCRIPT;
    const plan: ApplyPlan = {
      updateId, label: `${UPDATE_JOB_PREFIX}${updateId.slice(0, 8)}`, mode, live,
      staged: candidate?.appPath ?? null,
      backup: candidate ? join(dirname(live), `${basename(live, ".app")}.previous-${current.sha.slice(0, 8) || "unknown"}-${updateId.slice(0, 8)}.app-disabled`) : null,
      appPid: proc.pid, appIdentity: proc.identity, ports, health: `http://127.0.0.1:${ports[0]}/api/health`,
      expect: candidate ? { server: candidate.serverSha256, ui: candidate.uiSha256 } : null, old,
      oldVersion: current.version, oldSha: current.sha, version: candidate?.version ?? current.version, sha: candidate?.sha ?? current.sha, force,
      launch: ["/usr/bin/open", "{app}"], resultPath: join(dir, "result.json"), installedPath: join(updatesDir(this.hooks.dataDir), "installed.json"),
      gracefulSeconds: 45, healthSeconds: 90, codesign: this.hooks.codesign ?? true, selfBootout: true, requireLaunchd: this.hooks.requireLaunchd ?? true,
      uid: this.uid(), scriptSha256: createHash("sha256").update(script).digest("hex"),
    };
    if (candidate && appDigests(candidate.appPath).server !== candidate.serverSha256) throw err("staged app changed since it was staged; re-stage it", 409);
    writeFileAtomic(join(dir, "apply.py"), script, { mode: 0o700 });
    writeFileAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
    const plistPath = join(dir, `${plan.label}.plist`);
    writeFileAtomic(plistPath, updaterPlist(plan.label, dir), { mode: 0o600 });
    await this.hooks.host.bootstrap(plan.uid, plistPath);
    // The job quits this process. If instead a result shows up while we are
    // still alive, the job gave up before the swap: report it and reopen.
    const watch = async () => {
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
    };
    void watch();
  }

  private safeDigests(app: string): { server: string; ui: string } | null {
    try { return appDigests(app); } catch { return null; }
  }

  private consume(updateId: string, result: UpdateResult): void {
    const dir = updateDir(this.hooks.dataDir, updateId);
    this.lastResult = { state: result.state, at: result.at, detail: result.detail, ...(result.rollback ? { rollback: result.rollback } : {}),
      ...(result.version ? { version: result.version } : {}), ...(result.sha ? { sha: result.sha } : {}) };
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
      this.set("verifying", "finishing the previous update");
      const deadline = Date.now() + (this.hooks.resultWaitMs ?? 180_000);
      let result = readResult(this.hooks.dataDir, updateId);
      while (!result && Date.now() < deadline) { await this.sleep(1000); result = readResult(this.hooks.dataDir, updateId); }
      result ??= { state: "failed", at: this.now().toISOString(), detail: "the updater left no result; the app is running whatever is installed", updateId, mode: "update" };
      this.consume(updateId, result);
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
