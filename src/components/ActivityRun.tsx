// One quiet row for consecutive work, including a truthful live state.
// Failed tools and recovery reviews remain outside this disclosure.
import { useEffect, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import { WorkingDots } from "./WorkingIndicator";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** A search hit reveals the step inside this run. */
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  const contentId = useId();
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const running = messages.filter(message => message.tool?.ok === undefined);
  const label = describeRun(messages);
  const liveLabel = running.length
    ? t("toolDetail.working")
    : null;
  return (
    <div className="max-w-full" data-testid="activity-run" data-running={running.length > 0 || undefined}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={liveLabel ? `${liveLabel} · ${label}` : undefined}
        title={label}
        className="chat-text-tertiary flex min-h-7 max-w-full items-center gap-1.5 p-0 text-[14px] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {liveLabel ? <WorkingDots size={3.5} /> : <span className="size-1 shrink-0 rounded-full bg-ink-tertiary" aria-hidden="true" />}
        <span className="min-w-0 truncate">{liveLabel ?? label}</span>
        {liveLabel && <span className="shrink-0 text-ink-tertiary">{messages.length}</span>}
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
      </button>
      <div id={contentId} hidden={!open} className="mt-1 flex flex-col gap-1 border-t chat-hairline pt-1">
        {open && children}
      </div>
    </div>
  );
}
