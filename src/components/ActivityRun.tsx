// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A search hit inside a run opens it, and a run stays
// open once the user has opened it. Failed steps never enter a folded run.
import { useEffect, useState } from "react";
import { ChevronRight, Check } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex min-h-9 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronRight size={13} className="rotate-90" />
            <span>{describeRun(messages)}</span>
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title={t("chat.run.showSteps")}
        className="flex min-h-9 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Check size={13} className="text-success" />
        <span className="max-w-[480px] truncate">{describeRun(messages)}</span>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
