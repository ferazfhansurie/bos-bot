// Small controls the editor shares, in the workbench's own vocabulary:
// quiet ink-tinted surfaces, rounded, 12-13px type, accent only for state.
import type { ComponentType, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";

type Icon = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>;

/** Toolbar icon button. It never takes focus on click, so space and the
 * editor's shortcuts keep working after pressing it. */
export function IconButton({ icon: Glyph, label, onClick, active, disabled, size = 16, className, children, shortcut }: {
  icon: Icon; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; size?: number; className?: string; children?: ReactNode; shortcut?: string;
}) {
  return (
    <button type="button" aria-label={label} title={shortcut ? `${label} (${shortcut})` : label} disabled={disabled} aria-pressed={active}
      onMouseDown={e => e.preventDefault()} onClick={onClick}
      className={cn("inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink/70 transition-colors duration-100 hover:bg-ink/[.078] hover:text-ink disabled:pointer-events-none disabled:opacity-35",
        active && "bg-ink/[.1] text-ink", className)}>
      <Glyph size={size} strokeWidth={1.75} />{children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T | undefined; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-ink/[.04] p-0.5">
      {options.map(o => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.title}
          onClick={() => onChange(o.value)}
          className={cn("flex h-6 min-w-0 flex-1 items-center justify-center rounded-md px-1.5 text-[11.5px] text-ink/65 transition-colors hover:text-ink",
            o.value === value && "bg-ink/[.1] text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[11.5px] text-ink-secondary"><span>{label}</span>{hint && <span className="tabular-nums">{hint}</span>}</div>
      {children}
    </div>
  );
}

/** A range input styled like the app's sliders (see videos.css). */
export function Slider({ value, min, max, step, onChange, label, onCommit }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; onCommit?: () => void;
}) {
  const fraction = (value - min) / (max - min);
  return <input type="range" className="video-range" aria-label={label} min={min} max={max} step={step} value={value}
    style={{ ["--fill" as string]: `${Math.max(0, Math.min(1, fraction)) * 100}%` }}
    onChange={e => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />;
}

/** Seconds field that commits on blur/enter; shows two decimals. */
export function SecondsInput({ value, onCommit, label, min = 0 }: { value: number; onCommit: (v: number) => void; label: string; min?: number }) {
  return (
    <label className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md bg-ink/[.04] px-2 text-[11.5px] text-ink-secondary focus-within:ring-1 focus-within:ring-ink/20">
      <span className="shrink-0">{label}</span>
      <input key={value.toFixed(3)} defaultValue={value.toFixed(2)} inputMode="decimal" aria-label={label}
        className="w-full min-w-0 bg-transparent text-right text-[12px] tabular-nums text-ink outline-none"
        onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= min && Math.abs(v - value) > 0.0005) onCommit(v); else e.target.value = value.toFixed(2); }}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = value.toFixed(2); e.currentTarget.blur(); } }} />
      <span className="shrink-0">s</span>
    </label>
  );
}

export function Swatches({ value, colors, onChange, label, allowNone }: { value: string | undefined; colors: string[]; onChange: (c: string) => void; label: string; allowNone?: boolean }) {
  const current = (value ?? "").toLowerCase();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {allowNone && (
        <button type="button" role="radio" aria-checked={current === ""} title="None" onClick={() => onChange("")}
          className={cn("relative size-6 overflow-hidden rounded-full bg-ink/[.06] ring-offset-2 ring-offset-panel", current === "" && "ring-2 ring-accent")}>
          <span className="absolute left-1/2 top-1/2 h-[1.5px] w-7 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-ink/45" />
        </button>
      )}
      {colors.map(c => (
        <button key={c} type="button" role="radio" aria-checked={current === c.toLowerCase()} title={c} onClick={() => onChange(c)}
          className={cn("size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)] ring-offset-2 ring-offset-panel", current === c.toLowerCase() && "ring-2 ring-accent")}
          style={{ background: c }} />
      ))}
      <label title="Custom colour" className="relative flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-ink/[.06] text-ink/60 hover:bg-ink/[.1]">
        <Plus size={13} strokeWidth={2} />
        <input type="color" aria-label={`${label}: custom`} value={/^#[0-9a-f]{6}/i.test(current) ? current.slice(0, 7) : "#ffffff"}
          onChange={e => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  );
}

/** A small box with the frame's proportions, for format choices. */
export function AspectGlyph({ width, height, size = 16, className }: { width: number; height: number; size?: number; className?: string }) {
  const scale = size / Math.max(width, height);
  return <span className={cn("inline-block shrink-0 rounded-[3px] border-[1.5px] border-current", className)} style={{ width: Math.max(6, width * scale), height: Math.max(6, height * scale) }} />;
}

export function aspectName(width: number, height: number): string {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(width, height);
  const known: Record<string, string> = { "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:5": "4:5" };
  const ratio = `${width / d}:${height / d}`;
  return known[ratio] ?? ratio;
}

/** Live size of an element (content box), for layout breakpoints and fitting. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The element can appear after mount (a loading screen renders first), so re-check on every
  // render and follow whatever the ref points at now instead of observing only the first one.
  const observed = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      setSize(s => (Math.abs(s.width - box.width) < 0.5 && Math.abs(s.height - box.height) < 0.5 ? s : { width: box.width, height: box.height }));
    });
    ro.observe(el);
    observed.current = { el, ro };
  });
  useEffect(() => () => { observed.current?.ro.disconnect(); observed.current = null; }, []);
  return size;
}
