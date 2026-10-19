import { useEffect, useState } from "react";
import { ArrowUp, Loader2, Mic, RotateCcw, X } from "lucide-react";
import { Waveform } from "./voice-call/Waveform";
import { t } from "@/lib/i18n";
import { formatElapsed } from "@/lib/voice-recorder";
import type { PendingVoice } from "@/lib/voice-send";

/** The browser voice-message bar: cancel, a live level from the recording's
 * own stream, elapsed time, send. Same footprint as native dictation. */
export function ComposerVoiceRecorder({ stream, startedAt, starting, onCancel, onSend }: {
  stream: MediaStream | null;
  startedAt: number;
  starting: boolean;
  onCancel(): void;
  onSend(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const elapsed = starting ? 0 : now - startedAt;
  return <div className="composer-voice flex min-w-0 items-center gap-2" role="group" aria-label={t("composer.voice.recording")} data-voice-recorder>
    <button type="button" onClick={onCancel} aria-label={t("composer.voice.cancel")} title={t("composer.voice.cancel")} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary hover:text-ink"><X size={17}/></button>
    <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-ink" aria-live="off">
      <span className={starting ? "size-2 rounded-full bg-ink-secondary" : "size-2 animate-pulse rounded-full bg-danger"} aria-hidden="true"/>
      {starting ? <span className="text-ink-secondary">{t("composer.voice.starting")}</span> : formatElapsed(elapsed)}
    </span>
    <div className="min-w-0 flex-1" role="img" aria-label={t("composer.voice.level")}>
      <Waveform stream={stream} barColor="rgba(170,170,170,0.85)" barWidth={2} barGap={3} barHeight={2} height={24} noiseFloor="adaptive" fallback="static"/>
    </div>
    <button type="button" disabled={starting} onClick={onSend} aria-label={t("composer.voice.send")} title={t("composer.voice.send")} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-app disabled:opacity-50" data-voice-send><ArrowUp size={18}/></button>
  </div>;
}

/** Voice messages on their way out, and any the server has not accepted. */
export function ComposerVoicePending({ pending, onRetry, onDiscard }: {
  pending: PendingVoice[];
  onRetry(id: string): void;
  onDiscard(id: string): void;
}) {
  if (!pending.length) return null;
  return <>
    {pending.map((entry) => entry.stage === "failed"
      ? <div key={entry.id} data-voice-pending="failed" className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          <Mic size={14} className="shrink-0" aria-hidden="true"/>
          <span className="min-w-0 flex-1">
            <span className="font-medium">{t("composer.voice.failedTitle")} · {formatElapsed(entry.durationMs)}</span>
            {entry.error && <span className="block text-[12px] opacity-90">{entry.error}</span>}
          </span>
          <button type="button" onClick={() => onRetry(entry.id)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 font-medium hover:bg-danger/10"><RotateCcw size={13}/>{t("composer.voice.retry")}</button>
          <button type="button" onClick={() => onDiscard(entry.id)} aria-label={t("composer.voice.discardAria")} title={t("composer.voice.discard")} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-danger/10"><X size={13} strokeWidth={2.5}/></button>
        </div>
      : <div key={entry.id} data-voice-pending={entry.stage} role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-[12.5px] text-ink-secondary">
          <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true"/>
          <span className="min-w-0 flex-1 truncate">
            {entry.stage === "transcribing" ? t("composer.voice.transcribing") : entry.stage === "sending" ? t("composer.voice.sending") : t("composer.voice.uploading")}
            {" · "}{formatElapsed(entry.durationMs)}
          </span>
        </div>)}
  </>;
}
