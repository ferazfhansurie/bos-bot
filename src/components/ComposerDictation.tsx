import { useEffect, useState } from "react";
import { ArrowUp, Loader2, Square, X } from "lucide-react";
import { Waveform } from "./voice-call/Waveform";

/** The waveform is local mic input; recognition stays with the speech helper. */
export function ComposerDictation({ finishing, onCancel, onFinish }: {
  finishing: boolean;
  onCancel(): void;
  onFinish(send: boolean): void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    let closed = false;
    let captured: MediaStream | null = null;
    void navigator.mediaDevices?.getUserMedia({ audio: true }).then(value => {
      if (closed) { value.getTracks().forEach(track => track.stop()); return; }
      captured = value;
      setStream(value);
    }).catch(() => { /* Recognition may still have its own native mic grant. */ });
    return () => { closed = true; captured?.getTracks().forEach(track => track.stop()); };
  }, []);
  return <div className="composer-dictation flex min-w-0 items-center gap-2" role="group" aria-label="Voice input">
    <button type="button" onClick={onCancel} aria-label="Cancel voice input" title="Cancel voice input" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary hover:text-ink"><X size={16}/></button>
    <div className="min-w-0 flex-1" role="status" aria-label={finishing ? "Finishing transcription" : "Recording audio"}><Waveform stream={stream} barColor="rgba(170,170,170,0.85)" barWidth={2} barGap={3} barHeight={2} height={24} noiseFloor="adaptive" fallback="static"/></div>
    <button type="button" disabled={finishing} onClick={() => onFinish(false)} aria-label="Stop voice input" title="Stop and keep transcript" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary disabled:opacity-50">{finishing ? <Loader2 size={15} className="animate-spin"/> : <Square size={12} className="fill-current"/>}</button>
    <button type="button" disabled={finishing} onClick={() => onFinish(true)} aria-label="Send voice transcript" title="Finish and send transcript" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-app disabled:opacity-50"><ArrowUp size={17}/></button>
  </div>;
}
