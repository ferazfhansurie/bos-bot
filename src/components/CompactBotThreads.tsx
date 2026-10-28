import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { type Bot, type Task, useStore } from "@/state/store";
import { useActivityFeed, withLiveActivity } from "@/lib/activity-feed";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { useSplitView } from "./SplitViewContext";
import { threadPaneId } from "@/lib/split-view";
import { TaskPicker } from "./TaskPicker";

/** When a row last moved: the person's last message, except the calls
 * thread, whose news is the newest call card. */
export const callsAt = (task: Pick<Task, "voiceCalls" | "lastActivityAt" | "lastUserMessageAt" | "createdAt">): number =>
  (task.voiceCalls ? Math.max(task.lastActivityAt ?? 0, task.lastUserMessageAt ?? 0) : task.lastUserMessageAt) || task.createdAt;

export function compactThreads(tasks: Task[], pins: string[], active: string, limit = 5): Task[] {
  // the calls thread always rides on top, like a pin
  const calls = (t: Task) => Boolean(t.voiceCalls) && !t.archivedAt;
  const pinned = (t: Task) => calls(t) || pins.includes(t.threadId);
  const ordered = tasks.filter(t => !t.routineRunId && (!t.archivedAt || t.threadId === active || pinned(t)))
    .sort((a, b) => Number(calls(b)) - Number(calls(a)) || Number(pinned(b)) - Number(pinned(a)) || (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt));
  const visible = ordered.slice(0, limit);
  const current = ordered.find(t => t.threadId === active);
  if (current && !visible.includes(current)) visible[limit - 1] = current;
  return visible;
}

/** The thread ⌘[ / ⌘] lands on: one step through the same order the
 * compact list shows, wrapping at either end. */
export function stepThread(tasks: Task[], pins: string[], active: string, step: 1 | -1): Task | undefined {
  const order = compactThreads(tasks, pins, active, Infinity);
  if (order.length < 2) return undefined;
  const at = order.findIndex(t => t.threadId === active);
  return order[at < 0 ? 0 : (at + step + order.length) % order.length];
}

export const threadPinsKey = (botId: string) => `bos-thread-pins:${botId}`;

export function readThreadPins(botId: string): string[] {
  try { const stored: unknown = JSON.parse(localStorage.getItem(threadPinsKey(botId)) ?? "[]"); return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []; } catch { return []; }
}

export function threadTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { day: "numeric", month: "short", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function CompactBotThreads({ bot, active = true }: { bot: Bot; active?: boolean }) {
  const { state, dispatch } = useStore();
  const { openSplit } = useSplitView();
  useActivityFeed();
  const key = threadPinsKey(bot.id);
  const [pins, setPins] = useState<string[]>(() => readThreadPins(bot.id));
  useEffect(() => {
    const refresh = () => setPins(readThreadPins(bot.id));
    refresh();
    window.addEventListener("bos-thread-pins-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("bos-thread-pins-changed", refresh); window.removeEventListener("storage", refresh); };
  }, [bot.id]);
  const togglePin = (id: string) => {
    const next = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
    setPins(next);
    try { localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new Event("bos-thread-pins-changed")); } catch { /* session choice still works */ }
  };
  return <div className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" aria-label={`${bot.name} threads`}>
    {compactThreads(bot.tasks ?? [], pins, bot.threadId).map(task => {
      const live = withLiveActivity(bot.id, task);
      return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: live.busy, activity: live.activity }} ownerId={bot.id} current={active && task.threadId === bot.threadId} dense
        splitId={!bot.remote && !bot.homeLink ? threadPaneId(bot.id, task.threadId) : undefined}
        onOpenBeside={!bot.remote && !bot.homeLink && !(state.selectedId === bot.id && task.threadId === bot.threadId) ? () => openSplit(threadPaneId(bot.id, task.threadId)) : undefined}
        pinned={pins.includes(task.threadId)} onTogglePin={() => togglePin(task.threadId)} folders={bot.remote ? [] : bot.projects}
        trailing={task.voiceCalls && task.lastActivityAt ? <time dateTime={new Date(task.lastActivityAt).toISOString()} title={`last call: ${new Date(task.lastActivityAt).toLocaleString()}`} className="shrink-0 text-[10px] font-normal tabular-nums text-ink-secondary/70">{threadTime(task.lastActivityAt)}</time>
          : task.lastUserMessageAt ? <time dateTime={new Date(task.lastUserMessageAt).toISOString()} title={`your last message: ${new Date(task.lastUserMessageAt).toLocaleString()}`} className="shrink-0 text-[10px] font-normal tabular-nums text-ink-secondary/70">{threadTime(task.lastUserMessageAt)}</time> : null}
        onSelect={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
        onPrefetch={bot.remote || bot.homeLink ? undefined : () => dispatch({ type: "prefetchThread", threadId: task.threadId })}
        onRename={(title) => dispatch({ type: "renameTask", botId: bot.id, threadId: task.threadId, title })}
        onDelete={() => dispatch({ type: "deleteTask", botId: bot.id, threadId: task.threadId })}
        onMove={(projectId) => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { projectId } })}
        onArchive={(archivedAt) => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { archivedAt } })}
        onReopen={() => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { closed: false } })} />;
    })}
    <div className="flex items-center justify-between py-1">
      <TaskPicker bot={bot} sidebar />
      <button type="button" aria-label="new thread" title="new thread" className="rounded p-2 text-ink-secondary hover:bg-raised" onClick={() => dispatch({ type: "newTask", botId: bot.id })}><Plus size={13} /></button>
    </div>
  </div>;
}
