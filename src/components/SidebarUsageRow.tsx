// Claude, Codex and xAI at a glance, always visible under Tools.
//
// One row, three columns: the provider and its number (Claude's 5h·7d, Codex
// 7d, xAI credits left), with a hairline bar for whichever window is
// closest to its cap. Hover has reset times; a click opens Settings → Usage.
import { cn } from "@/lib/cn";
import { barTone, usageChips } from "@/lib/usage-chips";
import { useStore } from "@/state/store";
import { useProviderUsage } from "./ProviderUsage";
import { useXaiUsage } from "./XaiUsage";

export function SidebarUsageRow() {
  const { dispatch } = useStore();
  const { accounts } = useProviderUsage();
  const { value: xai } = useXaiUsage();
  const chips = usageChips(accounts, xai);
  if (chips.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
      className="flex w-full items-start gap-2.5 rounded-xl px-3 py-1.5 text-left transition-colors hover:bg-raised/50"
      aria-label="Usage"
      data-testid="sidebar-usage"
    >
      {chips.map((chip) => (
        <span key={chip.key} className="min-w-0 flex-auto space-y-1" title={chip.title} data-testid={`sidebar-usage-${chip.key}`}>
          <span className="flex items-baseline gap-1 whitespace-nowrap text-[11px] leading-4">
            <span className="text-ink-secondary">{chip.label}</span>
            <span className="truncate tabular-nums text-ink">{chip.value}</span>
          </span>
          <span className="block h-[2px] overflow-hidden rounded-full bg-hairline/40">
            {chip.peak !== null && (
              <span className={cn("block h-full rounded-full", barTone(chip.peak))} style={{ width: `${Math.max(2, Math.min(100, chip.peak))}%` }} />
            )}
          </span>
        </span>
      ))}
    </button>
  );
}
