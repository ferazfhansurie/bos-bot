// Jobs: the one page for work. "Your move" holds only what the person must
// do (live asks, answered in place, and jobs waiting on them); under it each
// job is one line plus one "next:" line, and a tap opens today's full detail.
// Reads GET /api/jobs and GET /api/inbox; opening a job goes to its existing
// thread and never starts, resumes or creates one.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, CircleHelp, ListChecks, Loader2, RefreshCw } from "lucide-react";
import { openThread, useStore, type AppState } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import {
  jobNextStep,
  jobOwners,
  jobRefreshKey,
  jobStateLabel,
  jobStepCounts,
  jobStepLabel,
  openJobThread,
  startJobInboxRead,
  fetchJobInbox,
  type JobInboxItem,
  type JobInboxResponse,
  type JobStep,
} from "@/lib/job-inbox";
import {
  answerInboxItem,
  fetchInbox,
  inboxBadge,
  inboxItemAnswerable,
  inboxKindLabel,
  inboxRelativeTime,
  type InboxAnswer,
  type InboxItem,
} from "@/lib/inbox";
import { isYourMoveAsk, jobNextLine, jobShortTitle, jobStatus, splitJobs, yourMoveCount, type JobStatus } from "@/lib/jobs-page";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** While the page is visible it also refetches on this cadence, for plan
 * edits that do not move any thread's busy state. */
export const JOB_INBOX_POLL_MS = 20_000;

const STEP_TONE: Record<JobStep["status"], string> = {
  ready: "text-ink",
  waiting: "text-ink-secondary",
  blocked: "text-danger",
  done: "text-success",
};

const STATUS_TONE: Record<JobStatus["kind"], string> = {
  "needs-you": "border-warning/40 text-warning",
  blocked: "border-danger/40 text-danger",
  running: "border-accent/40 text-accent",
  waiting: "border-hairline/60 text-ink-secondary",
  paused: "border-hairline/60 text-ink-secondary",
  done: "border-success/40 text-success",
};

/** Asks plus jobs on the person, refetched whenever the server's inbox
 * count moves. The raw count also holds failed runs and unread replies,
 * which are not the person's to do. */
function useYourMoveCount(inboxCount: number): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([fetchInbox(), fetchJobInbox().catch(() => null)]).then(([inbox, jobs]) => {
      if (alive) setCount(yourMoveCount(inbox.items, jobs?.items ?? []));
    }, () => {});
    return () => { alive = false; };
  }, [inboxCount]);
  return count;
}

export function JobInboxNavRow({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const active = state.activeView === "jobs";
  const count = useYourMoveCount(state.inboxCount);
  const badge = inboxBadge(count);
  const icons = density === "icons";
  return (
    <div className={cn("pb-2", icons ? "px-2" : "px-3")}>
      <button
        type="button"
        data-sidebar-jobs
        onClick={() => dispatch({ type: "showJobs" })}
        aria-label={badge ? t("jobs.navCount", { count }) : t("jobs.title")}
        title={icons ? t("jobs.title") : undefined}
        className={cn(
          "relative flex min-h-9 w-full items-center rounded-xl py-1.5 text-left transition-colors",
          icons ? "justify-center px-2" : "gap-3 px-3",
          active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
        )}
      >
        <ListChecks size={18} className={active ? "text-accent" : "text-ink-secondary"} />
        {!icons && <span className="flex-1 text-[14px]">{t("jobs.title")}</span>}
        {badge && (
          <span data-jobs-badge className={cn(
            "flex min-w-4 items-center justify-center rounded-full bg-accent px-1 font-semibold text-ink",
            icons ? "absolute right-1 top-0.5 text-[9.5px] leading-4" : "text-[11px] leading-[18px]",
          )}>{badge}</span>
        )}
      </button>
    </div>
  );
}

const botName = (state: AppState, botId: string) =>
  state.bots.find((bot) => bot.id === botId)?.name || t("jobs.unknownBot");

/** document is absent under server rendering and tests; treat as visible. */
const pageVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

const jobKey = (item: Pick<JobInboxItem, "botId" | "threadId">) => `${item.botId}:${item.threadId}`;

export function JobInboxPage() {
  const { state, dispatch } = useStore();
  const [jobs, setJobs] = useState<JobInboxResponse | null | undefined>(undefined);
  const [asks, setAsks] = useState<InboxItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(pageVisible);
  const [reload, setReload] = useState(0);
  // ask ids with an answer in flight
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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
      onData: (next) => { setJobs(next); setError(null); },
      onError: (message) => {
        setError(t("jobs.loadFailed", { error: message }));
        setJobs((current) => current ?? { items: [] });
      },
      onSettled: () => setLoading(false),
    });
  }, [refreshKey, reload, visible]);

  // the count is the change signal; the list itself always comes fresh
  useEffect(() => {
    let alive = true;
    fetchInbox().then((next) => {
      if (!alive) return;
      setAsks(next.items.filter(isYourMoveAsk));
      dispatch({ type: "inboxCount", count: next.count });
    }, () => { if (alive) setAsks((current) => current ?? []); });
    return () => { alive = false; };
  }, [state.inboxCount, reload, dispatch]);

  /** One in-flight answer per ask; a failure stays on the page, not a toast. */
  const answer = (item: InboxItem, choice: InboxAnswer) => {
    if (busy.has(item.id)) return;
    setBusy((current) => new Set(current).add(item.id));
    setError(null);
    answerInboxItem(item, choice)
      .catch((cause) => setError(t("needsMe.answerFailed", { error: cause instanceof Error ? cause.message : String(cause) })))
      .finally(() => {
        setBusy((current) => { const next = new Set(current); next.delete(item.id); return next; });
        setReload((n) => n + 1);
      });
  };
  const toggle = (item: JobInboxItem) => setExpanded((current) => {
    const next = new Set(current);
    const key = jobKey(item);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <ListChecks size={18} className="text-ink-secondary" />
        <h1 className="text-[17px] font-semibold">{t("jobs.title")}</h1>
        <div className="ml-auto flex items-center gap-1">
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
          <JobInboxBody
            jobs={jobs}
            asks={asks}
            state={state}
            busy={busy}
            expanded={expanded}
            onToggle={toggle}
            onOpen={(item) => openJobThread(dispatch, item, state)}
            onOpenAsk={(item) => openThread(dispatch, { botId: item.botId, threadId: item.threadId }, state)}
            onAnswer={answer}
          />
        </div>
      </div>
    </main>
  );
}

type RowHandlers = {
  state: AppState;
  expanded: ReadonlySet<string>;
  onToggle: (item: JobInboxItem) => void;
  onOpen: (item: JobInboxItem) => void;
};

export function JobInboxBody({ jobs, asks, busy, onOpenAsk, onAnswer, ...rows }: RowHandlers & {
  jobs: JobInboxResponse | null | undefined;
  asks: InboxItem[] | undefined;
  busy: ReadonlySet<string>;
  onOpenAsk: (item: InboxItem) => void;
  onAnswer: (item: InboxItem, choice: InboxAnswer) => void;
}) {
  const split = splitJobs(jobs?.items ?? []);
  const yourMoveLoaded = asks !== undefined && jobs !== undefined;
  const yours = (asks?.length ?? 0) + split.yours.length;
  return (
    <>
      <section data-jobs-your-move className="flex flex-col gap-1">
        <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("jobs.yourMove")}{yours > 0 && ` · ${yours}`}
        </h2>
        {asks?.map((item) => (
          <AskRow key={item.id} item={item} state={rows.state} busy={busy.has(item.id)} onOpen={onOpenAsk} onAnswer={(choice) => onAnswer(item, choice)} />
        ))}
        {split.yours.map((item) => <JobRow key={jobKey(item)} item={item} {...rows} />)}
        {yourMoveLoaded && yours === 0 && <p data-jobs-nothing-on-you className="px-1 text-[13px] text-ink-secondary">{t("jobs.nothingOnYou")}</p>}
      </section>
      {jobs === undefined ? (
        <div data-jobs-loading className="flex justify-center py-10 text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>
      ) : jobs === null ? (
        <p data-jobs-unsupported className="py-10 text-center text-[13px] text-ink-secondary">{t("jobs.unsupported")}</p>
      ) : jobs.items.length === 0 ? (
        <div data-jobs-empty className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-[14px] text-ink">{t("jobs.empty")}</p>
          <p className="text-[12px] text-ink-secondary">{t("jobs.emptyHint")}</p>
        </div>
      ) : (
        <>
          {split.moving.length > 0 && (
            <section data-jobs-group="moving" className="flex flex-col gap-1">
              <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                {jobStateLabel("moving")} · {split.moving.length}
              </h2>
              {split.moving.map((item) => <JobRow key={jobKey(item)} item={item} {...rows} />)}
            </section>
          )}
          <FoldedJobs group="done" label={t("jobs.section.done")} items={split.done} {...rows} />
          <FoldedJobs group="paused" label={jobStateLabel("paused")} items={split.paused} {...rows} />
        </>
      )}
    </>
  );
}

/** Collapsed to a count until opened. */
function FoldedJobs({ group, label, items, ...rows }: RowHandlers & { group: string; label: string; items: JobInboxItem[] }) {
  if (items.length === 0) return null;
  return (
    <details data-jobs-group={group} className="group/fold flex flex-col gap-1">
      <summary className="flex cursor-pointer select-none list-none items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open/fold:rotate-90" />
        {label} · {items.length}
      </summary>
      <div className="mt-1 flex flex-col gap-1">
        {items.map((item) => <JobRow key={jobKey(item)} item={item} {...rows} />)}
      </div>
    </details>
  );
}

function statusLabel(status: JobStatus, state: AppState): string {
  switch (status.kind) {
    case "running": return t("jobs.status.running");
    case "blocked": return t("jobs.status.blocked");
    case "needs-you": return t("jobs.status.needsYou");
    case "waiting": return t("jobs.status.waitingOn", { name: botName(state, status.botId) });
    case "paused": return t("jobs.status.paused");
    case "done": return t("jobs.step.done");
  }
}

/** One line (short title, owners, status) plus one "next:" line; a tap
 * shows the full detail under it. */
export function JobRow({ item, state, expanded, onToggle, onOpen }: RowHandlers & { item: JobInboxItem }) {
  const open = expanded.has(jobKey(item));
  const { leadBotId, helperBotIds } = jobOwners(item);
  const owners = [leadBotId, ...helperBotIds].flatMap((id) => state.bots.find((bot) => bot.id === id) ?? []);
  const status = jobStatus(item);
  const title = jobShortTitle(item.outcome) || t("jobs.untitled");
  const next = jobNextLine(item);
  return (
    <article data-job-row data-job-state={item.state} className={cn("rounded-xl", open && "border border-hairline/40 bg-raised/20")}>
      <button
        type="button"
        data-job-toggle
        aria-expanded={open}
        onClick={() => onToggle(item)}
        title={item.outcome}
        className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="flex w-[52px] shrink-0 items-center pt-0.5">
          {owners.length > 0 ? owners.slice(0, 3).map((bot, index) => (
            <span key={bot.id} className={cn("rounded-full ring-2 ring-app", index > 0 && "-ml-2")}>
              <BotAvatar bot={bot} size={22} animated={false} />
            </span>
          )) : <ListChecks size={18} className="text-ink-secondary" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span data-job-title className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{title}</span>
            <span data-job-status={status.kind} className={cn("max-w-[40%] shrink-0 truncate rounded-full border px-2 py-0.5 text-[11px]", STATUS_TONE[status.kind])}>
              {statusLabel(status, state)}
            </span>
          </span>
          {next && (
            <span data-job-next className="mt-0.5 block truncate text-[12.5px] text-ink-secondary">
              {t("jobs.nextLine")} <span className="text-ink">{next}</span>
            </span>
          )}
        </span>
        <ChevronDown size={16} className={cn("mt-1 shrink-0 text-ink-secondary transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <JobDetail item={item} state={state} onOpen={onOpen} />}
    </article>
  );
}

/** Today's full card under a row: reason, owners, next step, results, steps. */
export function JobDetail({ item, state, onOpen }: { item: JobInboxItem; state: AppState; onOpen: (item: JobInboxItem) => void }) {
  const { helperBotIds } = jobOwners(item);
  const next = jobNextStep(item);
  const counts = jobStepCounts(item);
  return (
    <div data-job-detail className="flex flex-col gap-2 border-t border-hairline/30 px-3 py-2.5 sm:pl-[76px]">
      <p className="text-[12.5px] text-ink [overflow-wrap:anywhere]">{item.outcome || t("jobs.untitled")}</p>
      {item.reason && <p className="text-[12px] text-ink-secondary [overflow-wrap:anywhere]">{item.reason}</p>}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-secondary">
        <span>{t("jobs.lead", { name: botName(state, item.botId) })}</span>
        {helperBotIds.length > 0 && <span>{t("jobs.helpers", { names: helperBotIds.map((id) => botName(state, id)).join(", ") })}</span>}
        {counts.total > 0 && <span>{t("jobs.progress", { done: counts.done, total: counts.total })}</span>}
      </p>
      {next ? (
        <p className="text-[12.5px] text-ink [overflow-wrap:anywhere]">
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
      <button
        type="button"
        data-job-open
        onClick={() => onOpen(item)}
        className="self-start rounded-lg px-2 py-1 text-[12px] text-accent hover:bg-raised/50"
      >
        {t("jobs.open")}
      </button>
    </div>
  );
}

/** A live approval or question, answered in place; a tap opens its thread. */
function AskRow({ item, state, busy, onOpen, onAnswer }: {
  item: InboxItem;
  state: AppState;
  busy: boolean;
  onOpen: (item: InboxItem) => void;
  onAnswer: (choice: InboxAnswer) => void;
}) {
  const bot = state.bots.find((candidate) => candidate.id === item.botId);
  const group = item.groupId ? state.groups.find((candidate) => candidate.id === item.groupId) : undefined;
  const name = [bot?.name, group?.name].filter(Boolean).join(" · ");
  const kind = inboxKindLabel(item.kind);
  const Icon = item.kind === "question" ? CircleHelp : CircleAlert;
  const chip = "rounded-full border border-hairline/50 bg-control px-2.5 py-0.5 text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div data-jobs-ask className="rounded-xl hover:bg-raised/50">
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label={`${kind}: ${item.title}${name ? ` · ${name}` : ""}`}
        className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="flex w-[52px] shrink-0 items-center pt-0.5">
          {bot ? <BotAvatar bot={bot} size={22} animated={false} /> : <Icon size={18} className="text-warning" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{item.title || t("needsMe.untitled")}</span>
            <span className="shrink-0 text-[11px] text-ink-secondary">{inboxRelativeTime(item.at)}</span>
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-ink-secondary">{item.preview || name || kind}</span>
        </span>
      </button>
      {inboxItemAnswerable(item) && (
        <div className="flex flex-wrap gap-1.5 pb-2.5 pl-[76px] pr-3">
          {item.approval ? (
            <>
              <button type="button" disabled={busy} onClick={() => onAnswer({ behavior: "allow" })} className={chip}>{t("approval.action.allowOnce")}</button>
              <button type="button" disabled={busy} onClick={() => onAnswer({ behavior: "deny" })} className={chip}>{t("approval.action.deny")}</button>
            </>
          ) : (
            item.options?.map((option) => (
              <button key={option} type="button" disabled={busy} onClick={() => onAnswer({ option })} className={cn(chip, "max-w-full truncate")}>{option}</button>
            ))
          )}
          {busy && <Loader2 size={14} className="mt-1 animate-spin text-ink-secondary" />}
        </div>
      )}
    </div>
  );
}
