"use client";

// Renders a ```stats block from the bot: the headline numbers of an answer as
// cards. {"items":[{"label","value","unit":"rm"|"pct"|"count","change","good","note"}]}
// change is a % vs the previous period; good says which direction is healthy
// ("up" for money in, "down" for spend), so the colour reads right.

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { formatCurrency } from "./rich-chart";

export interface StatItem {
  label: string;
  value: number;
  unit: "rm" | "pct" | "count";
  change?: number;
  good: "up" | "down";
  note?: string;
}

export function parseStats(source: string): StatItem[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return null;
  const items = list.flatMap((entry): StatItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const value = Number(e.value);
    if (typeof e.label !== "string" || !Number.isFinite(value)) return [];
    const change = Number(e.change);
    return [{
      label: e.label,
      value,
      unit: e.unit === "pct" || e.unit === "count" ? e.unit : "rm",
      change: e.change !== undefined && Number.isFinite(change) ? change : undefined,
      good: e.good === "down" ? "down" : "up",
      note: typeof e.note === "string" ? e.note : undefined,
    }];
  });
  return items.length ? items.slice(0, 6) : null;
}

function format(item: StatItem): string {
  if (item.unit === "pct") return `${item.value.toFixed(1)}%`;
  if (item.unit === "count") return item.value.toLocaleString("en-MY");
  return formatCurrency(item.value);
}

export function StatCards({ items }: { items: StatItem[] }) {
  const cols = items.length === 1 ? "" : items.length === 2 || items.length === 4 ? "sm:grid-cols-2" : "sm:grid-cols-3";
  return (
    <div className={`my-3 grid grid-cols-1 gap-2 ${cols}`}>
      {items.map((item) => {
        const up = (item.change ?? 0) >= 0;
        const healthy = item.change === undefined || item.change === 0 ? null : up === (item.good === "up");
        return (
          <div key={item.label} className="rounded-2xl border border-hairline bg-panel px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-tertiary">{item.label}</div>
            <div className="mt-1 text-lg font-semibold tracking-tight text-ink tabular-nums">{format(item)}</div>
            {(item.change !== undefined || item.note) && (
              <div className="mt-1 flex items-center gap-1.5 text-xs">
                {item.change !== undefined && (
                  <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${
                    healthy === null ? "text-ink-secondary" : healthy ? "text-emerald-600" : "text-rose-600"
                  }`}>
                    {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                    {Math.abs(item.change).toFixed(1)}%
                  </span>
                )}
                {item.note && <span className="truncate text-ink-tertiary">{item.note}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
