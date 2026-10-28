// 3.0 bot settings open on a profile, not a list of thirteen folds: who the
// bot is, the three switches people flip most, where it works, which model,
// its apps and its library. Every row deep-links into the existing section,
// and "All settings" shows the old grouped accordion unchanged, so nothing
// that was reachable before stops being reachable.
//
// Only rendered when the v3 flag is on (BotSettingsDialog branches here).
import { useEffect, useState, type ReactNode } from "react";
import { Bell, BellOff, BookOpen, Brain, ChevronRight, Clock, Cpu, Pin, PinOff, Plug, Plus, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import type { BotOverview } from "@/lib/bot-overview-types";
import { requestNotificationPermission } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { v3Enabled } from "@/lib/v3";
import { showUndo } from "@/lib/v3-undo";
import { BotAvatar } from "../Avatar";
import { effortLabel, modelLabel } from "../ModelPicker";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { plainSchedule } from "../automations/plain-schedule";
import { WorksOnPicker } from "./WorksOnPicker";
import type { BOT_SECTIONS } from "./sections";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

type SectionId = (typeof BOT_SECTIONS)[number]["id"];

function QuickToggle({ on, label, onIcon, offIcon, onClick }: {
  on: boolean;
  label: string;
  onIcon: ReactNode;
  offIcon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[12px] transition-colors motion-reduce:transition-none",
        on ? "bg-control text-ink" : "bg-card text-ink-secondary hover:text-ink",
      )}
    >
      {on ? onIcon : offIcon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Row({ icon, label, value, onClick, testId }: {
  icon: ReactNode;
  label: string;
  value?: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-control/60"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary">{icon}</span>
      <span className="shrink-0 text-[14px] text-ink">{label}</span>
      <span className="min-w-0 flex-1 truncate text-end text-[13px] text-ink-secondary">{value}</span>
      <ChevronRight size={15} className="shrink-0 text-ink-secondary" />
    </button>
  );
}

export function BotProfileSheet({ bot, derived, overview, onSection, onAllSettings }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  overview: BotOverview | null;
  onSection: (id: SectionId) => void;
  onAllSettings: () => void;
}) {
  const { state, dispatch } = useStore();
  const [skillNames, setSkillNames] = useState<string[] | null>(null);
  const [localAutoWarning, setLocalAutoWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSkillNames(null);
    api(`/api/bots/${bot.id}/skills`)
      .then((result: { skills?: { name: string; enabled: boolean }[] }) => {
        if (!cancelled) setSkillNames((result.skills ?? []).filter((skill) => skill.enabled).map((skill) => skill.name));
      })
      .catch(() => {
        if (!cancelled) setSkillNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const instance = state.instances.find((entry) => entry.instanceId === bot.modelSelection.instanceId);
  const model = modelLabel(instance, bot.modelSelection.model);
  const effort = bot.modelSelection.effort ? effortLabel(bot.modelSelection.effort) : null;
  const boxComputeSelectable = state.config?.boxCompute?.configured === true;
  const apps = overview?.connections?.services ?? [];
  const routines = derived.botRoutines;
  const doing = bot.busy
    ? bot.activity === "waiting-on-you" ? "Waiting on you" : "Working now"
    : bot.description;

  const openApps = () => {
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-6" data-testid="bot-profile-sheet">
      <div className="flex flex-col items-center gap-2 pb-1 pt-2 text-center">
        <BotAvatar bot={bot} size={76} />
        <div className="min-w-0 max-w-full">
          <div className="truncate text-[18px] font-semibold text-ink">{bot.name}</div>
          {bot.title && <div className="truncate text-[13px] text-ink-secondary">{bot.title}</div>}
          {doing && <div className="mt-1 line-clamp-2 text-[12.5px] text-ink-secondary">{doing}</div>}
        </div>
        <button
          type="button"
          onClick={() => onSection("identity")}
          className="rounded-full bg-control px-3 py-1 text-[12.5px] text-ink hover:bg-control/80"
        >
          Edit profile
        </button>
      </div>

      <div className="flex gap-2">
        <QuickToggle
          on={bot.notifications}
          label={bot.notifications ? "Notifications" : "Muted"}
          onIcon={<Bell size={16} />}
          offIcon={<BellOff size={16} />}
          onClick={() => {
            const enabled = !bot.notifications;
            if (enabled) void requestNotificationPermission();
            derived.patch({ notifications: enabled });
            if (v3Enabled()) showUndo(t(enabled ? "v3.undo.unmuted" : "v3.undo.muted", { name: bot.name }), { undo: () => derived.patch({ notifications: !enabled }) });
          }}
        />
        <QuickToggle
          on={Boolean(bot.pinned)}
          label={bot.pinned ? "Pinned" : "Pin"}
          onIcon={<Pin size={16} />}
          offIcon={<PinOff size={16} />}
          onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } })}
        />
        <QuickToggle
          on={Boolean(bot.speakReplies)}
          label="Speak replies"
          onIcon={<Volume2 size={16} />}
          offIcon={<VolumeX size={16} />}
          onClick={() => derived.patch({ speakReplies: !bot.speakReplies })}
        />
      </div>

      <div className="rounded-xl bg-card px-4 py-2">
        <WorksOnPicker
          bot={bot}
          flat
          notSetUp={(mode) => mode === "boxcompute" && !boxComputeSelectable && bot.computer !== "boxcompute"}
          disabledReason={(mode) =>
            mode === "local" && !derived.localSelectable ? derived.localDisabledReason ?? "Not available here"
              : mode === "browser" && !derived.browserSelectable ? derived.browserDisabledReason
                : undefined}
          onChoose={(mode) => {
            if (mode === "local" && derived.approvalMode === "auto") setLocalAutoWarning(true);
            else if (mode === "browser") derived.patch({ computer: mode, browser: true });
            else derived.patch({ computer: mode });
          }}
          onAddComputer={() => {
            dispatch({ type: "toggleSettings", open: false });
            dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
          }}
        />
      </div>

      <div className="rounded-xl bg-card px-2 py-1">
        <Row
          icon={<Cpu size={15} />}
          label="Model"
          value={effort ? `${model} · ${effort}` : model}
          onClick={() => onSection("model")}
          testId="profile-model"
        />
      </div>

      <div className="rounded-xl bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Plug size={15} className="shrink-0 text-ink-secondary" />
          <span className="flex-1 text-[14px] text-ink">Apps</span>
          <button type="button" onClick={openApps} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
            <Plus size={13} /> Connect
          </button>
        </div>
        {apps.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {apps.slice(0, 8).map((app) => (
              <span key={app} className="rounded-full bg-control px-2.5 py-0.5 text-[12px] text-ink">{app}</span>
            ))}
            {apps.length > 8 && <span className="px-1 py-0.5 text-[12px] text-ink-secondary">+{apps.length - 8}</span>}
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-ink-secondary">
            {overview ? "None yet. Connect Gmail, Calendar or Slack so it can work in them." : "Loading…"}
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card px-2 py-1">
        <Row
          icon={<Clock size={15} />}
          label="Automations"
          value={routines.length === 0 ? "None yet" : routines.length === 1 ? `${routines[0].name} · ${plainSchedule(routines[0].schedule)}` : `${routines.length}, ${derived.activeBotRoutines} on`}
          onClick={() => onSection("routines")}
          testId="profile-automations"
        />
        <Row
          icon={<BookOpen size={15} />}
          label="Skills"
          value={skillNames === null ? "" : skillNames.length === 0 ? "None yet" : `${skillNames.length} on`}
          onClick={() => onSection("skills")}
          testId="profile-skills"
        />
        <Row
          icon={<Brain size={15} />}
          label="Memory"
          value="What it remembers"
          onClick={() => onSection("memory")}
          testId="profile-memory"
        />
      </div>

      <button
        type="button"
        onClick={onAllSettings}
        data-testid="profile-all-settings"
        className="mt-1 flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13.5px] text-ink-secondary hover:bg-control/60 hover:text-ink"
      >
        <SlidersHorizontal size={15} /> All settings
      </button>

      <LocalComputerAutoWarning
        open={localAutoWarning}
        onCancel={() => setLocalAutoWarning(false)}
        onConfirm={() => {
          setLocalAutoWarning(false);
          dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        }}
      />
    </div>
  );
}
