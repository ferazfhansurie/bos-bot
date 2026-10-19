// The media bin: what this video can use. Drop files in from Finder, drag
// an item onto a track, or double-click to put it at the end of the video.
import { useState } from "react";
import { AudioLines, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import { fmtTime, type VideoMedia } from "../../../shared/video";
import { cn } from "@/lib/cn";
import { videoApi } from "./video-api";
import { IconButton } from "./ui";

/** The media item being dragged right now (dragover cannot read dataTransfer). */
export const mediaDrag: { current: VideoMedia | null } = { current: null };
export const MEDIA_DRAG_TYPE = "application/x-bos-video-media";

export interface UploadItem { key: string; name: string; progress: number; error?: string; cancel: () => void }

export function MediaBin({ media, botId, videoId, uploads, onPick, onDropFiles, onAppend, onClose }: {
  media: VideoMedia[];
  botId: string;
  videoId: string;
  uploads: UploadItem[];
  onPick: () => void;
  onDropFiles: (files: File[]) => void;
  onAppend: (media: VideoMedia) => void;
  onClose?: () => void;
}) {
  const [dropping, setDropping] = useState(false);
  return (
    <div className={cn("relative flex h-full min-h-0 flex-col bg-panel", dropping && "bg-accent/[.06]")}
      onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={e => { setDropping(false); if (e.dataTransfer.files.length) { e.preventDefault(); onDropFiles([...e.dataTransfer.files]); } }}>
      <div className="flex h-10 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="flex-1 text-[12.5px] font-medium text-ink/85">Media</span>
        <IconButton icon={Upload} label="Add media" onClick={onPick}><span>Add</span></IconButton>
        {onClose && <IconButton icon={X} label="Close media" onClick={onClose} />}
      </div>
      <div className="video-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {uploads.map(u => (
          <div key={u.key} className="mb-1.5 rounded-lg bg-ink/[.04] px-2.5 py-2">
            <div className="flex items-center gap-2 text-[12px]">
              {u.error ? <X size={13} className="shrink-0 text-danger" /> : <Loader2 size={13} className="shrink-0 animate-spin text-ink/50" />}
              <span className="min-w-0 flex-1 truncate text-ink/80">{u.name}</span>
              {!u.error && <span className="shrink-0 tabular-nums text-ink-secondary">{Math.round(u.progress * 100)}%</span>}
              <button type="button" aria-label={u.error ? "Dismiss" : "Cancel upload"} onClick={u.cancel} className="shrink-0 rounded p-0.5 text-ink/45 hover:bg-ink/[.08] hover:text-ink"><X size={12} /></button>
            </div>
            {u.error
              ? <p className="mt-1 text-[11px] leading-snug text-danger">{u.error}</p>
              : <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10"><div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(2, u.progress * 100)}%` }} /></div>}
            {!u.error && u.progress >= 1 && <p className="mt-1 text-[11px] text-ink-secondary">Reading the file…</p>}
          </div>
        ))}
        {media.length === 0 && uploads.length === 0 ? (
          <button type="button" onClick={onPick}
            className="mt-1 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-ink/15 px-4 py-8 text-center text-[12px] leading-snug text-ink-secondary transition-colors hover:border-ink/30 hover:text-ink/80">
            <Upload size={18} strokeWidth={1.5} />
            Drop clips here, or ask bos to make one
          </button>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
            {[...media].reverse().map(m => <MediaTile key={m.id} media={m} botId={botId} videoId={videoId} onAppend={() => onAppend(m)} />)}
          </div>
        )}
      </div>
      {dropping && <div className="pointer-events-none absolute inset-1.5 rounded-xl border-2 border-dashed border-accent" />}
    </div>
  );
}

function MediaTile({ media, botId, videoId, onAppend }: { media: VideoMedia; botId: string; videoId: string; onAppend: () => void }) {
  const t = media.thumbs;
  const columns = t ? Math.min(10, Math.max(1, t.count)) : 1;
  // the tile shows the sprite frame a third of the way in
  const index = t ? Math.min(t.count - 1, Math.floor(t.count / 3)) : 0;
  return (
    <div role="button" tabIndex={0} draggable title={`${media.name}\nDouble-click to add at the end; drag onto a track to place it`}
      onDragStart={e => { mediaDrag.current = media; e.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id); e.dataTransfer.effectAllowed = "copy"; }}
      onDragEnd={() => { mediaDrag.current = null; }}
      onDoubleClick={onAppend}
      onKeyDown={e => { if (e.key === "Enter") onAppend(); }}
      className="group flex cursor-grab flex-col gap-1 rounded-lg p-1 outline-none transition-colors hover:bg-ink/[.06] focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing">
      <div className="relative aspect-video overflow-hidden rounded-md bg-ink/[.06]">
        {t ? (
          <div className="absolute inset-y-0 left-1/2 h-full -translate-x-1/2" style={{
            aspectRatio: `${t.width} / ${t.height}`,
            backgroundImage: `url("${videoApi.thumbsUrl(botId, videoId, media.id)}")`,
            backgroundSize: `${columns * 100}% ${Math.ceil(t.count / columns) * 100}%`,
            backgroundPosition: `${columns > 1 ? ((index % columns) / (columns - 1)) * 100 : 0}% ${Math.ceil(t.count / columns) > 1 ? (Math.floor(index / columns) / (Math.ceil(t.count / columns) - 1)) * 100 : 0}%`,
          }} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-ink/35">
            {media.kind === "audio" ? <AudioLines size={20} strokeWidth={1.5} /> : media.kind === "image" ? <ImageIcon size={20} strokeWidth={1.5} /> : <Loader2 size={16} className="animate-spin" />}
          </div>
        )}
        {media.kind !== "image" && media.duration > 0 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] leading-4 tabular-nums text-white/90">{fmtTime(media.duration).replace(/\.\d+$/, "")}</span>
        )}
      </div>
      <span className="truncate px-0.5 text-[11.5px] text-ink/75">{media.name}</span>
    </div>
  );
}
