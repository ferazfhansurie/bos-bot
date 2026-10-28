import { useState } from "react";
import { BellDot, CircleAlert, Clock3, Loader2, Square } from "lucide-react";
import { useStore, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { orderedSidebarThreads } from "./SidebarThreadRow";
import { useActivityFeed, withLiveActivity } from "@/lib/activity-feed";
import { BotAvatar } from "./Avatar";
import { WorkingTimer } from "./WorkingIndicator";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** Attention is not history browsing: idle conversations never enter this list.
 * Read the sibling's own status, not the bot's aggregate busy/waiting flags. */
export function sidebarBotActivityTasks(bot: Bot, queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  const tasks = bot.tasks ?? [{
    threadId: bot.threadId, title: t("task.newShort"), createdAt: 0,
    busy: bot.busy, activity: bot.activity, unread: bot.unread,
  }];
  return tasks.map((task) => ({ ...withLiveActivity(bot.id, task), queued: Boolean(queued[task.threadId]?.length) }))
    // Routine runs are reachable through their run receipt, never a menu.
    .filter((task) => !task.routineRunId)
    .filter((task) => task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.queued || task.unread);
}

/** One thread with live work: running, queued, or waiting on the person.
 * Unread alone does not count; the row dot already says that, and counting it
 * turned "active threads" into a second inbox of every finished reply. */
export type AttentionThread = { botId: string; botName: string; task: Task & { queued: boolean } };

const isLiveWork = (task: Task & { queued: boolean }) =>
  task.activity === "waiting-on-you" || task.activity === "working" || Boolean(task.busy) || task.queued;

export function crossBotAttentionThreads(bots: Bot[], queued: Record<string, unknown[]>, exceptBotId?: string): AttentionThread[] {
  // Flatten first, then order once: sorting each bot on its own would let
  // the unread reply of an earlier bot outrank the waiting approval of a
  // later bot, which the sidebar tree never does. Hidden bots stay out
  // entirely; the archived-bots panel is where they resurface.
  return orderedSidebarThreads(
    bots
      .filter((bot) => bot.id !== exceptBotId && !bot.hidden)
      .flatMap((bot) => sidebarBotActivityTasks(bot, queued)
        .filter(isLiveWork)
        .map((task) => ({ ...task, botId: bot.id, botName: bot.name }))),
    "",
  ).map(({ botId, botName, ...task }) => ({ botId, botName, task }));
}

function attentionState(task: AttentionThread["task"]) {
  const waiting = task.activity === "waiting-on-you";
  const working = !waiting && (Boolean(task.busy) || task.activity === "working");
  return { waiting, working, label: waiting ? t("task.waiting") : working ? t("chat.activity.working") : t("task.queued") };
}

/** One running thread: avatar, title, state, elapsed; click jumps, the stop
 * button replaces the timer on hover. Queued threads have nothing to stop. */
function ActiveThreadRow({ entry, bot, onJump, onStop }: { entry: AttentionThread; bot?: Bot; onJump: () => void; onStop: () => void }) {
  const { waiting, working, label: status } = attentionState(entry.task);
  const label = t("attention.item", { title: entry.task.title, name: entry.botName, status });
  const canStop = waiting || working;
  return <div className="group/active relative flex items-center hover:bg-raised/70 focus-within:bg-raised/70">
    <button type="button" aria-label={label} title={label} onClick={onJump}
      className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-3 text-left outline-none">
      {bot ? <BotAvatar bot={bot} size={24} animated={false} /> : <span className="size-6 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{entry.task.title}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-secondary">
          <span className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : working ? "animate-status-pulse bg-accent" : "bg-ink-secondary/50")} aria-hidden="true" />
          <span className={cn("truncate", waiting && "text-warning")}>{status} · {entry.botName}</span>
        </span>
      </span>
      {entry.task.turnStartedAt && <WorkingTimer since={entry.task.turnStartedAt}
        className={cn("shrink-0 text-[11px] text-ink-secondary", canStop && "group-hover/active:opacity-0 group-focus-within/active:opacity-0")} />}
    </button>
    {canStop && <button type="button" aria-label={t("chat.stopTurn")} title={t("chat.stopTurn")} onClick={onStop}
      className="absolute right-2 flex size-7 items-center justify-center rounded-full text-ink-secondary opacity-0 hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover/active:opacity-100 group-focus-within/active:opacity-100">
      <Square size={11} className="fill-current" aria-hidden="true" />
    </button>}
  </div>;
}

/** The sidebar's "Active threads" row: present only while something runs,
 * a dot and a count at rest, the running threads in a popover above it. */
export function SidebarActiveThreads({ entries, density }: { entries: AttentionThread[]; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const iconOnly = density === "icons";
  const waiting = entries.some((entry) => entry.task.activity === "waiting-on-you");
  const label = `${t("attention.title")} · ${entries.length}`;
  return <div className={cn("relative pt-1", iconOnly ? "px-2" : "px-3")}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((value) => !value)}
      className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink", iconOnly && "justify-center", open && "bg-raised text-ink")}>
      <span className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : "animate-status-pulse bg-accent")} aria-hidden="true" />
      {!iconOnly && <span className="min-w-0 flex-1 truncate text-left">{t("attention.title")}</span>}
      <span className="text-[12px] tabular-nums">{entries.length}</span>
    </button>
    {open && <>
      <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
      <div data-popover role="dialog" aria-label={t("attention.title")}
        className={cn("absolute bottom-full z-40 mb-1 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1 shadow-2xl shadow-black/60", iconOnly ? "left-2 w-72" : "inset-x-3")}>
        {entries.map((entry) => <ActiveThreadRow key={`${entry.botId}-${entry.task.threadId}`} entry={entry}
          bot={state.bots.find((bot) => bot.id === entry.botId)}
          onJump={() => { setOpen(false); dispatch({ type: "switchTask", botId: entry.botId, threadId: entry.task.threadId }); }}
          onStop={() => dispatch({ type: "interrupt", botId: entry.botId, threadId: entry.task.threadId })} />)}
      </div>
    </>}
  </div>;
}

/** The escape hatch for other ongoing conversations when their tree is hidden.
 * These are selection-only buttons: no create, rename, move, or delete menu. */
export function SidebarBotActivity({ bot, density }: { bot: Bot; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  useActivityFeed();
  const tasks = orderedSidebarThreads(sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.threadId !== bot.threadId), bot.threadId);
  if (!tasks.length) return null;
  const iconOnly = density === "icons";
  return <div data-sidebar-bot-activity={bot.id} className={cn("mb-1 space-y-0.5", !iconOnly && "ml-6")}>
    {tasks.map((task) => {
      const waiting = task.activity === "waiting-on-you";
      const working = !waiting && (task.busy || task.activity === "working");
      const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : task.queued ? t("task.queued") : t("task.unread");
      const label = `${bot.name}: ${task.title} · ${status}${task.unread && (waiting || working || task.queued) ? ` · ${t("task.unread")}` : ""}`;
      const Icon = waiting ? CircleAlert : working ? Loader2 : task.queued ? Clock3 : BellDot;
      return <button key={task.threadId} type="button" data-sidebar-activity-row={task.threadId} aria-label={label} title={label}
        onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] outline-none hover:bg-raised/50 focus-visible:ring-1 focus-visible:ring-hairline", iconOnly && "justify-center", waiting ? "text-warning" : "text-ink-secondary")}>
        <Icon size={12} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-accent", task.unread && !waiting && !working && "text-accent")} />
        {!iconOnly && <><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="shrink-0 text-[10px]">{waiting ? t("task.waiting") : status}</span>
          {task.unread && (waiting || working || task.queued) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}</>}
      </button>;
    })}
  </div>;
}
