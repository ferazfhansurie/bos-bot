// 3.0's "works on": one row that says where the bot works, opening into a list
// of real choices with one plain line each. It replaces the seven-way
// segmented bar whose labels wrapped (Firaz's screenshot). Choosing still goes
// through AccessSection's own handler, so the local-auto warning and the
// browser-switch pairing behave exactly as they did on the bar.
import { useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { BoxComputeMark } from "../BoxComputeMark";

export type WorksOnMode = Exclude<Bot["computer"], undefined> | null;

export const WORKS_ON_CHOICES: ReadonlyArray<{ mode: WorksOnMode; label: string; line: string }> = [
  { mode: null, label: "Auto", line: "Picks a computer for each task." },
  { mode: "local", label: "This computer", line: "Uses your files and apps here." },
  { mode: "boxcompute", label: "BoxCompute", line: "Always on, even when your computer sleeps." },
  { mode: "cloud", label: "Cloud", line: "A cloud computer or your own VPS." },
  { mode: "vm", label: "Local VM", line: "A separate desktop on this computer, away from your files." },
  { mode: "browser", label: "Browser only", line: "The built-in browser tab, no desktop." },
  { mode: "off", label: "Off", line: "No computer and no browser. Apps and chat still work." },
];

export function worksOnLabel(bot: Pick<Bot, "computer" | "sharedWorkComputer">): string {
  if (bot.sharedWorkComputer) return bot.sharedWorkComputer.name;
  return WORKS_ON_CHOICES.find((choice) => choice.mode === (bot.computer ?? null))?.label ?? "Auto";
}

export function WorksOnPicker({
  bot,
  disabledReason,
  notSetUp,
  onChoose,
  onAddComputer,
  defaultOpen = false,
  flat = false,
}: {
  bot: Bot;
  /** why a choice can't be picked right now; undefined = pickable */
  disabledReason: (mode: WorksOnMode) => string | undefined;
  /** choices that need setup first; shown once, as "add a computer" */
  notSetUp: (mode: WorksOnMode) => boolean;
  onChoose: (mode: WorksOnMode) => void;
  onAddComputer?: () => void;
  defaultOpen?: boolean;
  /** inside a card already: no fill of its own, no side padding */
  flat?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const current = bot.computer ?? null;
  const locked = Boolean(bot.sharedWorkComputer);
  const shown = WORKS_ON_CHOICES.filter((choice) => !notSetUp(choice.mode));
  const hidden = WORKS_ON_CHOICES.length - shown.length;
  return (
    <div className={cn("rounded-xl", !flat && "bg-card")} data-testid="works-on">
      <button
        type="button"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen(!open)}
        className={cn("flex w-full items-center gap-2 rounded-xl text-start disabled:cursor-default", flat ? "py-1" : "px-4 py-3")}
      >
        <span className="text-[14px] text-ink-secondary">Works on</span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{worksOnLabel(bot)}</span>
        {!locked && <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />}
      </button>
      {open && !locked && (
        <div role="radiogroup" aria-label="Works on" className={cn("flex flex-col gap-0.5", flat ? "mt-2" : "px-2 pb-2")}>
          {shown.map(({ mode, label, line }) => {
            const reason = disabledReason(mode);
            const selected = mode === current;
            return (
              <button
                key={mode ?? "auto"}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={Boolean(reason)}
                title={reason}
                onClick={() => { if (!selected) onChoose(mode); }}
                className={cn(
                  "flex items-start gap-3 rounded-lg px-2.5 py-2 text-start",
                  selected ? "bg-control" : "hover:bg-control/60",
                  reason && "cursor-not-allowed opacity-45",
                )}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink">
                  {selected ? <Check size={15} /> : mode === "boxcompute" ? <BoxComputeMark size={13} aria-hidden="true" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-ink">{label}</span>
                  <span className="block text-[12px] leading-snug text-ink-secondary">{reason ?? line}</span>
                </span>
              </button>
            );
          })}
          {hidden > 0 && onAddComputer && (
            <button type="button" onClick={onAddComputer} className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-control/60">
              <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary"><Plus size={15} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink">Add a computer</span>
                <span className="block text-[12px] leading-snug text-ink-secondary">BoxCompute keeps a bot working while your computer sleeps.</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
