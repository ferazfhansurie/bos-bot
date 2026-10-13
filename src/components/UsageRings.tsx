import type { ReactNode } from "react";
import { accountRings } from "@/lib/account-usage";
import { useProfileUsageVisibility } from "@/lib/profile-usage-visibility";
import { cn } from "@/lib/cn";
import { formatCents, type UsageAccount, type UsageWindow } from "@/lib/usage-chips";
import { useProviderUsage } from "./ProviderUsage";
import { useXaiUsage } from "./XaiUsage";

const STROKE = 2.5;
const DANGER = "#EF4444";

function windowsOf(account: UsageAccount): Array<UsageWindow & { label: string }> {
  return [
    ...(account.fiveHour ? [{ label: "5h", ...account.fiveHour }] : []),
    { label: "7d", ...account.sevenDay },
  ];
}

function resetLabel(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Ring({ radius, color, peak, size }: { radius: number; color: string; peak: number | null; size: number }) {
  const SIZE = size;
  const circumference = 2 * Math.PI * radius;
  const tone = (peak ?? 0) >= 85 ? DANGER : color;
  return (
    <>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" stroke={tone} strokeOpacity={peak === null ? 0.5 : 0.2} strokeDasharray={peak === null ? "2 3" : undefined} strokeWidth={STROKE} />
      {peak !== null && <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={radius}
        fill="none"
        stroke={tone}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        // a used-up sliver still shows as a dot rather than vanishing
        strokeDashoffset={circumference * (1 - Math.max(peak ?? 0, 1.5) / 100)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
      />}
    </>
  );
}

export function UsageRings({ children, open = false }: { children: ReactNode; open?: boolean }) {
  const { accounts, stale } = useProviderUsage();
  const { value: xai } = useXaiUsage();
  const list = accounts ?? [];
  const { hidden } = useProfileUsageVisibility();
  const rings = accountRings(list).filter(ring => !hidden.includes(ring.key));
  const SIZE = rings[0]?.size ?? 42;
  const credits = xai?.credits.configured ? xai.credits.credits : null;

  if (rings.length === 0) {
    return (
      <span className={cn("flex size-9 items-center justify-center rounded-full border border-hairline/60 transition-colors", open ? "bg-raised" : "hover:bg-raised/50")}>
        {children}
      </span>
    );
  }

  const summary = rings.map((ring) => `${ring.label} ${ring.peak === null ? "usage unavailable" : `${Math.round(ring.peak)}%`}`).join(", ");
  return (
    <span className="group/usage relative flex shrink-0 items-center justify-center" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="usage-rings">
        {rings.map((ring) => <Ring key={ring.key} radius={ring.radius} color={ring.color} peak={ring.peak} size={SIZE} />)}
      </svg>
      <span className="sr-only">Usage: {summary}</span>
      {children}
      {/* the exact numbers, on hover only and never over the open menu */}
      {!open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-50 mb-2.5 w-[248px] translate-y-1 rounded-2xl border border-hairline/50 bg-menu p-3 text-left opacity-0 shadow-2xl shadow-black/50 transition-[opacity,transform] delay-0 duration-150 group-hover/usage:translate-y-0 group-hover/usage:opacity-100 group-hover/usage:delay-300"
        >
          <span className="mb-2 block text-[12px] font-medium text-ink-secondary">Usage{stale ? " · offline" : ""}</span>
          <span className="flex flex-col gap-2.5">
            {rings.map((ring) => (
              <span key={ring.key} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-[13px] text-ink">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: ring.color }} />
                  <span className="min-w-0 flex-1 truncate">{ring.label}</span>
                </span>
                <span className="pl-4 text-[11.5px] text-ink-secondary">
                  {windowsOf(ring.account).map(window => `${window.label} ${window.usedPercent === null ? "unavailable" : `${Math.round(window.usedPercent)}%`}${window.resetsAt ? ` · resets ${resetLabel(window.resetsAt)}` : ""}`).join(" · ")}
                </span>
              </span>
            ))}
            {credits && (
              <span className="flex items-center gap-2 text-[13px] text-ink">
                <span className="size-2 shrink-0 rounded-full bg-ink-secondary" />
                <span className="min-w-0 flex-1 truncate">xAI</span>
                <span className="tabular-nums">{formatCents(credits.remainingCents)} <span className="text-ink-secondary">left</span></span>
              </span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
