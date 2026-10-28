/** Live activity per (bot, thread), from api's feed (shared/activity.ts):
 * GET /api/activity on every hydrate, then `activity` frames on /api/events,
 * each a full replacement including removals. Kept outside the app reducer so a
 * tool step in a background thread re-renders the sidebar rows that read it,
 * not the whole app. The mascot gesture is derived here so the sidebar row,
 * the collapsed activity list and tests all ask the same question. */
import { useSyncExternalStore } from "react";
import type { MascotGesture } from "../../shared/mascot-choreography";
import { FEED_GESTURE, feedActivityFor, type FeedActivity } from "../../shared/mascot-presence";
import type { Task } from "@/state/store";

export const ACTIVITY_FEED_PATH = "/api/activity";
export const ACTIVITY_FRAME_KIND = "activity";

export type ActivityState = FeedActivity;
export interface ActivityEntry {
  botId: string; threadId: string; roomId?: string | null; state: ActivityState; since: number;
  /** busy threads, from newer servers: when the whole job began, what it is
   * doing in plain words, and the plan's step in progress with its size */
  jobSince?: number; step?: string; stepIndex?: number; stepCount?: number;
}

const STATES = new Set<ActivityState>(["idle", "thinking", "tool", "typing", "waiting", "failed", "stopped"]);
const key = (botId: string, threadId: string) => `${botId}\u0000${threadId}`;

/** Anything off the wire that isn't a well-formed entry is dropped, never
 * guessed at: an unknown state must not animate a bot. */
export function parseActivityEntry(raw: unknown): ActivityEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const state = value.state;
  if (typeof value.botId !== "string" || typeof value.threadId !== "string" || !STATES.has(state as ActivityState)) return null;
  const since = typeof value.since === "number" ? value.since : typeof value.since === "string" ? Date.parse(value.since) : NaN;
  return {
    botId: value.botId, threadId: value.threadId, state: state as ActivityState,
    since: Number.isFinite(since) ? since : 0,
    roomId: typeof value.roomId === "string" ? value.roomId : null,
    ...(typeof value.jobSince === "number" && Number.isFinite(value.jobSince) ? { jobSince: value.jobSince } : {}),
    ...(typeof value.step === "string" && value.step.trim() ? { step: value.step.trim().slice(0, 48) } : {}),
    ...(Number.isInteger(value.stepIndex) && Number.isInteger(value.stepCount) && (value.stepCount as number) >= 2
      ? { stepIndex: value.stepIndex as number, stepCount: value.stepCount as number } : {}),
  };
}

export function createActivityFeed() {
  let entries = new Map<string, ActivityEntry>();
  /** bumped by every replacement, so a snapshot fetch that a live frame
   * overtook is dropped instead of rolling the sidebar back */
  let generation = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const upsert = (next: Map<string, ActivityEntry>, entry: ActivityEntry) => {
    const id = key(entry.botId, entry.threadId);
    const previous = next.get(id);
    // a replayed or reordered frame never rolls a thread back in time
    if (previous && previous.since > entry.since) return false;
    if (previous && previous.state === entry.state && previous.since === entry.since && previous.step === entry.step
      && previous.stepIndex === entry.stepIndex && previous.jobSince === entry.jobSince) return false;
    next.set(id, entry);
    return true;
  };
  return {
    /** Full replacement: the snapshot is the truth after a gap. */
    replace(raw: unknown[]) {
      const next = new Map<string, ActivityEntry>();
      for (const item of raw) { const entry = parseActivityEntry(item); if (entry) upsert(next, entry); }
      entries = next;
      generation += 1;
      emit();
    },
    generation: () => generation,
    apply(raw: unknown) {
      const entry = parseActivityEntry(raw);
      if (!entry) return;
      const next = new Map(entries);
      if (!upsert(next, entry)) return;
      entries = next;
      emit();
    },
    forBot(botId: string): ActivityEntry[] {
      return [...entries.values()].filter((entry) => entry.botId === botId);
    },
    get(botId: string, threadId: string) { return entries.get(key(botId, threadId)); },
    clear() { entries = new Map(); emit(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot() { return entries; },
  };
}

export type ActivityFeed = ReturnType<typeof createActivityFeed>;
export const activityFeed = createActivityFeed();

export function applyActivityFrame(frame: { kind: string } & Record<string, unknown>, feed: ActivityFeed = activityFeed): boolean {
  if (frame.kind !== ACTIVITY_FRAME_KIND) return false;
  if (Array.isArray(frame.items)) feed.replace(frame.items);
  return true;
}

export async function loadActivityFeed(fetcher: (path: string) => Promise<unknown>, feed: ActivityFeed = activityFeed): Promise<void> {
  const started = feed.generation();
  try {
    const body = await fetcher(ACTIVITY_FEED_PATH) as { items?: unknown[] } | null;
    if (feed.generation() === started && Array.isArray(body?.items)) feed.replace(body.items);
  } catch {
    // fail closed: no feed means the sidebar falls back to task.activity
  }
}

export function useActivityFeed(feed: ActivityFeed = activityFeed) {
  return useSyncExternalStore(feed.subscribe, feed.snapshot, feed.snapshot);
}

/** One state for a bot row; the ranking lives with the presence model. */
export function botActivityState(entries: ActivityEntry[], tasks: Array<Pick<Task, "threadId" | "activity" | "busy">>): ActivityState {
  return feedActivityFor(entries, tasks);
}

export const gestureForActivity = (state: ActivityState): MascotGesture => FEED_GESTURE[state];
export const isActiveActivity = (state: ActivityState) => FEED_GESTURE[state] !== "idle";

/** A thread the feed says is moving reads as working (or waiting) in every
 * sidebar list even before the bot announcement catches up. The feed only
 * adds signal here: a resting entry never hides a task the harness calls busy. */
export function withLiveActivity<T extends Pick<Task, "threadId" | "activity" | "busy">>(botId: string, task: T, feed: ActivityFeed = activityFeed): T {
  const entry = feed.get(botId, task.threadId);
  if (!entry || !isActiveActivity(entry.state)) return task;
  return { ...task, busy: true, activity: entry.state === "waiting" ? "waiting-on-you" : "working" };
}
