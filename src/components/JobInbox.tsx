// Job inbox: every readable work plan, grouped by what it needs. The page
// only reads GET /api/jobs; opening a job goes to its existing thread and
// never starts, resumes or creates one. Needs me stays its own page.
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Inbox, ListChecks, Loader2, RefreshCw } from "lucide-react";
import { useStore, type AppState } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import {
  groupJobs,
  jobNextStep,
  jobOwners,
  jobRefreshKey,
  jobStateLabel,
  jobStepCounts,
  jobStepLabel,
  openJobThread,
  startJobInboxRead,
  type JobInboxItem,
  type JobInboxResponse,
  type JobState,
  type JobStep,
} from "@/lib/job-inbox";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** While the page is visible it also refetches on this cadence, for plan
 * edits that do not move any thread's busy state. */
export const JOB_INBOX_POLL_MS = 20_000;

const STATE_TONE: Record<JobState, string> = {
  "needs-you": "border-warning/40 text-warning",
  blocked: "border-danger/40 text-danger",
  moving: "border-accent/40 text-accent",
  ready: "border-hairline/60 text-ink",
  waiting: "border-hairline/60 text-ink-secondary",
  paused: "border-hairline/60 text-ink-secondary",
  completed: "border-success/40 text-success",
};

const STEP_TONE: Record<JobStep["status"], string> = {
  ready: "text-ink",
  waiting: "text-ink-secondary",
  blocked: "text-danger",
  done: "text-success",
};

export function JobInboxNavRow({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const active = state.activeView === "jobs";
  const icons = density === "icons";
  return (
    <div className={cn("pb-2", icons ? "px-2" : "px-3")}>
      <button
        type="button"
        data-sidebar-jobs
        onClick={() => dispatch({ type: "showJobs" })}
        aria-label={t("jobs.title")}
        title={icons ? t("jobs.title") : undefined}
        className={cn(
          "relative flex min-h-9 w-full items-center rounded-xl py-1.5 text-left transition-colors",
          icons ? "justify-center px-2" : "gap-3 px-3",
          active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
        )}
      >
        <ListChecks size={18} className={active ? "text-accent" : "text-ink-secondary"} />
        {!icons && <span className="flex-1 text-[14px]">{t("jobs.title")}</span>}
      </button>
    </div>
  );
}

const botName = (state: AppState, botId: string) =>
  state.bots.find((bot) => bot.id === botId)?.name || t("jobs.unknownBot");

/** document is absent under server rendering and tests; treat as visible. */
const pageVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function JobInboxPage() {
  const { state, dispatch } = useStore();
  const [inbox, setInbox] = useState<JobInboxResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(pageVisible);
  const [reload, setReload] = useState(0);
  const refreshKey = jobRefreshKey(state);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setVisible(pageVisible());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setReload((n) => n + 1), JOB_INBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [visible]);

  // a newer key or a hidden page aborts the read in flight
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    return startJobInboxRead({
      onData: (next) => { setInbox(next); setError(null); },
      onError: (message) => {
        setError(t("jobs.loadFailed", { error: message }));
        setInbox((current) => current ?? { items: [] });
      },
      onSettled: () => setLoading(false),
    });
  }, [refreshKey, reload, visible]);

  const open = (item: JobInboxItem) => openJobThread(dispatch, item, state);
  const groups = groupJobs(inbox?.items ?? []);
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <ListChecks size={18} className="text-ink-secondary" />
        <h1 className="text-[17px] font-semibold">{t("jobs.title")}</h1>
        {inbox && inbox.items.length > 0 && <span className="ml-1 text-[11px] text-ink-secondary">{inbox.items.length}</span>}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-jobs-needs-me
            onClick={() => dispatch({ type: "showNeedsMe" })}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
          >
            <Inbox size={14} />
            <span className="max-sm:sr-only">{t("needsMe.title")}</span>
          </button>
          <button
            type="button"
            data-jobs-refresh
            onClick={() => setReload((n) => n + 1)}
            disabled={loading}
            aria-label={t("jobs.refresh")}
            title={t("jobs.refresh")}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-5 max-sm:px-3">
          {error && <p role="alert" className="px-1 text-[12px] text-danger">{error}</p>}
          <JobInboxBody inbox={inbox} groups={groups} state={state} onOpen={open} />
        </div>
      </div>
    </main>
  );
}

export function JobInboxBody({ inbox, groups, state, onOpen }: {
  inbox: JobInboxResponse | null | undefined;
  groups: ReturnType<typeof groupJobs>;
  state: AppState;
  onOpen: (item: JobInboxItem) => void;
}) {
  if (inbox === undefined) {
    return <div data-jobs-loading className="flex justify-center py-10 text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>;
  }
  if (inbox === null) {
    return <p data-jobs-unsupported className="py-10 text-center text-[13px] text-ink-secondary">{t("jobs.unsupported")}</p>;
  }
  if (groups.length === 0) {
    return (
      <div data-jobs-empty className="flex flex-col items-center gap-2 py-10 text-center">
        <CheckCircle2 size={22} className="text-success" />
        <p className="text-[14px] text-ink">{t("jobs.empty")}</p>
        <p className="text-[12px] text-ink-secondary">{t("jobs.emptyHint")}</p>
      </div>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.state} data-jobs-group={group.state} className="flex flex-col gap-2">
          <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
            {jobStateLabel(group.state)} · {group.items.length}
          </h2>
          {group.items.map((item) => <JobCard key={`${item.botId}:${item.threadId}`} item={item} state={state} onOpen={onOpen} />)}
        </section>
      ))}
    </>
  );
}

export function JobCard({ item, state, onOpen }: { item: JobInboxItem; state: AppState; onOpen: (item: JobInboxItem) => void }) {
  const lead = state.bots.find((bot) => bot.id === item.botId);
  const { helperBotIds } = jobOwners(item);
  const next = jobNextStep(item);
  const counts = jobStepCounts(item);
  const outcome = item.outcome || t("jobs.untitled");
  return (
    <article data-job-card data-job-state={item.state} className="rounded-xl border border-hairline/40 bg-raised/20">
      <button
        type="button"
        data-job-open
        onClick={() => onOpen(item)}
        aria-label={`${t("jobs.open")}: ${outcome}`}
        className="flex w-full items-start gap-3 rounded-t-xl px-3 py-2.5 text-left hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        {lead ? <BotAvatar bot={lead} size={28} animated={false} /> : <ListChecks size={18} className="mt-1 shrink-0 text-ink-secondary" />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink [overflow-wrap:anywhere]">{outcome}</span>
            <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px]", STATE_TONE[item.state])}>{jobStateLabel(item.state)}</span>
          </span>
          {item.reason && <span className="mt-0.5 block text-[12px] text-ink-secondary [overflow-wrap:anywhere]">{item.reason}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-secondary">
            <span>{t("jobs.lead", { name: botName(state, item.botId) })}</span>
            {helperBotIds.length > 0 && (
              <span>{t("jobs.helpers", { names: helperBotIds.map((id) => botName(state, id)).join(", ") })}</span>
            )}
            {counts.total > 0 && <span>{t("jobs.progress", { done: counts.done, total: counts.total })}</span>}
          </span>
        </span>
        <ChevronRight size={16} className="mt-1 shrink-0 text-ink-secondary" />
      </button>
      <div className="flex flex-col gap-2 border-t border-hairline/30 px-3 py-2.5 sm:pl-[52px]">
        {next ? (
          <p data-job-next className="text-[12.5px] text-ink [overflow-wrap:anywhere]">
            <span className="text-ink-secondary">{t("jobs.next")} · </span>
            <span className="text-ink-secondary">{botName(state, next.ownerBotId)}: </span>
            {next.action}
            <span className={cn("ml-1.5 text-[11px]", STEP_TONE[next.status])}>{jobStepLabel(next.status)}</span>
            {next.reason && <span className="block text-[11.5px] text-ink-secondary">{next.reason}</span>}
          </p>
        ) : counts.total > 0 && (
          <p className="text-[12.5px] text-ink-secondary">{t("jobs.allStepsDone")}</p>
        )}
        {item.results.length > 0 && (
          <div data-job-results className="flex flex-col gap-1">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("jobs.results")}</h3>
            {item.results.map((result) => (
              <p key={result.stepId} data-job-result className="text-[12.5px] text-ink [overflow-wrap:anywhere]">
                <span className="text-ink-secondary">{t("jobs.reportedBy", { name: botName(state, result.ownerBotId) })}: </span>
                {result.evidence}
              </p>
            ))}
            {/* the server forwards owner reports; it does not verify artifacts */}
            <p className="text-[11px] text-ink-secondary">{t("jobs.ownerReported")}</p>
          </div>
        )}
        {item.steps.length > 0 && (
          <details className="group/steps">
            <summary className="cursor-pointer select-none text-[11.5px] text-ink-secondary hover:text-ink">{t("jobs.steps", { count: item.steps.length })}</summary>
            <ol className="mt-1.5 flex flex-col gap-1">
              {item.steps.map((step) => (
                <li key={step.id} data-job-step={step.status} className="flex flex-wrap items-baseline gap-x-2 text-[12px] [overflow-wrap:anywhere]">
                  <span className={cn("w-16 shrink-0 text-[11px]", STEP_TONE[step.status])}>{jobStepLabel(step.status)}</span>
                  <span className="min-w-0 flex-1 text-ink">
                    <span className="text-ink-secondary">{botName(state, step.ownerBotId)}: </span>
                    {step.action}
                    {step.reason && step.status !== "done" && <span className="block text-[11.5px] text-ink-secondary">{step.reason}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </article>
  );
}
