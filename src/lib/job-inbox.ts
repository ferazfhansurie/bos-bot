// Job inbox: the pure half of the desktop view over GET /api/jobs. The
// server projects only work plans this session may read; the client keeps
// well-formed rows and never mutates or resumes anything by reading them.
import type { JobInboxItem, JobInboxResponse, JobState } from "../../shared/job-inbox";
import type { LocaleKey } from "@/locales";
import { api, ApiError, openThread, type Action, type AppState } from "@/state/store";
import { t } from "./i18n";

export type { JobInboxItem, JobInboxResponse, JobState };
export type JobStep = JobInboxItem["steps"][number];
export type JobResult = JobInboxItem["results"][number];

/** Most urgent first: what needs the person, then what is stuck, then work. */
export const JOB_STATES: readonly JobState[] = ["needs-you", "blocked", "moving", "ready", "waiting", "paused", "completed"];
const STEP_STATUSES: readonly JobStep["status"][] = ["ready", "waiting", "blocked", "done"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function stepOf(raw: unknown): JobStep | null {
  if (!isRecord(raw)) return null;
  const status = raw.status as JobStep["status"];
  if (!text(raw.id) || !STEP_STATUSES.includes(status)) return null;
  const step: JobStep = {
    id: text(raw.id),
    ownerBotId: text(raw.ownerBotId),
    action: text(raw.action),
    status,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((id): id is string => typeof id === "string" && id !== "") : [],
  };
  if (text(raw.reason)) step.reason = text(raw.reason);
  if (text(raw.evidence).trim()) step.evidence = text(raw.evidence);
  return step;
}

function resultOf(raw: unknown): JobResult | null {
  if (!isRecord(raw) || !text(raw.stepId) || !text(raw.ownerBotId) || !text(raw.evidence).trim()) return null;
  // evidence is always the owner's own report, never an independent check
  return { stepId: text(raw.stepId), ownerBotId: text(raw.ownerBotId), evidence: text(raw.evidence), source: "owner-reported" };
}

function itemOf(raw: unknown): JobInboxItem | null {
  if (!isRecord(raw)) return null;
  const state = raw.state as JobState;
  if (!text(raw.botId) || !text(raw.threadId) || !JOB_STATES.includes(state)) return null;
  const item: JobInboxItem = {
    botId: text(raw.botId),
    threadId: text(raw.threadId),
    revision: typeof raw.revision === "number" && Number.isFinite(raw.revision) ? raw.revision : 0,
    outcome: text(raw.outcome),
    state,
    steps: (Array.isArray(raw.steps) ? raw.steps : []).flatMap((entry) => stepOf(entry) ?? []),
    results: (Array.isArray(raw.results) ? raw.results : []).flatMap((entry) => resultOf(entry) ?? []),
  };
  if (text(raw.reason)) item.reason = text(raw.reason);
  return item;
}

/** Keep only well-formed rows; one row per bot/thread plan. */
export function normalizeJobInbox(raw: unknown): JobInboxResponse | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  const items = raw.items.flatMap((entry) => {
    const item = itemOf(entry);
    if (!item) return [];
    const key = `${item.botId}\u0000${item.threadId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
  return { items };
}

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

/** null when the server predates the endpoint. Read-only: a plain GET. */
export async function fetchJobInbox(signal?: AbortSignal, request: Request = api): Promise<JobInboxResponse | null> {
  try {
    const body = await request("/api/jobs", signal ? { signal } : undefined);
    const inbox = normalizeJobInbox(body);
    // the SPA fallback page or an unknown body reads as "no endpoint"
    if (!inbox) return null;
    return inbox;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return null;
    throw error;
  }
}

/** One read of the inbox. The returned stop aborts the request and drops
 * any late answer, so an unmounted or hidden page never applies stale rows. */
export function startJobInboxRead(handlers: {
  onData: (inbox: JobInboxResponse | null) => void;
  onError: (message: string) => void;
  onSettled: () => void;
}, read: (signal: AbortSignal) => Promise<JobInboxResponse | null> = fetchJobInbox): () => void {
  const controller = new AbortController();
  read(controller.signal).then((next) => {
    if (!controller.signal.aborted) handlers.onData(next);
  }, (cause) => {
    if (!controller.signal.aborted) handlers.onError(cause instanceof Error ? cause.message : String(cause));
  }).finally(() => {
    if (!controller.signal.aborted) handlers.onSettled();
  });
  return () => controller.abort();
}

/** Jump to the job's existing thread; a thread this client no longer holds
 * gets the usual "thread gone" notice, never a new thread. */
export const openJobThread = (dispatch: (action: Action) => void, item: Pick<JobInboxItem, "botId" | "threadId">, state: AppState): boolean =>
  openThread(dispatch, { botId: item.botId, threadId: item.threadId }, state);

export function groupJobs(items: readonly JobInboxItem[]): Array<{ state: JobState; items: JobInboxItem[] }> {
  return JOB_STATES.flatMap((state) => {
    const rows = items.filter((item) => item.state === state);
    return rows.length ? [{ state, items: rows }] : [];
  });
}

/** The lead is the plan's own bot; helpers are the other step owners, in
 * the order the plan names them. */
export function jobOwners(item: JobInboxItem): { leadBotId: string; helperBotIds: string[] } {
  const helpers: string[] = [];
  for (const step of item.steps) {
    if (step.ownerBotId && step.ownerBotId !== item.botId && !helpers.includes(step.ownerBotId)) helpers.push(step.ownerBotId);
  }
  return { leadBotId: item.botId, helperBotIds: helpers };
}

/** The next unfinished step: a ready one whose dependencies are done first,
 * then whatever is blocked or waiting. Undefined once every step is done. */
export function jobNextStep(item: JobInboxItem): JobStep | undefined {
  const done = new Set(item.steps.filter((step) => step.status === "done").map((step) => step.id));
  return item.steps.find((step) => step.status === "ready" && step.dependsOn.every((id) => done.has(id)))
    ?? item.steps.find((step) => step.status === "blocked")
    ?? item.steps.find((step) => step.status !== "done");
}

export const jobStepCounts = (item: JobInboxItem) => ({
  done: item.steps.filter((step) => step.status === "done").length,
  total: item.steps.length,
});

/** Changes whenever a thread starts, settles or appears, so the page can
 * refetch on task changes without a server push for plans. */
export function jobRefreshKey(state: {
  bots: ReadonlyArray<{ id: string; threadId?: string; busy?: boolean; tasks?: ReadonlyArray<{ threadId: string; busy?: boolean }> }>;
  groups: ReadonlyArray<{ id: string; tasks?: ReadonlyArray<{ threadId: string; state?: string }> }>;
  inboxCount: number;
}): string {
  const bots = state.bots.map((bot) =>
    `${bot.id}:${bot.busy ? 1 : 0}:${(bot.tasks ?? []).map((task) => `${task.threadId}${task.busy ? "+" : ""}`).join(",")}`);
  const groups = state.groups.map((group) =>
    `${group.id}:${(group.tasks ?? []).map((task) => `${task.threadId}${task.state ?? ""}`).join(",")}`);
  return `${state.inboxCount}|${bots.join(";")}|${groups.join(";")}`;
}

const STATE_LABEL: Record<JobState, LocaleKey> = {
  "needs-you": "jobs.state.needsYou",
  blocked: "jobs.state.blocked",
  moving: "jobs.state.moving",
  ready: "jobs.state.ready",
  waiting: "jobs.state.waiting",
  paused: "jobs.state.paused",
  completed: "jobs.state.completed",
};

export const jobStateLabel = (state: JobState): string => t(STATE_LABEL[state]);

const STEP_LABEL: Record<JobStep["status"], LocaleKey> = {
  ready: "jobs.step.ready",
  waiting: "jobs.step.waiting",
  blocked: "jobs.step.blocked",
  done: "jobs.step.done",
};

export const jobStepLabel = (status: JobStep["status"]): string => t(STEP_LABEL[status]);
