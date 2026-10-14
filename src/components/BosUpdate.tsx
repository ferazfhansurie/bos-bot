// One-press update, like codex: a quiet "update 1.3.0" pill under the sidebar
// profile row that only shows when the server has a newer build that passes the
// no-downgrade guard, a Settings > Updates section, one confirm line, live
// progress (building, waiting for named bots, installing, restarting) while
// the server runs it, and one toast after the restart saying how it went.
// State comes from lib/bos-update.
//
// The pure pieces take a view and callbacks so the preview page and tests
// can drive every state; the connected wrappers at the bottom read the store.
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, ArrowUpCircle, Check, CircleX, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { appVersion } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import {
  UPDATE_STEPS,
  acknowledgeNotice,
  applyUpdate,
  availableCandidate,
  checkForUpdate,
  drainingLabel,
  isUpdateRunning,
  noticeAcknowledged,
  restartApp,
  shortSha,
  shortVersion,
  stepLabel,
  updateNotice,
  useBosUpdate,
  type UpdateNotice,
  type UpdateView,
} from "@/lib/bos-update";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

export interface BusyEntry {
  key: string;
  name: string;
  bot?: Bot;
  threadTitle?: string;
}

export function busyEntries(view: UpdateView, bots: Bot[]): BusyEntry[] {
  return (view.status?.busyTurns ?? []).map(({ botId, threadId, botName }) => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
    return { key: `${botId}:${threadId}`, name: botName ?? bot?.name ?? botId, bot, threadTitle: task?.title };
  });
}

function formatStaged(at: number | string | undefined): string {
  if (at == null) return "";
  const date = new Date(typeof at === "number" ? at : Date.parse(at));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── sidebar footer ───────────────────────────────────────────────────

/** Nothing when idle; "update 1.4.0" (or just "update" when only the build
 * differs) when a newer build is allowed; a spinner while a run is going.
 * Clicking opens Settings > Updates. Lives under the profile row at the
 * bottom of the sidebar, never in the top bar. */
export function UpdatePill({ view, onOpen, compact = false }: { view: UpdateView; onOpen: () => void; compact?: boolean }) {
  const running = isUpdateRunning(view.state) || view.pending !== null;
  const candidate = availableCandidate(view.status);
  if (!running && (view.state !== "ready" || !candidate)) return null;
  const from = shortVersion(view.status?.current.version);
  const to = shortVersion(candidate?.version);
  const step = stepLabel(view.pending && !isUpdateRunning(view.state) ? (view.pending === "restart" ? "draining" : "building") : view.state);
  const label = running ? "Updating…" : to && to !== from ? `update ${to}` : "update";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={running ? step : label}
      title={running ? `Updating · ${step}` : to ? `Update BOS ${from} → ${to}` : "Update BOS"}
      className={cn(
        "animate-panel-in flex shrink-0 items-center justify-center gap-1 rounded-full font-medium transition-colors",
        compact ? "size-8 rounded-md" : "h-5 px-2 text-[11px]",
        running ? "bg-control text-ink-secondary" : "bg-accent/15 text-accent hover:bg-accent/25",
      )}
    >
      {running ? <Loader2 size={compact ? 16 : 11} className="animate-spin" /> : <ArrowUpCircle size={compact ? 16 : 11} />}
      {!compact && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

/** The muted "bos 1.9.3" under the profile row, with the update pill on the
 * right when there is something to install. `compact` (icons-only sidebar)
 * drops the text and keeps only the pill. */
export function VersionFooter({ view, version, onOpen, showUpdate = true, compact = false }: { view: UpdateView; version: string; onOpen: () => void; showUpdate?: boolean; compact?: boolean }) {
  const pill = showUpdate ? <UpdatePill view={view} onOpen={onOpen} compact={compact} /> : null;
  if (compact) return pill ? <div className="flex justify-center pb-1">{pill}</div> : null;
  return (
    <div className="flex min-h-5 items-center justify-between gap-2 px-3 pt-1">
      <span className="truncate text-[11px] text-ink-secondary/70" title={`BOS ${version}`}>bos {version}</span>
      {pill}
    </div>
  );
}

// ── progress ─────────────────────────────────────────────────────────

/** `restart` drops the build step: a plain restart has nothing to build. */
export function UpdateProgress({ view, busy = [], restart = false }: { view: UpdateView; busy?: BusyEntry[]; restart?: boolean }) {
  const current = view.pending && !isUpdateRunning(view.state) ? (view.pending === "restart" ? "draining" : "building") : view.state;
  const steps = restart ? UPDATE_STEPS.filter((step) => step !== "building") : UPDATE_STEPS;
  const index = (steps as readonly string[]).indexOf(current);
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Update progress">
      {steps.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className={cn("flex items-center gap-2 text-[13px]", done ? "text-ink-secondary" : active ? "text-ink" : "text-ink-secondary/60")}
          >
            <span className="flex size-4 items-center justify-center">
              {done ? <Check size={13} className="text-success" /> : active ? <Loader2 size={13} className="animate-spin text-accent" /> : <span className="size-1.5 rounded-full bg-current" />}
            </span>
            {step === "draining" && active ? drainingLabel(busy.map((entry) => entry.name)) : stepLabel(step)}
            {step === "draining" && active && busy.some((entry) => entry.bot) && (
              <span className="flex -space-x-1.5" aria-hidden>
                {busy.map((entry) =>
                  entry.bot ? (
                    <span key={entry.key} className="rounded-full ring-2 ring-inset">
                      <BotAvatar bot={entry.bot} size={18} state="working" motion="none" motionKey={0} animated={false} />
                    </span>
                  ) : null,
                )}
              </span>
            )}
            {active && step === "relaunching" && view.offline && <span className="text-ink-secondary">· BOS will reopen by itself</span>}
            {active && view.detail && step !== "relaunching" && step !== "draining" && <span className="truncate text-ink-secondary">· {view.detail}</span>}
            {active && step === "building" && view.log.length > 0 && <BuildLog log={view.log} />}
          </li>
        );
      })}
    </ol>
  );
}

/** The build output tail, collapsed to one line until opened. */
export function BuildLog({ log }: { log: string[] }) {
  return (
    <details className="group ml-auto min-w-0 max-w-[60%] text-[12px] text-ink-secondary">
      <summary className="cursor-pointer list-none truncate font-mono hover:text-ink" title="Show build output">
        {log[log.length - 1]}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-app/60 p-2 font-mono text-[11.5px] leading-relaxed">{log.join("\n")}</pre>
    </details>
  );
}

// ── confirm line ─────────────────────────────────────────────────────

/** One line, inline: what happens, then go or cancel. Bots mid-reply get to
 * finish (bounded by the server); pressing is the approval to interrupt after. */
export function ConfirmUpdateLine({
  kind,
  from,
  to,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: "apply" | "restart";
  from?: string;
  to?: string;
  busy: BusyEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const what = kind === "apply" ? `Update ${from} → ${to} and restart?` : "Restart BOS?";
  const bots = busy.length === 0 ? "Chats and drafts are saved first." : busy.length === 1 ? `${busy[0].name} finishes first.` : `${busy.length} bots finish first.`;
  return (
    <div role="group" aria-label="Confirm update" className="animate-panel-in mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={`${what} ${bots}`}>
        {what} <span className="text-ink-secondary">{bots}</span>
      </span>
      <button type="button" autoFocus onClick={onConfirm} className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:brightness-110">
        {kind === "apply" ? "Update" : "Restart"}
      </button>
      <button type="button" onClick={onCancel} className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
        Cancel
      </button>
    </div>
  );
}

// ── settings section ─────────────────────────────────────────────────

export function UpdatesPanel({
  view,
  busy,
  onApply,
  onRestart,
  onCheck,
  initialConfirm,
}: {
  view: UpdateView;
  busy: BusyEntry[];
  onApply: (force: boolean) => void;
  onRestart: (force: boolean) => void;
  onCheck?: () => void;
  /** Preview seam: open with the confirm line showing. */
  initialConfirm?: "apply" | "restart" | null;
}) {
  const [confirm, setConfirm] = useState<"apply" | "restart" | null>(initialConfirm ?? null);
  const status = view.status;
  const running = isUpdateRunning(view.state) || view.pending !== null;
  const candidate = status?.candidate;
  const notice = updateNotice(status);
  if (!status) {
    return (
      <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
        {view.offline ? "BOS is relaunching…" : "Checking this computer for a new build…"}
      </div>
    );
  }
  // One status line: "Up to date" stands alone, so neither the guard's own
  // "up to date: …" reason nor a green "Updated to …" repeats it.
  const upToDate = !status.shellRequired && (status.upToDate === true || /^(up to date:|already on the newest prod build)/i.test(status.reason ?? "")) && !candidate && !running && (!notice || notice.tone === "ok");
  const shownNotice = notice && !running && !(upToDate && notice.tone === "ok") ? notice : null;
  const reason = !candidate && !running && !upToDate && !status.shellRequired ? status.reason : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center gap-3">
          <img src="/app-icon.png" alt="" width={40} height={40} className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-ink" title={shortSha(status.current.sha)}>BOS {status.current.version}</div>
          </div>
          {upToDate && (
            <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[12px] text-success">
              <Check size={12} /> Up to date
            </span>
          )}
        </div>

        {status.shellRequired && !running && <div role="status" className="mt-4 text-[13px] text-amber-500">Desktop shell update required</div>}

        {candidate && !running && (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                {status.current.version} <ArrowRight size={13} className="text-ink-secondary" /> {candidate.version}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-ink-secondary">{shortSha(candidate.sha)}</span>
            </div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              {candidate.delivery === "staged-full" ? "Full desktop package on " : "Newer build on "}{candidate.branch ?? "prod"}
              {formatStaged(candidate.stagedAt) ? ` · ${formatStaged(candidate.stagedAt)}` : ""}
            </div>
            {candidate.notes && candidate.notes.length > 0 && (
              <>
                <div className="mt-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">What's in it</div>
                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-relaxed text-ink">
                  {candidate.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {running && (
          <div className="mt-4 rounded-lg bg-inset p-3">
            <div className="mb-2 text-[13px] font-medium text-ink">
              {candidate ? `Updating to ${candidate.version}` : "Restarting"}
            </div>
            <UpdateProgress view={view} busy={busy} restart={!candidate} />
          </div>
        )}

        {shownNotice && (
          <div
            className={cn(
              "mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]",
              shownNotice.tone === "ok" ? "bg-success/10 text-success" : shownNotice.tone === "warn" ? "bg-amber-500/10 text-amber-500" : "bg-red-500/10 text-red-500",
            )}
          >
            {shownNotice.tone === "ok" ? <Check size={14} className="mt-0.5 shrink-0" /> : shownNotice.tone === "warn" ? <RotateCcw size={14} className="mt-0.5 shrink-0" /> : <CircleX size={14} className="mt-0.5 shrink-0" />}
            <span>
              {shownNotice.title}
              {shownNotice.detail ? ` · ${shownNotice.detail}` : ""}
            </span>
          </div>
        )}

        {view.error && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-500">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {view.error}
          </div>
        )}

        {confirm && !running ? (
          <ConfirmUpdateLine
            kind={confirm}
            from={status.current.version}
            to={candidate?.version}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              setConfirm(null);
              (confirm === "apply" ? onApply : onRestart)(false);
            }}
          />
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {candidate && (
              <button
                type="button"
                disabled={running}
                onClick={() => setConfirm("apply")}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:cursor-default disabled:bg-control disabled:text-ink-secondary"
              >
                {view.pending === "apply" || running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {running ? "Updating…" : "Update"}
              </button>
            )}
            {!candidate && onCheck && (
              <button type="button" disabled={running || view.checking} onClick={onCheck} className="ui-button">
                {view.checking ? <Loader2 size={13} className="animate-spin" /> : null}
                Check for updates
              </button>
            )}
            <button type="button" disabled={running} onClick={() => setConfirm("restart")} className="ui-button">
              {view.pending === "restart" ? <Loader2 size={13} className="animate-spin" /> : null}
              Restart
            </button>
            {reason && <span className="text-[12px] text-ink-secondary">{reason}</span>}
          </div>
        )}
        {busy.length > 0 && !running && !confirm && candidate && (
          <div className="mt-2 text-[12px] text-ink-secondary">
            {busy.length === 1 ? "1 bot is working" : `${busy.length} bots are working`}; the update waits for {busy.length === 1 ? "it" : "them"} to finish.
          </div>
        )}
      </div>
    </div>
  );
}

// ── post-relaunch toast ──────────────────────────────────────────────

export function UpdateResultToast({ notice, onDismiss }: { notice: UpdateNotice; onDismiss: () => void }) {
  useEffect(() => {
    if (notice.tone !== "ok") return;
    const timer = setTimeout(onDismiss, 8_000);
    return () => clearTimeout(timer);
  }, [notice.key, notice.tone, onDismiss]);
  return (
    <div
      role="status"
      className="animate-panel-in fixed bottom-4 left-4 z-50 flex w-[320px] items-start gap-2.5 rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
    >
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          notice.tone === "ok" ? "bg-success/15 text-success" : notice.tone === "warn" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-500",
        )}
      >
        {notice.tone === "ok" ? <Check size={14} /> : notice.tone === "warn" ? <RotateCcw size={14} /> : <CircleX size={14} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink">{notice.title}</div>
        {notice.detail && <div className="mt-0.5 font-mono text-[12px] text-ink-secondary">{notice.detail}</div>}
      </div>
      <button type="button" onClick={onDismiss} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

// ── connected wrappers ───────────────────────────────────────────────

export function SidebarVersionFooter({ compact, showUpdate }: { compact?: boolean; showUpdate?: boolean }) {
  const view = useBosUpdate();
  const { dispatch } = useStore();
  return (
    <VersionFooter
      view={view}
      version={shortVersion(appVersion())}
      compact={compact}
      showUpdate={showUpdate}
      onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "updates" })}
    />
  );
}

export function UpdatesSettings() {
  const view = useBosUpdate();
  const { state } = useStore();
  return (
    <UpdatesPanel
      view={view}
      busy={busyEntries(view, state.bots)}
      onApply={(force) => void applyUpdate(force)}
      onRestart={(force) => void restartApp(force)}
      onCheck={() => void checkForUpdate()}
    />
  );
}

export function BosUpdateToast() {
  const view = useBosUpdate();
  const notice = updateNotice(view.status);
  if (!notice || isUpdateRunning(view.state) || noticeAcknowledged(notice.key)) return null;
  // only a run that just finished earns a toast; Settings keeps older ones
  const at = view.status?.lastResult?.at;
  const finished = typeof at === "number" ? at : Date.parse(String(at));
  if (!(Date.now() - finished < 15 * 60_000)) return null;
  return <UpdateResultToast notice={notice} onDismiss={() => acknowledgeNotice(notice.key)} />;
}
