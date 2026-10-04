// Claude and Codex subscription limits, always visible under Tools.
//
// One line per account: the provider, then each window's used percent, with
// a thin bar for whichever window is closest to its cap. A click opens the
// full Usage settings with reset times and per-bot spend.
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { useProviderUsage, type Account } from "./ProviderUsage";

function barTone(percent: number) {
  return percent >= 85 ? "bg-red-500" : percent >= 65 ? "bg-amber-500" : "bg-accent";
}

function windows(account: Account) {
  return [
    account.fiveHour ? { label: "5h", ...account.fiveHour } : null,
    { label: "7d", ...account.sevenDay },
  ].filter((w): w is NonNullable<typeof w> => w !== null);
}

export function SidebarUsageRow() {
  const { dispatch } = useStore();
  const { accounts } = useProviderUsage();
  if (!accounts || accounts.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
      className="flex w-full flex-col gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-raised/50"
      data-testid="sidebar-usage"
    >
      {accounts.map((account, index) => {
        const list = windows(account);
        const known = list.filter((w) => w.usedPercent !== null);
        const peak = known.length ? Math.max(...known.map((w) => w.usedPercent as number)) : null;
        const title = list
          .map((w) => `${w.label}: ${w.usedPercent === null ? "unavailable" : `${Math.round(w.usedPercent)}% used`}${w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ""}`)
          .join("\n");
        return (
          <div key={`${account.provider}-${index}`} className="space-y-1" title={title}>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="text-ink">{account.provider === "claude" ? "Claude" : "Codex"}</span>
              <span className="truncate tabular-nums text-ink-secondary">
                {list.map((w) => `${w.label} ${w.usedPercent === null ? "–" : `${Math.round(w.usedPercent)}%`}`).join(" · ")}
              </span>
            </div>
            {peak !== null && (
              <div className="h-1 overflow-hidden rounded-full bg-hairline/40">
                <div className={cn("h-full rounded-full", barTone(peak))} style={{ width: `${Math.min(100, peak)}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </button>
  );
}
