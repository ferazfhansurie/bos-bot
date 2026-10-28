// 3.0: every empty state is the same three things: a bot, one sentence, one
// button. The bot is the selected one (or the first), so the empty screen
// still feels like someone is here.
import type { ReactNode } from "react";
import { BotAvatar } from "../Avatar";
import { cn } from "@/lib/cn";
import { useOptionalStore, type Bot } from "@/state/store";

export function V3Empty({ text, action, bot, size = 56, className, testId }: {
  text: string;
  action?: { label: string; onClick: () => void; icon?: ReactNode };
  bot?: Bot;
  size?: number;
  className?: string;
  testId?: string;
}) {
  const state = useOptionalStore()?.state;
  const mascot = bot ?? state?.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden)
    ?? state?.bots.find((candidate) => !candidate.hidden);
  return (
    <div data-testid={testId ?? "v3-empty"} className={cn("flex flex-col items-center gap-3 px-5 py-7 text-center", className)}>
      {mascot && <BotAvatar bot={mascot} size={size} state="idle" />}
      <p className="max-w-sm text-[13px] text-ink-secondary">{text}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}
