export const formatCurrency = (value: number) => `RM ${value.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export interface ChartSpec {
  type: "bar" | "line" | "area" | "hbar" | "donut";
  title: string;
  xKey: string;
  series: { key: string; label: string }[];
  data: Record<string, string | number>[];
}

// A-List red first, then the dashboard's chart palette (components/charts.tsx)
// donut slices: the same family, then quieter greys for the long tail
const TYPES = new Set(["bar", "line", "area", "hbar", "donut"]);

export function parseChartSpec(source: string): ChartSpec | null {
  if (source.length > 250_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const spec = raw as Record<string, unknown>;
  if (typeof spec.type !== "string" || !TYPES.has(spec.type)) return null;
  if (typeof spec.xKey !== "string" || !Array.isArray(spec.series) || !Array.isArray(spec.data)) return null;
  if (spec.series.length > 6 || spec.data.length > 200) return null;
  const series = spec.series.filter(
    (s): s is { key: string; label: string } =>
      !!s && typeof s === "object" && typeof (s as { key?: unknown }).key === "string",
  ).map((s) => ({ key: s.key, label: typeof s.label === "string" ? s.label : s.key }));
  const data = spec.data.filter((row): row is Record<string, string | number> => !!row && typeof row === "object");
  if (!series.length || !data.length) return null;
  if (data.some(row => (typeof row[spec.xKey as string] !== "string" && typeof row[spec.xKey as string] !== "number") ||
    series.some(s => typeof row[s.key] !== "number" || !Number.isFinite(row[s.key])))) return null;
  return {
    type: spec.type as ChartSpec["type"],
    title: typeof spec.title === "string" ? spec.title : "",
    xKey: spec.xKey,
    series,
    data,
  };
}

