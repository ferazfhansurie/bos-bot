/** Live activity per (bot, thread), from api's feed: a snapshot on every
 * hydrate plus one live frame per change. Kept outside the app reducer so a
 * tool step in a background thread re-renders the sidebar rows that read it,
 * not the whole app. The mascot gesture is derived here so the sidebar row,
 * the collapsed activity list and tests all ask the same question. */
import { useSyncExternalStore } from "react";
import type { MascotGesture } from "../../shared/mascot-choreography";
import type { Task } from "@/state/store";

export const ACTIVITY_FEED_PATH = "/api/activity";
export const ACTIVITY_FRAME_KIND = "activity";

export type ActivityState = "idle" | "thinking" | "tool" | "typing" | "waiting" | "failed" | "stopped";
export interface ActivityEntry { botId: string; threadId: string; roomId?: string | null; state: ActivityState; since: number }

const STATES = new Set<ActivityState>(["idle", "thinking", "tool", "typing", "waiting", "failed", "stopped"]);
const key = (botId: string, threadId: string) => `${botId}\u0000${threadId}`;

/** Anything off the wire that isn't a well-formed entry is dropped, never
 * guessed at: an unknown state must not animate a bot. */
export function parseActivityEntry(raw: unknown): ActivityEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const state = value.state === "waiting-on-person" ? "waiting" : value.state;
  if (typeof value.botId !== "string" || typeof value.threadId !== "string" || !STATES.has(state as ActivityState)) return null;
  const since = typeof value.since === "number" ? value.since : typeof value.since === "string" ? Date.parse(value.since) : NaN;
  return {
    botId: value.botId, threadId: value.threadId, state: state as ActivityState,
    since: Number.isFinite(since) ? since : 0,
    roomId: typeof value.roomId === "string" ? value.roomId : null,
  };
}

export function createActivityFeed() {
  let entries = new Map<string, ActivityEntry>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const upsert = (next: Map<string, ActivityEntry>, entry: ActivityEntry) => {
    const id = key(entry.botId, entry.threadId);
    const previous = next.get(id);
    // a replayed or reordered frame never rolls a thread back in time
    if (previous && previous.since > entry.since) return false;
    if (previous && previous.state === entry.state && previous.since === entry.since) return false;
    next.set(id, entry);
    return true;
  };
  return {
    /** Full replacement: the snapshot is the truth after a gap. */
    replace(raw: unknown[]) {
      const next = new Map<string, ActivityEntry>();
      for (const item of raw) { const entry = parseActivityEntry(item); if (entry) upsert(next, entry); }
      entries = next;
      emit();
    },
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

/** The frame may carry one entry flat or under `activity`; both are accepted
 * until the wire type lands in shared/wire.ts. */
export function applyActivityFrame(frame: { kind: string } & Record<string, unknown>, feed: ActivityFeed = activityFeed): boolean {
  if (frame.kind !== ACTIVITY_FRAME_KIND) return false;
  feed.apply(frame.activity ?? frame);
  return true;
}

export async function loadActivityFeed(fetcher: (path: string) => Promise<unknown>, feed: ActivityFeed = activityFeed): Promise<void> {
  try {
    const body = await fetcher(ACTIVITY_FEED_PATH) as { items?: unknown[]; activity?: unknown[] } | unknown[];
    const items = Array.isArray(body) ? body : body?.items ?? body?.activity ?? [];
    feed.replace(items);
  } catch {
    // fail closed: no feed means the sidebar falls back to task.activity
  }
}

export function useActivityFeed(feed: ActivityFeed = activityFeed) {
  return useSyncExternalStore(feed.subscribe, feed.snapshot, feed.snapshot);
}

const GESTURE: Record<ActivityState, MascotGesture> = {
  idle: "idle", stopped: "idle", failed: "idle",
  thinking: "thinking", tool: "working", typing: "searching", waiting: "waiting",
};
// waiting needs the person most; then whatever is visibly moving
const RANK: Record<ActivityState, number> = { waiting: 0, tool: 1, typing: 2, thinking: 3, failed: 4, stopped: 5, idle: 6 };

/** One state for a bot row: the feed when it has an entry, else the
 * harness's task.activity so an older server still shows work. */
export function botActivityState(entries: ActivityEntry[], tasks: Array<Pick<Task, "threadId" | "activity" | "busy">>): ActivityState {
  const states: ActivityState[] = entries.map((entry) => entry.state);
  const covered = new Set(entries.map((entry) => entry.threadId));
  for (const task of tasks) {
    if (covered.has(task.threadId)) continue;
    if (task.activity === "waiting-on-you") states.push("waiting");
    else if (task.activity === "working" || task.busy) states.push("thinking");
  }
  return states.sort((a, b) => RANK[a] - RANK[b])[0] ?? "idle";
}

export const gestureForActivity = (state: ActivityState): MascotGesture => GESTURE[state];
export const isActiveActivity = (state: ActivityState) => GESTURE[state] !== "idle";

/** A thread the feed says is moving reads as working (or waiting) in every
 * sidebar list even before the bot announcement catches up. The feed only
 * adds signal here: a resting entry never hides a task the harness calls busy. */
export function withLiveActivity<T extends Pick<Task, "threadId" | "activity" | "busy">>(botId: string, task: T, feed: ActivityFeed = activityFeed): T {
  const entry = feed.get(botId, task.threadId);
  if (!entry || !isActiveActivity(entry.state)) return task;
  return { ...task, busy: true, activity: entry.state === "waiting" ? "waiting-on-you" : "working" };
}
