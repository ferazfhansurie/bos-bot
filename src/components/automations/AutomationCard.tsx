// One automation as a card (v3 only): who runs it, what it does, when, how the
// last run went, and an on/off switch. The switch uses the same PATCH the
// calendar's pause/resume button uses, so both views stay in step.
import { useState } from "react";
import { BotAvatar } from "@/components/Avatar";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { Routine, RoutineRun } from "@/lib/routines";
import { latestRoutineRun, routineDateTime, routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { api, useStore, type Bot } from "@/state/store";
import { plainSchedule } from "./plain-schedule";

export function AutomationCard({ routine, runs, bots, onOpen }: {
  routine: Routine;
  runs: readonly RoutineRun[];
  bots: readonly Bot[];
  onOpen: (routine: Routine) => void;
}) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bot = bots.find((candidate) => candidate.id === routine.botId);
  const latest = latestRoutineRun(routine.id, runs);
  const finished = routine.schedule.type === "once" && routine.nextRunAt == null && routine.schedule.at <= Date.now();

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !routine.enabled }) });
      if (response?.routine) dispatch({ type: "routinePatched", routine: response.routine });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <article aria-label={routine.name} className={cn("flex items-start gap-3 rounded-xl border border-hairline/40 bg-card p-3.5", !routine.enabled && "opacity-70")}>
    <button type="button" onClick={() => onOpen(routine)} className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-lg">
      {bot
        ? <BotAvatar bot={bot} size={40} state={routine.enabled ? "idle" : "sleeping"} />
        : <span className="size-10 shrink-0 rounded-full bg-inset" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{routine.name}</span>
        <span className="mt-0.5 block text-[12px] text-ink-secondary">
          {plainSchedule(routine.schedule)}{bot && <> · {bot.name}</>}
        </span>
        {routine.prompt.trim() && <span className="mt-1.5 line-clamp-2 block text-[12px] leading-relaxed text-ink-secondary">{routine.prompt.trim()}</span>}
        <span className="mt-1.5 block text-[11.5px]">
          {latest
            ? <><span className={routineRunTone(latest)}>Last run: {routineRunLabel(latest).toLowerCase()}</span><span className="text-ink-secondary"> · {routineDateTime(latest.finishedAt ?? latest.startedAt ?? latest.scheduledFor)}</span></>
            : <span className="text-ink-secondary">Not run yet</span>}
        </span>
        {error && <span role="alert" className="mt-1 block text-[11.5px] text-danger">{error}</span>}
      </span>
    </button>
    <Switch
      checked={routine.enabled && !finished}
      disabled={busy || finished}
      onClick={() => void toggle()}
      aria-label={routine.enabled ? `Pause ${routine.name}` : `Turn on ${routine.name}`}
      className="mt-1"
    />
  </article>;
}
