// 3.0's home board ("today") sits where the chat goes when you haven't picked
// a thread yet. It opens with the app and closes the moment you navigate
// anywhere; the sidebar's "today" row and ⌘K open it again. Only read when
// the v3 flag is on, so flag-off never sees it.
import { useSyncExternalStore } from "react";
import type { Bot, Task } from "@/state/store";
import type { Routine, RoutineRun } from "../../shared/routines";

let open = true;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function homeOpen(): boolean {
  return open;
}

export function setHomeOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useHomeOpen(): boolean {
  return useSyncExternalStore(subscribe, homeOpen, homeOpen);
}

/** The key that changes whenever the person goes somewhere else. Pure, for tests. */
export function navigationKey(input: {
  activeView: string;
  selectedId: string | null;
  threadId?: string | null;
  sharedRoomId?: string | null;
}): string {
  return [input.activeView, input.selectedId ?? "", input.threadId ?? "", input.sharedRoomId ?? ""].join("|");
}

export type HomeEntry = { bot: Bot; task: Task };

/** Sort the roster's threads into the board's lanes, leaving out the bots the
 * person hid from the board. Pure, for tests. */
export function homeLanes(bots: Bot[], hidden: readonly string[] = []): { needsYou: HomeEntry[]; working: HomeEntry[]; done: HomeEntry[] } {
  const needsYou: HomeEntry[] = [];
  const working: HomeEntry[] = [];
  const done: HomeEntry[] = [];
  for (const bot of bots) {
    if (hidden.includes(bot.id)) continue;
    for (const task of bot.tasks ?? []) {
      if (task.routineRunId || task.archivedAt) continue;
      const entry = { bot, task };
      if (task.activity === "waiting-on-you") needsYou.push(entry);
      else if (task.busy || task.activity === "working") working.push(entry);
      // a run that never started isn't done; the fix-it cards carry it
      else if (task.unread && task.activity !== "dead" && task.activity !== "no-signal") done.push(entry);
    }
  }
  const recent = (a: HomeEntry, b: HomeEntry) => (b.task.lastActivityAt ?? b.task.createdAt) - (a.task.lastActivityAt ?? a.task.createdAt);
  return { needsYou: needsYou.sort(recent), working: working.sort(recent), done: done.sort(recent) };
}

/** The bots the board's show/hide list offers: every bot in the sidebar, plus
 * any other bot with a card on the board (an archived bot, or one a linked
 * home keeps hidden there), so nothing on Today lacks a switch. Pure, for tests. */
export function homeBoardBots(bots: Bot[], routines: Routine[], runs: RoutineRun[], now = Date.now()): Bot[] {
  const lanes = homeLanes(bots);
  const { live, upcoming } = homeAutomations(routines, runs, now);
  const onBoard = new Set([
    ...[...lanes.needsYou, ...lanes.working, ...lanes.done].map((entry) => entry.bot.id),
    ...live.map((run) => run.botId),
    ...upcoming.map((routine) => routine.botId),
  ]);
  return bots.filter((bot) => !bot.hidden || onBoard.has(bot.id));
}

/** Live and upcoming automations. Pure, for tests. */
export function homeAutomations(routines: Routine[], runs: RoutineRun[], now = Date.now(), hidden: readonly string[] = []) {
  const live = runs.filter((run) => (run.status === "running" || run.status === "waiting" || run.status === "queued") && !hidden.includes(run.botId));
  const upcoming = routines
    .filter((routine) => routine.enabled && routine.nextRunAt && routine.nextRunAt > now && !hidden.includes(routine.botId))
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
  return { live, upcoming };
}
