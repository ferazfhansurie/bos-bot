import { type ChartSpec, formatCurrency } from "./rich-chart";

const COLORS = ["#E31E27", "#64748b", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#f472b6", "#94a3b8", "#cbd5e1", "#e2e8f0"];
const compact = (n: number) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));

/** The dashboard's chart contract, rendered locally with no scripts or remote embeds. */
export function RichChart({ spec }: { spec: ChartSpec }) {
  const key = spec.series[0]!.key;
  const rows = spec.type === "donut" || spec.type === "hbar"
    ? [...spec.data].sort((a, b) => Number(b[key]) - Number(a[key])) : spec.data;
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row[key]) || 0), 0);
  const values = rows.flatMap(row => spec.series.map(s => Number(row[s.key]) || 0));
  const min = Math.min(0, ...values), max = Math.max(1, ...values);
  const y = (n: number) => 210 - (n - min) / (max - min) * 180;
  const x = (i: number) => 54 + (i + 0.5) * 530 / rows.length;
  let offset = 0;
  return <figure dir="ltr" className="my-3 min-w-0 rounded-2xl border border-hairline bg-panel p-4" aria-label={spec.title || "Chart"}>
    {spec.title && <figcaption className="text-[13px] font-semibold text-ink">{spec.title}</figcaption>}
    {spec.type === "donut" ? <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative mx-auto h-44 w-44 shrink-0">
        <svg viewBox="0 0 200 200" role="img" aria-label={spec.title} className="h-full w-full">
          {rows.filter(row => Number(row[key]) > 0).map((row, i) => {
            const fraction = Number(row[key]) / total, start = offset;
            offset += fraction;
            return <circle key={i} cx="100" cy="100" r="76" fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="32" pathLength="1" strokeDasharray={`${fraction} ${1 - fraction}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"><title>{String(row[spec.xKey])}: {formatCurrency(Number(row[key]))}</title></circle>;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[10px] text-ink-tertiary">{spec.series[0]!.label}</span><span className="text-sm font-semibold tabular-nums">RM {compact(total)}</span></div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">{rows.filter(row => Number(row[key]) > 0).map((row, i) => <div key={i} className="flex items-center gap-2 text-xs"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: COLORS[i % COLORS.length] }}/><span className="min-w-0 flex-1 break-words">{String(row[spec.xKey])}</span><span className="shrink-0 tabular-nums">{formatCurrency(Number(row[key]))}</span><span className="w-11 shrink-0 text-right tabular-nums text-ink-secondary">{(Number(row[key]) / total * 100).toFixed(1)}%</span></div>)}</div>
    </div> : spec.type === "hbar" ? <div className="mt-4 space-y-3">{rows.map((row, i) => <div key={i}><div className="mb-1 flex justify-between gap-3 text-xs"><span>{String(row[spec.xKey])}</span><span className="tabular-nums">{formatCurrency(Number(row[key]))}</span></div><div className="h-3 rounded bg-inset"><div className="h-full rounded" style={{width: `${Math.max(0, Number(row[key])) / max * 100}%`, background: COLORS[0]}}/></div></div>)}</div> : <>
      <svg viewBox="0 0 610 250" role="img" aria-label={spec.title} className="mt-3 w-full text-ink-secondary">
        {[0, 0.5, 1].map(t => <g key={t}><line x1="50" x2="590" y1={y(min + t * (max - min))} y2={y(min + t * (max - min))} stroke="currentColor" opacity=".15"/><text x="44" y={y(min + t * (max - min)) + 4} textAnchor="end" fontSize="10" fill="currentColor">{compact(min + t * (max - min))}</text></g>)}
        {spec.series.map((s, si) => {
          const points = rows.map((row, i) => `${x(i)},${y(Number(row[s.key]) || 0)}`).join(" ");
          const color = COLORS[si % COLORS.length];
          if (spec.type === "bar") return <g key={s.key}>{rows.map((row, i) => { const v = Number(row[s.key]) || 0, width = Math.min(28, 480 / rows.length / spec.series.length); return <rect key={i} x={x(i) + (si - spec.series.length / 2) * width} y={Math.min(y(v), y(0))} width={width - 2} height={Math.abs(y(v) - y(0))} rx="3" fill={color}><title>{String(row[spec.xKey])}, {s.label}: {formatCurrency(v)}</title></rect>; })}</g>;
          return <g key={s.key}>{spec.type === "area" && <polygon points={`${x(0)},${y(0)} ${points} ${x(rows.length - 1)},${y(0)}`} fill={color} opacity=".12"/>}<polyline points={points} fill="none" stroke={color} strokeWidth="2.2"/>{rows.map((row, i) => <circle key={i} cx={x(i)} cy={y(Number(row[s.key]) || 0)} r="3" fill={color}><title>{String(row[spec.xKey])}, {s.label}: {formatCurrency(Number(row[s.key]) || 0)}</title></circle>)}</g>;
        })}
        {rows.map((row, i) => i % Math.max(1, Math.ceil(rows.length / 8)) === 0 && <text key={i} x={x(i)} y="238" textAnchor="middle" fontSize="10" fill="currentColor">{String(row[spec.xKey]).slice(0, 14)}</text>)}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-ink-secondary">{spec.series.map((s, i) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{background: COLORS[i % COLORS.length]}}/>{s.label}</span>)}</div>
    </>}
  </figure>;
}
