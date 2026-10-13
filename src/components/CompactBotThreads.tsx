import { useState } from "react";
import { Loader2, Pin, Plus } from "lucide-react";
import { type Bot, type Task, useStore } from "@/state/store";
import { useActivityFeed, withLiveActivity } from "@/lib/activity-feed";
import { cn } from "@/lib/cn";
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
  const { dispatch } = useStore();
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
      const current = task.threadId === bot.threadId;
      const pinned = pins.includes(task.threadId);
      return <div key={task.threadId} className={cn("group/thread flex items-center rounded-lg", current ? "bg-raised" : "hover:bg-raised/50")}>
        <button type="button" data-sidebar-thread-row={task.threadId} aria-current={current ? "page" : undefined}
          onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-secondary focus-visible:outline-accent">
          <span className={cn("min-w-0 flex-1 truncate", (current || task.unread) && "font-medium text-ink")}>{task.title}</span>
          {live.busy || live.activity === "working" ? <Loader2 size={11} className="shrink-0 animate-spin" aria-label="running" /> : task.unread ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="unread" /> : null}
          {task.lastUserMessageAt && <time dateTime={new Date(task.lastUserMessageAt).toISOString()} title={`your last message: ${new Date(task.lastUserMessageAt).toLocaleString()}`} className="shrink-0 text-[10px] tabular-nums text-ink-secondary/70">{threadTime(task.lastUserMessageAt)}</time>}
        </button>
        <button type="button" onClick={() => togglePin(task.threadId)} aria-label={`${pinned ? "unpin" : "pin"} ${task.title}`} aria-pressed={pinned}
          className={cn("mr-1 rounded p-1 text-ink-secondary focus-visible:opacity-100 group-hover/thread:opacity-100", !pinned && "opacity-0")}><Pin size={10} /></button>
      </div>;
    })}
    <div className="flex items-center justify-between py-1">
      <TaskPicker bot={bot} sidebar />
      <button type="button" aria-label="new thread" title="new thread" className="rounded p-2 text-ink-secondary hover:bg-raised" onClick={() => dispatch({ type: "newTask", botId: bot.id })}><Plus size={13} /></button>
    </div>
  </div>;
}
