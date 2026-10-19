import { ChevronRight, Square, Info, Terminal, BookOpen, Search, Folder, Pencil, Globe, Bot, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { api, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { placeLabelKey, type Place } from "@/lib/place";
import { nameIsCommand } from "@/lib/verify-steps";
import { PlaceIcon } from "./PlaceIcon";
import { WorkingDots } from "./WorkingIndicator";

type RecoveryReview = NonNullable<NonNullable<Message["tool"]>["recovery"]>;
export async function reviewPrivateTurnOutcome(recovery: RecoveryReview, confirmed: boolean, request: (path: string, init?: RequestInit) => Promise<{ receipt: { reviewedAt?: number } }> = api): Promise<number> {
  if (!confirmed) throw new Error(t("toolRecovery.confirm"));
  const path = `/api/bots/${encodeURIComponent(recovery.botId)}/threads/${encodeURIComponent(recovery.threadId)}/recovery/${encodeURIComponent(recovery.id)}/review`;
  const result = await request(path, { method: "POST", body: JSON.stringify({ confirmed: true }) });
  if (!Number.isSafeInteger(result.receipt?.reviewedAt) || result.receipt.reviewedAt! <= 0) throw new Error(t("toolRecovery.unverified"));
  return result.receipt.reviewedAt!;
}
function RecoveryOutcomeReview({ recovery }: { recovery: RecoveryReview }) {
  const [confirmed, setConfirmed] = useState(false);
  const [reviewedAt, setReviewedAt] = useState<number | undefined>(recovery.reviewedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  if (reviewedAt || recovery.reviewedAt) return <p className="text-xs text-ink-secondary" role="status">{t("toolRecovery.reviewed")}</p>;
  const review = async () => {
    if (!confirmed || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { setReviewedAt(await reviewPrivateTurnOutcome(recovery, confirmed)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("toolRecovery.failed")); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="space-y-2 rounded-lg border border-hairline/40 p-3 text-xs text-ink-secondary">
    <p>{t("toolRecovery.help")}</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)} />{t("toolRecovery.checkbox")}</label>
    <button type="button" disabled={!confirmed || busy} onClick={() => void review()} className="rounded-lg bg-accent px-3 py-1.5 text-accent-ink disabled:opacity-40">{busy ? t("toolRecovery.saving") : t("toolRecovery.mark")}</button>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

/** A quiet disclosure, not a second inspector. Old messages and providers
 * without output keep their status and never invent a successful result. */
/** `place` names where a screen or page tool ran, so a transcript shows the
 * place of every step, not just the current one. Absent for tools that touch
 * no screen. */
export function ToolActivity({ tool, place = null, stopReason }: { stopReason?: string; tool: NonNullable<Message["tool"]>; place?: Place | null }) {
  const [expanded, setExpanded] = useState(false);
  const stopped = tool.name === "stopped" || (tool.name === "turn failed" && stopReason === "interrupted");
  const name = stopped ? "stopped" : tool.name;
  const failed = tool.ok === false && !stopped;
  const terminalFailure = failed && (name === "turn failed" || name.startsWith("error:"));
  const displayName = stopped ? "stopped" : failed ? t(terminalFailure ? "toolDetail.requestIncomplete" : "toolDetail.stepIncomplete") : (nameIsCommand(name) || /^(bash|shell|exec_command|terminal|run_command)$/i.test(name)) ? t("toolDetail.commandStep") : name;
  const rowLabel = !failed && !stopped && tool.summary
    ? `${/bash|shell|command|terminal/i.test(name) || nameIsCommand(name) ? "Ran" : name} ${tool.summary}`
    : displayName;
  const Icon = /read/i.test(name) ? BookOpen : /search|grep/i.test(name) ? Search : /list|glob/i.test(name) ? Folder : /edit|write|patch/i.test(name) ? Pencil : /web|browse|fetch/i.test(name) ? Globe : /agent/i.test(name) ? Bot : /bash|shell|command|terminal/i.test(name) ? Terminal : Wrench;
  const status = stopped ? "stopped" : tool.ok === undefined ? t("toolDetail.running") : failed ? t("toolDetail.failed") : t("toolDetail.completed");
  return (
    <div className="max-w-full space-y-2">
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="group/tool w-fit max-w-full rounded-lg text-xs open:w-[min(38rem,100%)] open:border open:border-hairline/40 open:bg-panel" data-testid="tool-activity">
      <summary
        role="button"
        aria-expanded={expanded}
        aria-label={t("toolDetail.label", { name: displayName, status })}
        className={cn("chat-step flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg py-1 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden")}
      >
        <span className="shrink-0" aria-hidden="true">{stopped ? <Square size={11} /> : tool.ok === undefined ? <WorkingDots size={3.5} /> : failed ? <Info size={13} /> : <Icon size={16} />}</span>
        {place && <PlaceIcon place={place} size={13} className="shrink-0 opacity-70" role="img" aria-label={t(placeLabelKey(place))} data-testid="tool-place" />}
        <span className="min-w-0 max-w-[30rem] truncate font-normal">{rowLabel}</span>

        <ChevronRight size={13} className="ml-auto shrink-0 group-open/tool:rotate-90" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-hairline/40 p-3 text-ink-secondary">
        {failed && <p>{t(terminalFailure ? "toolDetail.requestIncompleteHelp" : "toolDetail.stepIncompleteHelp")}</p>}
        <div className="break-words font-mono text-[11px]">{name}</div>
        <div className="text-[11px] font-medium">{status}</div>
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.input")}</div>
          <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.input ?? t("toolDetail.noInput")}</pre>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.output")}</div>
          {tool.output ? <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.output}</pre> : <p className="text-xs">{tool.ok === undefined ? t("toolDetail.waiting") : t("toolDetail.noOutput")}</p>}
        </div>
        <p className="text-[11px] text-ink-secondary">{t("toolDetail.previewHint")}</p>
      </div>
    </details>
    {tool.recovery && <RecoveryOutcomeReview recovery={tool.recovery} />}
    </div>
  );
}
