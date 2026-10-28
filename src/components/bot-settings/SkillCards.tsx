// 3.0 skills: "things <bot> knows how to do". The beginner layer over the
// same per-bot skill store SkillsSection manages: one card per skill with a
// plain title, the description's first sentence and an on/off switch; a
// "remember how you did that" button that sends /learn to the current
// thread; a link to the existing import paths; and the whole existing
// SkillsSection folded behind "advanced", unchanged.
//
// Only rendered when the v3 flag is on (SkillsSection branches here).
// The skill listing carries no last-used time, so cards do not show one.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Download, Github, Lightbulb, MonitorPlay, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { skillSubtitle, skillTitle } from "@/lib/skill-titles";
import { api, useStore, type Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { TeachingRecorder } from "./TeachingRecorder";

interface SkillCardSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  warnings: string[];
}

export function SkillCards({ bot, advanced }: { bot: Bot; advanced: ReactNode }) {
  const { state, dispatch } = useStore();
  const authoring = skillAuthoringEnabled(state.config);
  const agentsTools = Boolean(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp,
  );
  const [skills, setSkills] = useState<SkillCardSkill[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ name: string; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`/api/bots/${bot.id}/skills`)
      .then((result: { skills?: SkillCardSkill[]; staged?: unknown[] }) => {
        if (cancelled) return;
        setSkills(result.skills ?? []);
        setWaiting(result.staged?.length ?? 0);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load skills.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, revision]);

  useEffect(() => {
    setReviewing(null);
    setShowRecorder(false);
  }, [bot.id]);

  const skillPath = (name: string) => `/api/bots/${bot.id}/skills/${encodeURIComponent(name)}`;

  const toggle = async (skill: SkillCardSkill) => {
    setWorking(skill.name);
    setError("");
    try {
      if (!skill.enabled) {
        // Same rule as the advanced list: a skill is read before it reaches
        // the bot's prompt, so turning one on shows its text first.
        const result = (await api(skillPath(skill.name))) as { text?: string };
        if (!result.text) throw new Error("This skill's text is unavailable. Remove it and add it again.");
        setReviewing({ name: skill.name, text: result.text });
        return;
      }
      await api(skillPath(skill.name), { method: "PATCH", body: JSON.stringify({ enabled: false }) });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change this skill.");
    } finally {
      setWorking("");
    }
  };

  const turnOnReviewed = async () => {
    if (!reviewing) return;
    setWorking(reviewing.name);
    setError("");
    try {
      await api(skillPath(reviewing.name), { method: "PATCH", body: JSON.stringify({ enabled: true }) });
      setReviewing(null);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not turn this skill on.");
    } finally {
      setWorking("");
    }
  };

  const remember = () => {
    dispatch({ type: "send", botId: bot.id, threadId: bot.threadId, text: "/learn" });
    dispatch({ type: "toggleSettings", open: false });
  };

  const learnBlocked = !authoring
    ? "Learning new skills is turned off in settings."
    : !agentsTools
      ? `${bot.name}'s current model can't save skills. Pick another model to use this.`
      : null;

  const toggleAdvanced = () => {
    // the advanced list edits the same skills; reload the cards after it
    if (showAdvanced) setRevision((value) => value + 1);
    setShowAdvanced((open) => !open);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="skill-cards">
      <section className="rounded-xl border border-hairline bg-panel p-4" aria-labelledby="skill-cards-title">
        <h3 id="skill-cards-title" className="text-[15px] font-medium text-ink">
          Things {bot.name} knows how to do
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
          Each one is a way of working {bot.name} saved or you added. Turn one off and {bot.name} stops using it.
        </p>

        {loading ? (
          <div className="mt-3 text-[12.5px] text-ink-secondary">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="mt-3 rounded-lg bg-raised px-3 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
            Nothing yet. Do a task together in chat, then tap “Remember how you did that” and {bot.name} will save the steps.
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {skills.map((skill) => {
              const subtitle = skillSubtitle(skill.description);
              const open = reviewing?.name === skill.name;
              return (
                <li key={skill.name} className="rounded-lg border border-hairline bg-raised px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink" title={skill.name}>{skillTitle(skill.name)}</div>
                      {subtitle && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{subtitle}</div>}
                      {skill.warnings.length > 0 && (
                        <div className="mt-1 text-[11.5px] text-warning">{skill.warnings.join(" · ")}</div>
                      )}
                    </div>
                    <Switch
                      checked={skill.enabled}
                      aria-label={`${skill.enabled ? "Turn off" : "Turn on"} ${skillTitle(skill.name)}`}
                      disabled={working === skill.name || open}
                      onClick={() => void toggle(skill)}
                    />
                  </div>
                  {open && (
                    <div className="mt-2">
                      <div className="text-[12.5px] text-ink-secondary">Read what {bot.name} will follow, then turn it on.</div>
                      <pre
                        tabIndex={0}
                        aria-label={`Full text of ${skillTitle(skill.name)}`}
                        className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 font-mono text-[12px] leading-relaxed text-ink"
                      >
                        {reviewing.text}
                      </pre>
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={working === skill.name}
                          onClick={() => setReviewing(null)}
                          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-panel disabled:opacity-40"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={working === skill.name}
                          onClick={() => void turnOnReviewed()}
                          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                        >
                          Turn on
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {waiting > 0 && (
          <div className="mt-2 text-[12px] text-ink-secondary">
            {waiting} new {waiting === 1 ? "skill is" : "skills are"} waiting for your answer in chat.
          </div>
        )}
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={learnBlocked !== null}
            title={learnBlocked ?? `${bot.name} saves the steps from this chat as a new skill. You review it before it's used.`}
            onClick={remember}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
          >
            <Lightbulb size={14} aria-hidden /> Remember how you did that
          </button>
          {authoring && (
            <button
              type="button"
              aria-expanded={showRecorder}
              onClick={() => setShowRecorder((value) => !value)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-raised px-3 py-2 text-[13px] text-ink"
            >
              <MonitorPlay size={14} aria-hidden /> Show {bot.name} on screen
            </button>
          )}
        </div>
        {learnBlocked && <div className="mt-1.5 text-[12px] text-ink-secondary">{learnBlocked}</div>}
        {showRecorder && authoring && (
          <div className="mt-3">
            <TeachingRecorder key={bot.id} bot={bot} />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-hairline bg-panel p-4" aria-labelledby="skill-library-title">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-ink-secondary" aria-hidden />
          <h3 id="skill-library-title" className="text-[15px] font-medium text-ink">Get more skills</h3>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "toggleSettings", open: false });
              dispatch({ type: "toggleAppSettings", open: true, section: "import" });
            }}
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-ink hover:bg-raised"
          >
            <Download size={14} className="shrink-0 text-ink-secondary" aria-hidden />
            <span className="flex-1">Bring skills from Claude Code, Codex or Cursor</span>
            <ChevronRight size={14} className="text-ink-secondary" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-ink hover:bg-raised"
          >
            <Github size={14} className="shrink-0 text-ink-secondary" aria-hidden />
            <span className="flex-1">Add one from GitHub</span>
            <ChevronRight size={14} className="text-ink-secondary" aria-hidden />
          </button>
        </div>
      </section>

      <div>
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={toggleAdvanced}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={cn("motion-safe:transition-transform", showAdvanced && "rotate-90")}
          />
          Advanced
        </button>
        {showAdvanced && <div className="mt-2">{advanced}</div>}
      </div>
    </div>
  );
}
