// The staged-build updater (1.3): a candidate build sits on this mac, the
// server owns checkpoint → stop → swap → relaunch → verify, and this module
// is the renderer's one view of it. Separate from lib/updater.ts, which is
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

export interface UpdateStatus {
  state: UpdateRunState;
  current: UpdateBuild;
  /** `notes` is optional and not in the 1.3 contract yet: one line per
   * change, shown as "what's in it" when the server sends it. */
  candidate?: UpdateBuild & { stagedAt: number | string; notes?: string[] };
  busyTurns: Array<{ botId: string; threadId: string }>;
  lastResult?: { state: UpdateRunState; at: number | string; detail?: string; rollback?: boolean | string };
}

export interface UpdateFrame {
  kind: "update.state";
  state: UpdateRunState;
  updateId?: string;
  detail?: string;
}

export interface UpdateTransport {
  status(): Promise<UpdateStatus>;
  apply(force: boolean): Promise<{ updateId: string }>;
  restart(force: boolean): Promise<void>;
}

const httpTransport: UpdateTransport = {
  status: () => api<UpdateStatus>("/api/update/status", { timeoutMs: 5_000 }),
  apply: (force) => api<{ updateId: string }>("/api/update/apply", { method: "POST", body: JSON.stringify({ force }) }),
  restart: async (force) => {
    await api("/api/update/restart", { method: "POST", body: JSON.stringify({ force }) });
  },
};

/** The run steps in order; the progress list renders these. */
export const UPDATE_STEPS = ["checkpointing", "stopping", "applying", "relaunching", "verifying"] as const;

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
  /** Last apply/restart request failure (409 = another update owns the lock). */
  error: string | null;
  pending: "apply" | "restart" | null;
}

const EMPTY: UpdateView = { status: null, state: "idle", offline: false, error: null, pending: null };

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
    set({
      status,
      state: frameAhead ? view.state : status.state,
      detail: frameAhead ? view.detail : status.lastResult?.detail,
      offline: false,
      pending: isUpdateRunning(status.state) ? null : view.pending,
    });
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

function schedule() {
  if (timer || listeners.size === 0 || unsupported) return;
  timer = setTimeout(() => void poll(), nextDelay());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && !timer) void poll();
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

async function request(kind: "apply" | "restart", force: boolean) {
  if (view.pending || isUpdateRunning(view.state)) return;
  set({ pending: kind, error: null });
  try {
    if (kind === "apply") await transport.apply(force);
    else await transport.restart(force);
    set({ state: "checkpointing", detail: undefined });
  } catch (error) {
    const message =
      error instanceof ApiError && error.status === 409
        ? "Another update is already running."
        : error instanceof Error
          ? error.message
          : String(error);
    set({ pending: null, error: message });
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
  if (result.state === "done")
    return { key, tone: "ok", title: `Updated to ${status!.current.version}`, detail: shortSha(status!.current.sha) };
  if (result.state === "rolled_back")
    return { key, tone: "warn", title: `Rolled back: ${result.detail || "the new build failed its health check"}`, detail: `Still on ${status!.current.version}` };
  if (result.state === "failed")
    return { key, tone: "error", title: `Update failed: ${result.detail || "unknown error"}` };
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
    case "checkpointing":
      return "Saving open work";
    case "stopping":
      return "Pausing bots";
    case "applying":
      return "Installing";
    case "relaunching":
      return "Relaunching";
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
