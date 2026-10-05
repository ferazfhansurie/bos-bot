// The one-press updater: the server finds the newest prod build that passes
// the no-downgrade guard, then owns build → drain → checkpoint → stop →
// install → relaunch → verify (rolling back if the new build is unhealthy),
// and this module is the renderer's one view of it. Separate from lib/updater.ts, which is
// electron-updater's published-release channel.
//
// State arrives two ways: GET /api/update/status (the truth, polled) and
// `update.state` frames on the live stream (fast, between polls). While an
// update runs the server goes away mid-relaunch, so an unreachable status
// during a run reads as "relaunching", not as an error.
import { useSyncExternalStore } from "react";
import { api, ApiError } from "@/state/store";
import type { UpdateRunState } from "../../shared/wire";

export type { UpdateRunState };

export interface UpdateBuild {
  version: string;
  sha: string;
}

/** Only present when it passes the guard: prod head, a newer descendant of
 * the running build, stamped. `notes` is optional, one line per change. */
export interface UpdateCandidate extends UpdateBuild {
  branch?: string;
  stagedAt?: number | string;
  notes?: string[];
  delivery?: "staged-full";
}

export interface UpdateStatus {
  state: UpdateRunState;
  current: UpdateBuild;
  candidate?: UpdateCandidate;
  /** Why there is no candidate, one line (from /check). */
  reason?: string;
  shellRequired?: boolean;
  upToDate?: boolean;
  busyTurns: Array<{ botId: string; threadId: string; botName?: string }>;
  /** `from` ran before, `to` runs now: after a rollback or failure to == from,
   * and `attempted` is the build that did not make it. */
  lastResult?: { state: UpdateRunState; at: number | string; from?: UpdateBuild; to?: UpdateBuild; attempted?: UpdateBuild; detail?: string };
}

/** GET /api/update/progress: the build output tail, newest last. */
export interface UpdateProgressInfo {
  state: UpdateRunState;
  updateId?: string;
  log: string[];
}

export interface UpdateCheck {
  current: UpdateBuild;
  candidate?: UpdateCandidate;
  reason?: string;
  shellRequired?: boolean;
  upToDate?: boolean;
}

export interface UpdateFrame {
  kind: "update.state";
  state: UpdateRunState;
  updateId?: string;
  detail?: string;
}

export interface UpdateTransport {
  status(): Promise<UpdateStatus>;
  check(): Promise<UpdateCheck>;
  /** A second press answers 200 with the same id and `inProgress: true`. */
  apply(force: boolean): Promise<{ updateId: string; inProgress?: boolean }>;
  restart(force: boolean): Promise<{ updateId: string; inProgress?: boolean }>;
  progress(): Promise<UpdateProgressInfo>;
}

const httpTransport: UpdateTransport = {
  status: () => api<UpdateStatus>("/api/update/status", { timeoutMs: 5_000 }),
  check: () => api<UpdateCheck>("/api/update/check", { method: "POST", timeoutMs: 30_000 }),
  apply: (force) => api<{ updateId: string; inProgress?: boolean }>("/api/update/apply", { method: "POST", body: JSON.stringify({ force }) }),
  restart: (force) => api<{ updateId: string; inProgress?: boolean }>("/api/update/restart", { method: "POST", body: JSON.stringify({ force }) }),
  progress: () => api<UpdateProgressInfo>("/api/update/progress", { timeoutMs: 5_000 }),
};

/** The run steps in order; the progress list renders these. The build runs
 * first, while bots keep working; draining only starts once it is staged. */
export const UPDATE_STEPS = ["building", "draining", "checkpointing", "stopping", "applying", "relaunching", "verifying"] as const;

export function isUpdateSuccess(state: UpdateRunState | undefined): boolean {
  return state === "done";
}

export function isUpdateRunning(state: UpdateRunState | undefined): boolean {
  return !!state && (UPDATE_STEPS as readonly string[]).includes(state);
}

export interface UpdateView {
  /** null until the first status answer; also null when the server has no
   * updater at all (404), so callers render nothing. */
  status: UpdateStatus | null;
  /** The effective state: a live frame wins over the last poll. */
  state: UpdateRunState;
  detail?: string;
  /** Server unreachable while a run was in progress. */
  offline: boolean;
  /** Last apply/restart refusal, the server's own line (409 = the guard or
   * the build said no); the button is usable again. */
  error: string | null;
  /** Tail of the build output while building, newest last. */
  log: string[];
  pending: "apply" | "restart" | null;
  checking: boolean;
}

const EMPTY: UpdateView = { status: null, state: "idle", offline: false, error: null, log: [], pending: null, checking: false };

let transport: UpdateTransport = httpTransport;
let view: UpdateView = EMPTY;
let unsupported = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<UpdateView>) {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
}

function nextDelay(): number {
  if (view.pending || isUpdateRunning(view.state) || view.offline) return 1_500;
  return 30_000;
}

async function poll() {
  timer = null;
  if (unsupported) return;
  try {
    const status = await transport.status();
    // A frame newer than the poll can only move forward; once the poll shows
    // a run has settled, it is the truth again.
    const frameAhead = isUpdateRunning(view.state) && isUpdateRunning(status.state) && view.state !== status.state;
    // status may not repeat /check's one-line reason; keep it until a candidate shows
    const reason = status.reason ?? (status.candidate ? undefined : view.status?.reason);
    set({
      status: { ...status, reason },
      state: frameAhead ? view.state : status.state,
      detail: frameAhead ? view.detail : status.lastResult?.detail,
      offline: false,
      pending: isUpdateRunning(status.state) ? null : view.pending,
    });
    if (view.state === "building") await readBuildLog();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      unsupported = true;
      set(EMPTY);
      return;
    }
    if (isUpdateRunning(view.state) || view.pending) set({ offline: true, state: "relaunching" });
  }
  schedule();
}

async function readBuildLog() {
  try {
    const progress = await transport.progress();
    set({ log: progress.log ?? [] });
  } catch {
    // an older server has no /progress; the step line alone is fine
  }
}

function schedule() {
  if (timer || listeners.size === 0 || unsupported) return;
  timer = setTimeout(() => void poll(), nextDelay());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && !timer) void poll().then(() => checkForUpdate());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function useBosUpdate(): UpdateView {
  return useSyncExternalStore(subscribe, () => view, () => view);
}

/** Called by the live stream (state/store handleFrame). */
export function noteUpdateFrame(frame: UpdateFrame) {
  set({ state: frame.state, detail: frame.detail, offline: false, pending: null });
  // a settled frame means the next status is worth reading now
  if (!isUpdateRunning(frame.state) && timer) {
    clearTimeout(timer);
    timer = null;
  }
  schedule();
}

/** Ask the server to look for a newer prod build. The guard decides; the
 * candidate only comes back when it is allowed to install. */
export async function checkForUpdate() {
  if (unsupported || view.checking || isUpdateRunning(view.state) || !view.status) return;
  set({ checking: true });
  try {
    const found = await transport.check();
    const status = view.status ?? { state: "idle" as const, busyTurns: [], current: found.current };
    set({
      checking: false,
      status: { ...status, current: found.current, candidate: found.candidate, reason: found.reason, shellRequired: found.shellRequired, upToDate: found.upToDate },
      state: found.candidate && status.state === "idle" ? "ready" : !found.candidate && status.state === "ready" ? "idle" : view.state,
    });
  } catch (error) {
    // an older server without /check still reports a staged candidate in status
    set({ checking: false, error: error instanceof ApiError && error.status === 404 ? view.error : error instanceof Error ? error.message : String(error) });
  }
}

async function request(kind: "apply" | "restart", force: boolean) {
  if (view.pending || isUpdateRunning(view.state)) return;
  set({ pending: kind, error: null });
  try {
    const started = kind === "apply" ? await transport.apply(force) : await transport.restart(force);
    // a second press (another window) joins the run already going: 200
    // inProgress, same id, so the next poll shows its real step
    if (started?.inProgress) set({ pending: null });
    else if (!isUpdateRunning(view.state)) set({ state: kind === "apply" ? "building" : "draining", detail: undefined, log: [] });
  } catch (error) {
    // 409 is a refusal with a reason (up to date, downgrade, prod moved);
    // show it as-is and let the button be pressed again
    set({ pending: null, error: error instanceof Error ? error.message : String(error) });
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  schedule();
}

export const applyUpdate = (force = false) => request("apply", force);
export const restartApp = (force = false) => request("restart", force);

// ── post-relaunch result ──────────────────────────────────────────────
// The result of the last run is shown once, then acknowledged per device.

const ACK_KEY = "bos.update.ackResult";

export interface UpdateNotice {
  key: string;
  tone: "ok" | "warn" | "error";
  title: string;
  detail?: string;
}

export function updateNotice(status: UpdateStatus | null): UpdateNotice | null {
  const result = status?.lastResult;
  if (!result) return null;
  const key = `${result.state}:${result.at}`;
  // `to` is what runs now: the new build on success, the old one again after
  // a rollback or failure
  const to = result.to ?? status!.current;
  const from = result.from ?? status!.current;
  const tried = result.attempted && result.attempted.sha !== to.sha ? `${result.attempted.version} · ` : "";
  if (isUpdateSuccess(result.state) && status?.shellRequired) return null;
  if (isUpdateSuccess(result.state))
    return { key, tone: "ok", title: `Updated to ${to.version}`, detail: result.from ? `${from.version} → ${to.version} · ${shortSha(to.sha)}` : shortSha(to.sha) };
  if (result.state === "rolled_back")
    return { key, tone: "warn", title: `Update failed, rolled back to ${to.version}`, detail: result.detail ? `${tried}${result.detail}` : undefined };
  if (result.state === "failed")
    return { key, tone: "error", title: `Update failed, still on ${to.version}`, detail: result.detail ? `${tried}${result.detail}` : undefined };
  return null;
}

export function noticeAcknowledged(key: string): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === key;
  } catch {
    return false;
  }
}

export function acknowledgeNotice(key: string) {
  try {
    localStorage.setItem(ACK_KEY, key);
  } catch {
    // private mode: the toast simply returns next launch
  }
  set({});
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : "";
}

export function stepLabel(state: UpdateRunState): string {
  switch (state) {
    case "draining":
      return "Waiting for bots to finish";
    case "checkpointing":
      return "Saving open work";
    case "stopping":
      return "Pausing bots";
    case "building":
      return "Building";
    case "applying":
      return "Installing";
    case "relaunching":
      return "Restarting";
    case "verifying":
      return "Checking the new build";
    case "done":
      return "Updated";
    case "rolled_back":
      return "Rolled back";
    case "failed":
      return "Failed";
    case "ready":
      return "Update ready";
    default:
      return "Up to date";
  }
}

/** The draining line: "Waiting for 2 bots to finish (pix, pipe)". */
export function drainingLabel(names: string[]): string {
  if (names.length === 0) return "Waiting for bots to finish";
  const count = names.length === 1 ? "1 bot" : `${names.length} bots`;
  return `Waiting for ${count} to finish (${names.join(", ")})`;
}

/** Test/preview seam: swap the HTTP transport for a mock and reset. */
export function setUpdateTransport(next: UpdateTransport | null) {
  if (timer) clearTimeout(timer);
  timer = null;
  transport = next ?? httpTransport;
  unsupported = false;
  view = EMPTY;
  if (listeners.size) void poll();
}

/** Test seam: run one poll now. */
export const pollUpdateStatus = poll;
