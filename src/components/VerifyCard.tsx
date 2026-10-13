import { BookmarkPlus, CheckCircle2, ChevronDown, ChevronUp, Loader2, X, XCircle } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { runSummary, type RunStep } from "@/lib/verify-steps";

function StatusIcon({ status }: { status: RunStep["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <Loader2 aria-hidden="true" className={cn(className, "animate-spin text-accent")} />;
    case "passed":
      return <CheckCircle2 aria-hidden="true" className={cn(className, "text-success")} />;
    case "failed":
      return <XCircle aria-hidden="true" className={cn(className, "text-danger")} />;
  }
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60";

/** A bot's run in the current ask as a checklist — every command it ran,
 * the control-CLI ones tagged verified — with one action: put the run into
 * the composer as a skill request, for the person to annotate and send
 * through the ordinary skill review flow. The card renders whatever steps it
 * is given; whether a run is worth a card (`showRun`) is the caller's call.
 * Collapse is the card's own (a long run starts folded); dismissal is the
 * caller's, since it outlives the card. */
export function VerifyCard({
  steps,
  canSave,
  staged,
  onDismiss,
  onSave,
  initiallyOpen = false,
}: {
  steps: RunStep[];
  /** The run can be saved now: skill authoring is on, the engine has the
   * agents tools, something passed, nothing is still running or busy. */
  canSave: boolean;
  /** A skill from this run is already waiting for review. */
  staged: boolean;
  onDismiss: () => void;
  /** Fills the thread's composer with the run; nothing is sent. */
  onSave: () => void;
  /** Show the steps from the start instead of the one line. */
  initiallyOpen?: boolean;
}) {
  // starts folded: one quiet line over the composer, the steps on request
  const [collapsed, setCollapsed] = useState(!initiallyOpen);
  if (steps.length === 0) return null;
  const toggleLabel = collapsed ? t("chat.verify.expand") : t("chat.verify.collapse");
  return (
    <section
      aria-label={t("chat.verify.aria")}
      className="animate-pop-in relative mx-auto w-full max-w-[560px] overflow-hidden rounded-[18px] border border-hairline/25 bg-raised/70 text-ink backdrop-blur-md"
    >
      {!collapsed && (
        <ol
          tabIndex={0}
          aria-label={t("chat.verify.steps")}
          className="max-h-44 overflow-y-auto border-b border-hairline/20 px-3.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-center gap-2 py-0.5">
              <StatusIcon status={step.status} />
              <span className="shrink-0 text-[12.5px]">{step.label}</span>
              {step.verified && (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-success">{t("chat.verify.verifiedTag")}</span>
              )}
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={step.command}>
                {step.command}
              </code>
            </li>
          ))}
        </ol>
      )}
      <div className="flex h-9 items-center gap-1 pe-1 ps-3">
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] text-ink-secondary outline-none hover:text-ink focus-visible:text-ink"
        >
          <CheckCircle2 size={13} aria-hidden="true" className="shrink-0 text-success" />
          <span role="status" aria-live="polite" aria-atomic="true" className="truncate">
            {runSummary(steps).label}
            {staged && ` · ${t("chat.verify.staged")}`}
          </span>
          {collapsed ? <ChevronUp size={13} aria-hidden="true" className="shrink-0" /> : <ChevronDown size={13} aria-hidden="true" className="shrink-0" />}
        </button>
        {canSave && !staged && (
          <button
            type="button"
            onClick={onSave}
            title={t("chat.verify.saveHint")}
            className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <BookmarkPlus size={13} aria-hidden="true" />
            {t("chat.verify.save")}
          </button>
        )}
        <button type="button" onClick={onDismiss} aria-label={t("chat.verify.dismiss")} title={t("chat.verify.dismiss")} className={ICON_BUTTON}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
