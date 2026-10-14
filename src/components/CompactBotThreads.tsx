import { useState } from "react";
import { Plus } from "lucide-react";
import { type Bot, type Task, useStore } from "@/state/store";
import { useActivityFeed, withLiveActivity } from "@/lib/activity-feed";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { useSplitView } from "./SplitViewContext";
import { threadPaneId } from "@/lib/split-view";
import { TaskPicker } from "./TaskPicker";

export function compactThreads(tasks: Task[], pins: string[], active: string): Task[] {
  const ordered = tasks.filter(t => !t.routineRunId && (!t.archivedAt || t.threadId === active || pins.includes(t.threadId)))
    .sort((a, b) => Number(pins.includes(b.threadId)) - Number(pins.includes(a.threadId)) || (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt));
  const visible = ordered.slice(0, 5);
  const current = ordered.find(t => t.threadId === active);
  if (current && !visible.includes(current)) visible[4] = current;
  return visible;
}

export function threadTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { day: "numeric", month: "short", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function CompactBotThreads({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { openSplit } = useSplitView();
  useActivityFeed();
  const key = `bos-thread-pins:${bot.id}`;
  const [pins, setPins] = useState<string[]>(() => {
    try { const stored = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []; } catch { return []; }
  });
  const togglePin = (id: string) => {
    const next = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
    setPins(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* session choice still works */ }
  };
  return <div className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" aria-label={`${bot.name} threads`}>
    {compactThreads(bot.tasks ?? [], pins, bot.threadId).map(task => {
      const live = withLiveActivity(bot.id, task);
      return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: live.busy, activity: live.activity }} ownerId={bot.id} current={task.threadId === bot.threadId} dense
        splitId={!bot.remote && !bot.homeLink ? threadPaneId(bot.id, task.threadId) : undefined}
        onOpenBeside={!bot.remote && !bot.homeLink && !(state.selectedId === bot.id && task.threadId === bot.threadId) ? () => openSplit(threadPaneId(bot.id, task.threadId)) : undefined}
        pinned={pins.includes(task.threadId)} onTogglePin={() => togglePin(task.threadId)} folders={bot.remote ? [] : bot.projects}
        trailing={task.lastUserMessageAt ? <time dateTime={new Date(task.lastUserMessageAt).toISOString()} title={`your last message: ${new Date(task.lastUserMessageAt).toLocaleString()}`} className="shrink-0 text-[10px] font-normal tabular-nums text-ink-secondary/70">{threadTime(task.lastUserMessageAt)}</time> : null}
        onSelect={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
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
