import { useEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { MEDIA_BORDER, MEDIA_BORDER_STRONG, MEDIA_RING, MEDIA_TEXT_SECONDARY, MEDIA_TEXT_TERTIARY } from "./MediaTokens";
import { AttachedFileChip, requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { FILE_MAX_BYTES, type TranscriptFileAttachment } from "@/lib/composer-attachments";
import { parseAudioTranscript, TRANSCRIPT_MAX_BYTES, type AudioTranscript } from "@/lib/audio-transcript";

type AudioFile = TranscriptFileAttachment & { linked?: boolean };
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/flac", "audio/x-flac", "audio/ogg", "audio/opus", "audio/x-m4a"]);

/** File route checks exact-message ownership; enforce MIME and streaming size here too. */
export async function loadAudioResource(file: AudioFile, message: MessageAttachmentContext, signal: AbortSignal, transcript = false): Promise<Blob> {
  const response = await requestMessageFile(file.path, message, signal);
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const accepted = transcript ? ["text/plain", "text/vtt", "application/x-subrip"].includes(mime) : AUDIO_MIMES.has(mime);
  const limit = transcript ? TRANSCRIPT_MAX_BYTES : FILE_MAX_BYTES;
  if (!accepted || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new Error(transcript ? "transcript unavailable or too large" : "audio unavailable or exceeds 25 mb");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("file unavailable");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("file exceeds preview size limit");
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return new Blob(chunks, { type: mime });
}

export function AudioAttachment({ file, transcriptFile, message }: { file: AudioFile; transcriptFile?: AudioFile; message: MessageAttachmentContext }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState<AudioTranscript>();
  const [transcriptError, setTranscriptError] = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef<AbortController | null>(null);
  const transcriptRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); transcriptRequest.current?.abort(); }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const load = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true); setError("");
    try { const blob = await loadAudioResource(file, message, controller.signal); if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob)); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "audio unavailable"); }
    finally { if (!controller.signal.aborted) setLoading(false); if (request.current === controller) request.current = null; }
  };
  const loadTranscript = async () => {
    if (!transcriptFile || transcript || transcriptRequest.current) return;
    const controller = new AbortController(); transcriptRequest.current = controller; setTranscriptError(""); setTranscriptLoading(true);
    try {
      const blob = await loadAudioResource(transcriptFile, message, controller.signal, true);
      const text = await blob.text();
      if (!controller.signal.aborted) setTranscript(parseAudioTranscript(text, /\.(vtt|srt)$/i.test(transcriptFile.name)));
    } catch (e) { if (!controller.signal.aborted) setTranscriptError(e instanceof Error ? e.message : "transcript unavailable"); }
    finally { if (!controller.signal.aborted) setTranscriptLoading(false); if (transcriptRequest.current === controller) transcriptRequest.current = null; }
  };
  const pill = cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] leading-[18px] font-medium text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_7.8%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40", MEDIA_BORDER_STRONG);
  return <section aria-label={`voice memo: ${file.name}`} className={cn("w-[320px] max-w-full shrink-0 overflow-hidden rounded-[20px] bg-raised text-[12px] leading-4", MEDIA_RING)}>
    <AttachedFileChip file={file} linked={file.linked} message={message} className="w-full rounded-none bg-transparent ring-0" />
    <div className="px-3 pb-3">
      {url ? <>
        <audio ref={audio} src={url} controls preload="metadata" aria-label={`play voice memo: ${file.name}`} className="h-9 w-full max-w-full" onLoadedMetadata={() => { if (audio.current) audio.current.playbackRate = speed; }} onTimeUpdate={() => setTime(audio.current?.currentTime ?? 0)} onError={() => setError("this audio format could not be decoded; download the original file instead")} />
        <div className={cn("mt-2 flex items-center justify-between gap-2", MEDIA_TEXT_TERTIARY)}>
          <label className="flex items-center gap-2">playback speed<select aria-label={`playback speed: ${file.name}`} value={speed} className={cn("h-6 rounded-md border bg-transparent px-1 text-ink", MEDIA_BORDER)} onChange={e => { const value = Number(e.target.value); setSpeed(value); if (audio.current) audio.current.playbackRate = value; }}>{[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
          <button type="button" className="rounded-md px-1.5 py-0.5 hover:text-ink" onClick={() => { audio.current?.pause(); setUrl(""); setTime(0); setError(""); }}>close audio</button>
        </div>
      </>
        : <button type="button" disabled={loading} onClick={() => void load()} className={pill}>
          {loading ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : error ? <RotateCcw size={13} aria-hidden="true" /> : <Play size={13} fill="currentColor" aria-hidden="true" />}
          {loading ? "loading audio…" : error ? "retry audio" : "load voice memo"}
        </button>}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      {transcriptFile ? <details className="group/transcript mt-3" onToggle={e => { if (e.currentTarget.open) void loadTranscript(); }}>
        <summary className={cn("flex cursor-pointer list-none items-center gap-1 select-none hover:text-ink [&::-webkit-details-marker]:hidden", MEDIA_TEXT_SECONDARY)}><ChevronRight size={14} aria-hidden="true" className="transition-transform group-open/transcript:rotate-90" />transcript</summary>
        {transcriptLoading && <p role="status" className={cn("mt-2", MEDIA_TEXT_TERTIARY)}>loading transcript…</p>}
        {transcriptError && <div role="alert" className="mt-2 text-danger">{transcriptError} <button type="button" className="underline" onClick={() => void loadTranscript()}>retry transcript</button></div>}
        {transcript && (transcript.segments.length ? <div className="mt-2 max-h-64 space-y-0.5 overflow-auto"><p className={cn("mb-2", MEDIA_TEXT_TERTIARY)}>select a segment to seek after loading audio.</p>{transcript.segments.map((segment, index) => <button key={index} type="button" disabled={!url} aria-label={`seek to ${segment.start.toFixed(2)} seconds: ${segment.text}`} aria-current={time >= segment.start && time < segment.end ? "true" : undefined} className="block w-full rounded-md px-1.5 py-1 text-left whitespace-pre-wrap text-ink hover:bg-[color-mix(in_srgb,var(--color-ink)_5.2%,transparent)] aria-[current=true]:bg-accent/15 disabled:opacity-60" onClick={() => { const el = audio.current; if (el && Number.isFinite(el.duration) && segment.start < el.duration) { el.currentTime = segment.start; setTime(segment.start); } }}>{segment.text}</button>)}</div> : <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-ink">{transcript.text || "empty transcript"}</p>)}
      </details> : <p className={cn("mt-2 text-[11px]", MEDIA_TEXT_TERTIARY)}>attach a matching .vtt, .srt or .txt file to include a transcript.</p>}
    </div>
  </section>;
}
