// Update & restart, like codex: a quiet "update ready" pill in the sidebar
// header, a Settings > Updates section that names the build and what's in
// it, a confirm sheet that lists the bots that will be paused and resumed,
// live progress while the server swaps the build, and one toast after the
// relaunch saying how it went. State comes from lib/bos-update.
//
// The pure pieces take a view and callbacks so the preview page and tests
// can drive every state; the connected wrappers at the bottom read the store.
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Check, CircleX, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  UPDATE_STEPS,
  acknowledgeNotice,
  applyUpdate,
  isUpdateRunning,
  noticeAcknowledged,
  restartApp,
  shortSha,
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
  return (view.status?.busyTurns ?? []).map(({ botId, threadId }) => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
    return { key: `${botId}:${threadId}`, name: bot?.name ?? botId, bot, threadTitle: task?.title };
  });
}

function formatStaged(at: number | string | undefined): string {
  if (at == null) return "";
  const date = new Date(typeof at === "number" ? at : Date.parse(at));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── sidebar pill ─────────────────────────────────────────────────────

/** Nothing when idle; "Update ready" when a candidate is staged; the live
 * step with a spinner while a run is going. Clicking opens Settings > Updates. */
export function UpdatePill({ view, onOpen, compact = false }: { view: UpdateView; onOpen: () => void; compact?: boolean }) {
  const running = isUpdateRunning(view.state) || view.pending !== null;
  if (!running && view.state !== "ready") return null;
  const label = running ? stepLabel(view.pending && !isUpdateRunning(view.state) ? "checkpointing" : view.state) : "Update ready";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={running ? `Updating · ${label}` : `Update to ${view.status?.candidate?.version ?? "the new build"}`}
      className={cn(
        "animate-panel-in flex items-center justify-center gap-1.5 rounded-full text-[12px] font-medium transition-colors",
        compact ? "size-10 rounded-md" : "h-7 px-2.5",
        running ? "bg-control text-ink-secondary" : "bg-accent/15 text-accent hover:bg-accent/25",
      )}
    >
      {running ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={compact ? 18 : 14} />}
      {/* the header is tight; the step itself lives in the tooltip and Settings */}
      {!compact && <span className="whitespace-nowrap">{running ? "Updating…" : label}</span>}
    </button>
  );
}

// ── progress ─────────────────────────────────────────────────────────

export function UpdateProgress({ view }: { view: UpdateView }) {
  const current = view.pending && !isUpdateRunning(view.state) ? "checkpointing" : view.state;
  const index = (UPDATE_STEPS as readonly string[]).indexOf(current);
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Update progress">
      {UPDATE_STEPS.map((step, i) => {
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
            {stepLabel(step)}
            {active && step === "relaunching" && view.offline && <span className="text-ink-secondary">· BOS will reopen by itself</span>}
            {active && view.detail && step !== "relaunching" && <span className="truncate text-ink-secondary">· {view.detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ── confirm sheet ────────────────────────────────────────────────────

export function ConfirmUpdateDialog({
  kind,
  version,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: "apply" | "restart";
  version?: string;
  busy: BusyEntry[];
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const title = kind === "apply" ? `Update to ${version ?? "the new build"} and restart?` : "Restart BOS?";
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bos-update-confirm-title"
        className="animate-panel-in w-full max-w-[400px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <h2 id="bos-update-confirm-title" className="text-[16px] font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          {busy.length === 0
            ? "No bots are working right now. Open chats, drafts and queues are saved first."
            : "Open chats, drafts and queues are saved first. These bots will be paused and pick up in the same thread after the restart:"}
        </p>
        {busy.length > 0 && (
          <ul className="mt-3 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl bg-inset p-1.5" aria-label="Bots that will be paused">
            {busy.map((entry) => (
              <li key={entry.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                {entry.bot ? (
                  <BotAvatar bot={entry.bot} size={24} state="working" motion="none" motionKey={0} animated={false} />
                ) : (
                  <span className="size-6 rounded-full bg-control" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{entry.name}</span>
                  {entry.threadTitle && <span className="block truncate text-[12px] text-ink-secondary">{entry.threadTitle}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => onConfirm(false)}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            <RefreshCw size={13} />
            {kind === "apply" ? "Update & restart" : "Restart"}
            {busy.length > 0 && <span className="font-normal opacity-80">· waits up to 90s</span>}
          </button>
          {busy.length > 0 && (
            <button
              type="button"
              onClick={() => onConfirm(true)}
              className="rounded-xl bg-control px-4 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Pause bots now and {kind === "apply" ? "update" : "restart"}
            </button>
          )}
          <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── settings section ─────────────────────────────────────────────────

export function UpdatesPanel({
  view,
  busy,
  onApply,
  onRestart,
}: {
  view: UpdateView;
  busy: BusyEntry[];
  onApply: (force: boolean) => void;
  onRestart: (force: boolean) => void;
}) {
  const [confirm, setConfirm] = useState<"apply" | "restart" | null>(null);
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
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-start gap-3">
          <img src="/app-icon.png" alt="" width={40} height={40} className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-ink">BOS {status.current.version}</div>
            <div className="mt-0.5 font-mono text-[12px] text-ink-secondary">{shortSha(status.current.sha)}</div>
          </div>
          {!candidate && !running && (!notice || notice.tone === "ok") && (
            <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[12px] text-success">
              <Check size={12} /> Up to date
            </span>
          )}
        </div>

        {candidate && !running && (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-medium text-ink">{candidate.version} is ready</span>
              <span className="shrink-0 font-mono text-[11.5px] text-ink-secondary">{shortSha(candidate.sha)}</span>
            </div>
            {formatStaged(candidate.stagedAt) && (
              <div className="mt-0.5 text-[12px] text-ink-secondary">Staged {formatStaged(candidate.stagedAt)}</div>
            )}
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
            <UpdateProgress view={view} />
          </div>
        )}

        {notice && !running && (
          <div
            className={cn(
              "mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]",
              notice.tone === "ok" ? "bg-success/10 text-success" : notice.tone === "warn" ? "bg-amber-500/10 text-amber-500" : "bg-red-500/10 text-red-500",
            )}
          >
            {notice.tone === "ok" ? <Check size={14} className="mt-0.5 shrink-0" /> : notice.tone === "warn" ? <RotateCcw size={14} className="mt-0.5 shrink-0" /> : <CircleX size={14} className="mt-0.5 shrink-0" />}
            <span>
              Last run: {notice.title}
              {notice.detail ? ` · ${notice.detail}` : ""}
            </span>
          </div>
        )}

        {view.error && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-500">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {view.error}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {candidate && (
            <button
              type="button"
              disabled={running}
              onClick={() => setConfirm("apply")}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:cursor-default disabled:bg-control disabled:text-ink-secondary"
            >
              {view.pending === "apply" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Update & restart
            </button>
          )}
          <button type="button" disabled={running} onClick={() => setConfirm("restart")} className="ui-button">
            {view.pending === "restart" ? <Loader2 size={13} className="animate-spin" /> : null}
            Restart
          </button>
        </div>
        {busy.length > 0 && !running && (
          <div className="mt-2 text-[12px] text-ink-secondary">
            {busy.length === 1 ? "1 bot is working" : `${busy.length} bots are working`} — they'll be paused and resumed.
          </div>
        )}
      </div>

      {confirm && (
        <ConfirmUpdateDialog
          kind={confirm}
          version={candidate?.version}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={(force) => {
            setConfirm(null);
            (confirm === "apply" ? onApply : onRestart)(force);
          }}
        />
      )}
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

export function SidebarUpdatePill({ compact }: { compact?: boolean }) {
  const view = useBosUpdate();
  const { dispatch } = useStore();
  return <UpdatePill view={view} compact={compact} onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "updates" })} />;
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
