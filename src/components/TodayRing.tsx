// The "today" row on top of the 3.0 bot list: a ring that fills as the
// person clears the day's check-in items, the count still waiting, and the
// top item as the preview line, like any chat.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { clearedShare, openItems, useCheckins } from "@/lib/checkins";

export function TodayRing({ count, share, size = 40 }: { count: number; share: number; size?: number }) {
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  return (
    <span className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-hairline/40" />
        {share > 0 && (
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={length} strokeDashoffset={length * (1 - Math.min(1, share))} className="stroke-accent transition-[stroke-dashoffset] duration-500" />
        )}
      </svg>
      <span className={cn("absolute text-[13px] font-semibold tabular-nums", count ? "text-ink" : "text-ink-secondary")}>{count}</span>
    </span>
  );
}

export function TodayRow({ selected, compact, onOpen }: { selected: boolean; compact: boolean; onOpen: () => void }) {
  const { snapshot } = useCheckins(true);
  const open = openItems(snapshot);
  const share = clearedShare(snapshot);
  const preview = !snapshot ? ""
    : open.length ? (open.length > 1 ? t("v3.today.previewMore", { title: open[0]!.title, count: open.length - 1 }) : open[0]!.title)
    : snapshot.setUp ? t("v3.today.previewClear") : t("v3.today.previewSetup");
  const label = `${t("v3.sidebar.today")}${open.length ? ` · ${open.length}` : ""}`;
  return (
    <button type="button" data-v3-head data-testid="sidebar-today" aria-pressed={selected} onClick={onOpen}
      title={compact ? label : undefined} aria-label={compact ? label : undefined}
      className={cn(
        "relative flex w-full items-center rounded-[10px] text-left outline-none focus-visible:ring-1 focus-visible:ring-hairline",
        compact ? "justify-center px-1 py-1.5" : "gap-2 px-1 py-3",
        selected ? "bg-raised/70" : "hover:bg-raised/40",
      )}>
      <TodayRing count={open.length} share={share} />
      {!compact && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-5 text-ink">{t("v3.sidebar.today")}</span>
          <span className="block truncate text-[13px] leading-5 text-ink-secondary">{preview}</span>
        </span>
      )}
    </button>
  );
}
