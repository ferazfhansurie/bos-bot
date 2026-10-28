// 3.0 home board ("today"): what your bots need from you, what they're doing
// and what they finished while you were away, all from the roster and
// routines this client already holds. No invented numbers: a card whose
// source isn't on the client (today's numbers from your apps) is left out
// until the server sends it.
import { useMemo } from "react";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { useBotActivity } from "./SidebarActivityAvatar";
import { derivePresence } from "../../shared/mascot-presence";
import { glyphFaceForBot } from "@/lib/mascot";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ConversationHeader } from "./ConversationChrome";
import { V3Empty } from "./v3/Empty";
import { relativeTime } from "@/lib/memory";
import { homeAutomations, homeLanes, setHomeOpen, type HomeEntry as Entry } from "@/lib/v3-home";
import { useHomeHiddenBots } from "@/lib/home-filter";
import { fastStartOnHome } from "@/lib/v3-faststart";
import { FastStart } from "./v3/FastStart";
import { t } from "@/lib/i18n";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { CheckinBrief } from "./CheckinBrief";

function inTime(at: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return t("v3.home.inMinutes", { count: minutes });
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return t("v3.home.todayAt", { time });
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function HomeMascot({ bot, size = 36 }: { bot: Bot; size?: number }) {
  const live = useBotActivity(bot);
  const presence = derivePresence({
    surface: "home",
    feed: live.state,
    finishing: live.finishing,
    offline: bot.homeLink?.online === false,
    resting: glyphFaceForBot(bot),
  });
  return <BotAvatar bot={bot} face={presence.state} size={size} />;
}

function Item({ bot, title, detail, action, onAction, tone }: {
  bot: Bot;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
  tone?: "warning" | "accent";
}) {
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-hairline/40 bg-panel px-3 py-2.5" data-home-item={bot.id}>
      <HomeMascot bot={bot} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{title}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
          {tone && <span className={cn("size-1.5 shrink-0 rounded-full", tone === "warning" ? "bg-warning" : "animate-status-pulse bg-accent")} aria-hidden="true" />}
          <span className="truncate">{detail}</span>
        </div>
      </div>
      <button type="button" onClick={() => { track("card_clicked", { card: "home" }); onAction(); }}
        className="shrink-0 rounded-full bg-raised px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hairline">
        {action}
      </button>
    </li>
  );
}

function Lane({ title, count, empty, children }: { title: string; count: number; empty?: string; children?: React.ReactNode }) {
  if (!count && !empty) return null;
  return (
    <section className="min-w-0" aria-label={title}>
      <h2 className="mb-2 flex items-baseline gap-2 px-1 text-[13px] font-semibold text-ink-secondary">
        {title}
        {count > 0 && <span className="text-[12px] font-normal tabular-nums">{count}</span>}
      </h2>
      {count ? <ul className="space-y-2">{children}</ul> : <p className="px-1 text-[13px] text-ink-secondary/70">{empty}</p>}
    </section>
  );
}

const LIMIT = 6;

export function HomeBoard() {
  const { state, dispatch } = useStore();
  const { dragStyle } = useCaptionChrome();
  const hidden = useHomeHiddenBots();
  const lanes = useMemo(() => homeLanes(state.bots, hidden), [state.bots, hidden]);
  const automations = useMemo(() => homeAutomations(state.routines, state.routineRuns, Date.now(), hidden), [state.routines, state.routineRuns, hidden]);
  const botById = (id: string) => state.bots.find((bot) => bot.id === id);
  const open = (entry: Entry) => {
    setHomeOpen(false);
    dispatch({ type: "switchTask", botId: entry.bot.id, threadId: entry.task.threadId });
  };
  const openRoutines = () => {
    setHomeOpen(false);
    dispatch({ type: "showRoutines" });
  };
  const jobBot = state.bots.find((bot) => bot.id === state.selectedId && !bot.hidden) ?? state.bots.find((bot) => !bot.hidden);
  const newJob = () => {
    if (!jobBot) return;
    setHomeOpen(false);
    dispatch({ type: "newTask", botId: jobBot.id });
  };
  const now = Date.now();
  const date = new Date(now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const quiet = !lanes.needsYou.length && !lanes.working.length && !lanes.done.length;
  const liveRuns = automations.live.flatMap((run) => {
    const bot = botById(run.botId);
    return bot ? [{ run, bot }] : [];
  });
  const upcoming = automations.upcoming.flatMap((routine) => {
    const bot = botById(routine.botId);
    return bot ? [{ routine, bot }] : [];
  }).slice(0, Math.max(0, 4 - liveRuns.length));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app" data-testid="home-board">
      <ConversationHeader style={dragStyle}><div className="h-9" aria-hidden="true" /></ConversationHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pb-16">
          <div className="mb-1 px-1 text-[13px] text-ink-secondary">{date}</div>
          <CheckinBrief
            avatarFor={(botId) => { const bot = botById(botId); return bot ? <HomeMascot bot={bot} size={28} /> : null; }}
            ownerName={(botId) => botById(botId)?.name}
            onOpenThread={(botId, threadId) => { setHomeOpen(false); dispatch({ type: "switchTask", botId, threadId }); }} />
          {quiet && fastStartOnHome(state.bots) && <div className="mb-6"><FastStart variant="home" /></div>}
          <div className="grid gap-6">
            {quiet ? (
              <V3Empty bot={jobBot} text={t("v3.home.quiet")} testId="home-empty" className="rounded-xl border border-dashed border-hairline/50"
                action={jobBot ? { label: t("v3.home.newJob", { name: jobBot.name }), onClick: newJob } : undefined} />
            ) : <>
            <Lane title={t("v3.home.needsYou")} count={lanes.needsYou.length} empty={t("v3.home.needsYouEmpty")}>
              {lanes.needsYou.slice(0, LIMIT).map((entry) => (
                <Item key={entry.task.threadId} bot={entry.bot} title={entry.task.title || t("task.newShort")}
                  detail={`${entry.bot.name} · ${t("v3.pill.waiting")}`} tone="warning"
                  action={t("v3.home.answer")} onAction={() => open(entry)} />
              ))}
            </Lane>
            <Lane title={t("v3.home.working")} count={lanes.working.length}>
              {lanes.working.slice(0, LIMIT).map((entry) => (
                <Item key={entry.task.threadId} bot={entry.bot} title={entry.task.title || t("task.newShort")}
                  detail={`${entry.bot.name} · ${entry.task.turnStartedAt ? t("v3.home.since", { time: relativeTime(entry.task.turnStartedAt, now) }) : t("chat.activity.working").toLowerCase()}`}
                  tone="accent" action={t("v3.home.watch")} onAction={() => open(entry)} />
              ))}
            </Lane>
            <Lane title={t("v3.home.done")} count={lanes.done.length}>
              {lanes.done.slice(0, LIMIT).map((entry) => (
                <Item key={entry.task.threadId} bot={entry.bot} title={entry.task.title || t("task.newShort")}
                  detail={`${entry.bot.name} · ${relativeTime(entry.task.lastActivityAt ?? entry.task.createdAt, now)}`}
                  action={t("v3.home.read")} onAction={() => open(entry)} />
              ))}
            </Lane>
            </>}
            {(!quiet || liveRuns.length + upcoming.length > 0) && <Lane title={t("v3.home.automations")} count={liveRuns.length + upcoming.length}>
              {liveRuns.map(({ run, bot }) => (
                <Item key={run.id} bot={bot} title={run.routineName}
                  detail={`${bot.name} · ${run.status === "waiting" ? t("v3.pill.waiting") : run.status === "queued" ? t("task.queued").toLowerCase() : t("v3.home.runningNow")}`}
                  tone={run.status === "waiting" ? "warning" : "accent"} action={t("v3.home.open")} onAction={openRoutines} />
              ))}
              {upcoming.map(({ routine, bot }) => (
                <Item key={routine.id} bot={bot} title={routine.name}
                  detail={`${bot.name} · ${inTime(routine.nextRunAt!, now)}`}
                  action={t("v3.home.open")} onAction={openRoutines} />
              ))}
            </Lane>}
          </div>
        </div>
      </div>
    </main>
  );
}
