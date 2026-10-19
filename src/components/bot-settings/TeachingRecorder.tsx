import { useEffect, useRef, useState } from 'react';
import { Camera, Circle, Square, Trash2 } from 'lucide-react';
import { useStore, type Bot } from '@/state/store';
import { composeMessage, imageAttachmentFromFile, type Attachment } from '@/lib/composer-attachments';
import { requestScreenPreview, stopScreenPreview } from '@/lib/screen-preview';
import { MAX_TEACHING_FRAMES, teachingPrompt, type TeachingFrame } from '@/lib/teaching-demonstration';

type Frame = TeachingFrame & { blob: Blob; preview: string };
export function TeachingRecorder({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'review' | 'sending'>('idle');
  const [title, setTitle] = useState('');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const revision = useRef(0);
  const alive = useRef(true);
  const frameList = useRef<Frame[]>([]);
  const capturing = useRef(false);
  const finish = () => { stopScreenPreview(stream.current); stream.current = null; if (alive.current) setPhase('review'); };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; revision.current++; stopScreenPreview(stream.current);
      for (const frame of frameList.current) URL.revokeObjectURL(frame.preview);
    };
  }, []);
  const capture = async () => {
    if (capturing.current || !stream.current || frameList.current.length >= MAX_TEACHING_FRAMES) return;
    const source = video.current;
    if (!source?.videoWidth) return;
    const version = revision.current;
    capturing.current = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(1280, source.videoWidth); canvas.height = Math.max(1, Math.round(source.videoHeight * canvas.width / source.videoWidth));
      canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .75));
      if (!blob || !alive.current || version !== revision.current || !stream.current) return;
      const frame: Frame = { id: crypto.randomUUID(), atMs: Date.now() - started.current, note: '', blob, preview: URL.createObjectURL(blob) };
      frameList.current = [...frameList.current, frame]; setFrames(frameList.current);
      if (frameList.current.length >= MAX_TEACHING_FRAMES) finish();
    } finally { capturing.current = false; }
  };
  const captureRef = useRef(capture); captureRef.current = capture;
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => void captureRef.current(), 5000);
    return () => clearInterval(timer);
  }, [phase]);
  const start = async () => {
    setError(''); setPhase('requesting'); const version = ++revision.current;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('screen capture is unavailable here. use the desktop app or a browser that supports screen sharing.');
      const result = await requestScreenPreview({
        beginIntent: () => window.ogb ? Boolean(window.ogb.beginScreenPreviewIntent?.()) : true,
        getDisplayMedia: constraints => navigator.mediaDevices.getDisplayMedia(constraints),
      });
      if (!alive.current || version !== revision.current) { if (result.ok) stopScreenPreview(result.stream); return; }
      if (!result.ok) throw new Error('screen sharing was cancelled or is unavailable. nothing was recorded.');
      stream.current = result.stream; started.current = Date.now(); setPhase('recording');
      result.stream.getVideoTracks()[0]?.addEventListener('ended', finish, { once: true });
      if (video.current) { video.current.srcObject = result.stream; await video.current.play(); }
    } catch (reason) { if (alive.current && version === revision.current) { stopScreenPreview(stream.current); stream.current = null; setPhase('idle'); setError(reason instanceof Error ? reason.message : 'could not start recording'); } }
  };
  const discard = () => {
    revision.current++; stopScreenPreview(stream.current); stream.current = null;
    for (const frame of frameList.current) URL.revokeObjectURL(frame.preview);
    frameList.current = []; setFrames([]); setPhase('idle'); setError('');
  };
  const remove = (id: string) => {
    const frame = frameList.current.find(value => value.id === id); if (frame) URL.revokeObjectURL(frame.preview);
    frameList.current = frameList.current.filter(value => value.id !== id); setFrames(frameList.current);
  };
  const learn = async () => {
    setError(''); const version = revision.current;
    try {
      const prompt = teachingPrompt(title, frames); setPhase('sending');
      const attachments: Attachment[] = [];
      for (const [index, frame] of frames.entries()) {
        const attachment = await imageAttachmentFromFile(new File([frame.blob], `demonstration-${index + 1}.jpg`, { type: 'image/jpeg' }));
        if (!alive.current || version !== revision.current) return;
        if (!attachment) throw new Error('could not upload a demonstration screenshot');
        attachments.push(attachment);
      }
      // The reviewed task and exact thread remain pinned throughout upload.
      dispatch({ type: 'send', botId: bot.id, threadId: bot.threadId, text: composeMessage(prompt, attachments) });
      dispatch({ type: 'toggleSettings', open: false });
    } catch (reason) { if (alive.current) { setError(reason instanceof Error ? reason.message : 'could not send demonstration'); setPhase('review'); } }
  };
  const button = 'rounded-lg bg-control px-3 py-2 text-xs text-ink disabled:opacity-50';
  return <section className="rounded-xl bg-card p-4" aria-label="teach a task">
    <h3 className="text-[15px] font-medium">teach a task</h3>
    <p className="mt-1 text-xs text-ink-secondary">record screen snapshots and step notes, then review what the bot learns. no audio is captured. recording stops at 20 snapshots.</p>
    <input className="mt-3 w-full rounded bg-inset p-2 text-sm" aria-label="task to teach" placeholder="what should this bot learn?" value={title} maxLength={200} disabled={phase === 'sending'} onChange={event => setTitle(event.target.value)} />
    <video ref={video} autoPlay muted playsInline className={phase === 'recording' ? 'mt-3 max-h-48 w-full rounded' : 'hidden'} />
    <div className="mt-3 flex flex-wrap gap-2">
      {phase === 'idle' && <button className={button} disabled={bot.busy || !title.trim()} onClick={() => void start()}><Circle size={12} className="mr-1 inline" />start recording</button>}
      {phase === 'requesting' && <button className={button} onClick={discard}>cancel screen request</button>}
      {phase === 'recording' && <><button className={button} onClick={() => void capture()}><Camera size={12} className="mr-1 inline" />capture step</button><button className={button} onClick={finish}><Square size={12} className="mr-1 inline" />stop and review</button></>}
      {(phase === 'review' || phase === 'recording') && <button className={button} onClick={discard}>discard recording</button>}
    </div>
    <ol className="mt-3 flex flex-col gap-3">{frames.map((frame, index) => <li key={frame.id} className="rounded border border-hairline/30 p-2">
      <div className="mb-2 flex justify-between text-xs"><span>step {index + 1} · {(frame.atMs / 1000).toFixed(1)}s</span><button aria-label={`remove step ${index + 1}`} disabled={phase === 'sending'} onClick={() => remove(frame.id)}><Trash2 size={13} /></button></div>
      <img alt={`recorded step ${index + 1}`} src={frame.preview} className="max-h-44 rounded" />
      <textarea aria-label={`step ${index + 1} note`} placeholder="what did you do here, and why?" className="mt-2 w-full rounded bg-inset p-2 text-xs" maxLength={2000} disabled={phase === 'sending'} value={frame.note} onChange={event => { frameList.current = frameList.current.map(value => value.id === frame.id ? { ...value, note: event.target.value } : value); setFrames(frameList.current); }} />
    </li>)}</ol>
    {phase === 'review' && <button className={`${button} mt-3`} disabled={bot.busy || !frames.length} onClick={() => void learn()}>learn from reviewed demonstration</button>}
    {phase === 'sending' && <p role="status" className="mt-2 text-xs">uploading reviewed screenshots…</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </section>;
}
