// 3.0 "ask instead": a bot asked in chat to change a setting ("make cash use
// haiku") posts this card instead of changing anything. One tap applies it
// through the same bot PATCH the settings page uses; once applied it offers
// Undo, which puts the previous value back only if nobody changed it since.
//
// Rendered only behind the v3 flag (ApprovalCard branches here); with v3 off
// the card falls through to the ordinary approval card as a settled record.
import { useState } from "react";
import { ArrowRight, Check, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import type { SettingChangeAction } from "../../shared/setting-change";
import { cn } from "@/lib/cn";

export function SettingChangeCard({ bot, message }: { bot?: Bot; message: Message }) {
  const { state, flushBotPatches } = useStore();
  const [busy, setBusy] = useState<SettingChangeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = message.card?.settingChange;
  if (!change) return null;

  const target = state.bots.find((candidate) => candidate.id === change.targetBotId);
  const status = change.undoneAt ? "undone" : change.appliedAt ? "applied" : change.declinedAt ? "declined" : "open";
  // A paired remote bot's settings belong to its own computer.
  const unavailable = !target ? "this bot no longer exists" : target.remote ? "change this on the computer that runs this bot" : null;

  const run = async (action: SettingChangeAction) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      // a debounced edit from the settings page must land first, or the
      // server would compare the card against a value about to change
      if (action !== "decline") await flushBotPatches(change.targetBotId);
      await api(`/api/bots/${change.targetBotId}`, {
        method: "PATCH",
        body: JSON.stringify({ settingChange: { threadId: change.threadId, requestId: change.requestId, action } }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const settled = status === "undone" || status === "declined";
  return (
    <div
      className={cn(
        "w-full max-w-[560px] rounded-2xl border bg-panel p-4",
        settled ? "border-hairline opacity-70" : "border-hairline",
      )}
      data-testid="setting-change-card"
    >
      <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
        <SlidersHorizontal size={14} aria-hidden />
        <span>
          {bot && bot.id !== change.targetBotId ? `${bot.name} suggests a change for ${change.targetName}` : "setting change"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink">
        <span className="font-semibold">{change.targetName}:</span>
        <span className="text-ink-secondary">{change.settingLabel}</span>
        <span className={cn(status === "applied" && "text-ink-secondary line-through")}>{change.beforeLabel}</span>
        <ArrowRight size={14} className="text-ink-secondary" aria-label="to" />
        <span className={cn("font-medium", status === "undone" && "text-ink-secondary line-through")}>{change.afterLabel}</span>
      </div>

      {change.reason && <p className="mt-1.5 text-[13px] text-ink-secondary">{change.reason}</p>}

      {error && (
        <div role="alert" className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {error}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
        {status === "open" && (
          <>
            <button
              type="button"
              disabled={busy !== null || unavailable !== null}
              title={unavailable ?? undefined}
              onClick={() => void run("apply")}
              data-v3-nod="setting-change"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50 motion-safe:transition-opacity"
            >
              <Check size={14} aria-hidden /> {busy === "apply" ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("decline")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-raised px-3 py-1.5 text-ink disabled:opacity-50 motion-safe:transition-opacity"
            >
              Not now
            </button>
            {unavailable && <span className="text-ink-secondary">{unavailable}</span>}
          </>
        )}
        {status === "applied" && (
          <>
            <span className="inline-flex items-center gap-1.5 text-ink-secondary">
              <Check size={14} className="text-success" aria-hidden /> applied
            </span>
            <button
              type="button"
              disabled={busy !== null || unavailable !== null}
              title={unavailable ?? undefined}
              onClick={() => void run("undo")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-raised px-3 py-1.5 text-ink disabled:opacity-50 motion-safe:transition-opacity"
            >
              <RotateCcw size={14} aria-hidden /> {busy === "undo" ? "Undoing…" : "Undo"}
            </button>
          </>
        )}
        {status === "undone" && (
          <span className="inline-flex items-center gap-1.5 text-ink-secondary">
            <RotateCcw size={14} aria-hidden /> undone, back to {change.beforeLabel}
          </span>
        )}
        {status === "declined" && (
          <span className="inline-flex items-center gap-1.5 text-ink-secondary">
            <X size={14} aria-hidden /> not changed
          </span>
        )}
      </div>
    </div>
  );
}
