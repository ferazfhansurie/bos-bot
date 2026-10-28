// The v3 Automations home: ask for one in words, start from a template, or
// manage the ones you have as cards. Rendered only when v3 is on; the v3-off
// page keeps the original RoutineList.
import { useState, type KeyboardEvent } from "react";
import { ChartColumn, Eye, Inbox, Loader2, Moon, Plus, Receipt, Send, Sunrise, UserCheck, UserPlus, type LucideIcon } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Routine, RoutineRun } from "@/lib/routines";
import { defaultBotId, useStore, type Bot } from "@/state/store";
import { AutomationCard } from "./AutomationCard";
import { AUTOMATION_TEMPLATES, type AutomationTemplate, type AutomationTemplateIcon } from "./templates";

const TEMPLATE_ICONS: Record<AutomationTemplateIcon, LucideIcon> = {
  sunrise: Sunrise,
  "user-check": UserCheck,
  "bar-chart": ChartColumn,
  inbox: Inbox,
  moon: Moon,
  "user-plus": UserPlus,
  receipt: Receipt,
  eye: Eye,
};

/** What the bot receives when someone asks for an automation in words. The
 * bot answers with its propose_routine card, which the person confirms. */
export function automationRequestText(text: string): string {
  return `set up an automation: ${text.trim()}`;
}

/** The selected bot when it is a visible one, otherwise the default bot. */
export function preferredAutomationBot(bots: readonly Bot[], selectedId: string | null | undefined): string {
  const visible = bots.filter((bot) => !bot.hidden);
  if (selectedId && visible.some((bot) => bot.id === selectedId)) return selectedId;
  return visible.length ? defaultBotId(visible) : "";
}

export function AskAutomation({ bots }: { bots: readonly Bot[] }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  const [botId, setBotId] = useState(() => preferredAutomationBot(bots, state.selectedId));
  const chosen = bots.find((bot) => bot.id === botId) ?? bots.find((bot) => bot.id === preferredAutomationBot(bots, state.selectedId));
  const ready = Boolean(chosen && text.trim());

  const submit = () => {
    if (!chosen || !text.trim()) return;
    dispatch({ type: "send", botId: chosen.id, threadId: chosen.threadId, text: automationRequestText(text), sendId: crypto.randomUUID() });
    dispatch({ type: "select", id: chosen.id });
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return <form
    aria-label="Ask for an automation"
    onSubmit={(event) => { event.preventDefault(); submit(); }}
    className="rounded-xl border border-hairline/40 bg-card p-3"
  >
    <textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      rows={2}
      aria-label="What should happen, and when?"
      placeholder="What should happen, and when? For example: every morning, tell me yesterday's sign-ups"
      className="w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/70"
    />
    <div className="mt-2 flex items-center gap-2">
      {chosen && <BotAvatar bot={chosen} size={24} />}
      <select
        aria-label="Bot"
        value={chosen?.id ?? ""}
        onChange={(event) => setBotId(event.target.value)}
        className="min-w-0 max-w-[14rem] rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
      >
        {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-secondary">{chosen ? `${chosen.name} will set it up and ask you to confirm` : ""}</span>
      <button
        type="submit"
        disabled={!ready}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
      >
        <Send size={13} />Ask
      </button>
    </div>
  </form>;
}

export function AutomationTemplates({ onPick }: { onPick: (template: AutomationTemplate) => void }) {
  return <section aria-label="Templates">
    <h2 className="mb-2 text-[12px] font-semibold text-ink-secondary">Start from a template</h2>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {AUTOMATION_TEMPLATES.map((template) => {
        const Icon = TEMPLATE_ICONS[template.icon];
        return <button
          key={template.id}
          type="button"
          onClick={() => onPick(template)}
          className="flex min-w-0 flex-col items-start gap-1 rounded-xl border border-hairline/40 bg-card p-3 text-left transition-colors hover:bg-raised motion-reduce:transition-none"
        >
          <Icon size={15} className="text-accent" />
          <span className="block w-full truncate text-[12.5px] font-medium text-ink">{template.title}</span>
          <span className="line-clamp-2 text-[11px] leading-snug text-ink-secondary">{template.blurb}</span>
        </button>;
      })}
    </div>
  </section>;
}

export function AutomationsList({ routines, runs, bots, loading, error, onOpen, onTemplate, onNew, ask = true }: {
  routines: readonly Routine[];
  runs: readonly RoutineRun[];
  bots: readonly Bot[];
  loading?: boolean;
  error?: boolean;
  onOpen: (routine: Routine) => void;
  onTemplate?: (template: AutomationTemplate) => void;
  onNew: () => void;
  /** Show the ask box at the top (off inside a single bot's settings). */
  ask?: boolean;
}) {
  const sorted = [...routines].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  const mascot = bots.find((bot) => bot.id === preferredAutomationBot(bots, null)) ?? bots[0];
  return <div className="space-y-5">
    {ask && bots.length > 0 && <AskAutomation bots={bots} />}
    {onTemplate && <AutomationTemplates onPick={onTemplate} />}
    <section aria-label="Your automations" className="space-y-2">
      {(sorted.length > 0 || loading || error) && <h2 className="text-[12px] font-semibold text-ink-secondary">Your automations</h2>}
      {error && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{t("routines.loadError")}</div>}
      {loading && <p role="status" className="flex items-center gap-2 p-3 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />{t("routines.loading")}</p>}
      {!loading && !error && sorted.length === 0 && <div className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed border-hairline/50 px-5 py-7 text-center")}>
        {mascot && <BotAvatar bot={mascot} size={56} state="idle" />}
        <p className="max-w-sm text-[13px] text-ink-secondary">No automations yet. Tell a bot what to do and when, and it runs on its own.</p>
        <button type="button" onClick={onNew} data-v3-nod="automations" className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"><Plus size={13} />New automation</button>
      </div>}
      {sorted.map((routine) => <AutomationCard key={routine.id} routine={routine} runs={runs} bots={bots} onOpen={onOpen} />)}
    </section>
  </div>;
}
