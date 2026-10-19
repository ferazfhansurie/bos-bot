// What a video tab shows before it holds a video: this bot's videos with
// their last render, and a new one in the size it should be.
import { useEffect, useState } from "react";
import { Check, Clapperboard, Loader2, Plus, Search, TriangleAlert } from "lucide-react";
import { fmtTime, VIDEO_SIZES, type VideoSizePreset, type VideoSummary } from "../../../shared/video";
import { relativeTime } from "@/lib/memory";
import { cn } from "@/lib/cn";
import { videoApi } from "./video-api";
import { AspectGlyph, aspectName } from "./ui";

const PRESETS: { key: VideoSizePreset; label: string }[] = [
  { key: "portrait", label: "Portrait" }, { key: "landscape", label: "Landscape" }, { key: "square", label: "Square" }, { key: "feed", label: "Feed" },
];

export function VideoList({ botId, threadId, onOpen }: { botId: string; threadId?: string; onOpen: (id: string, title: string) => void }) {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<VideoSizePreset>("portrait");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      videoApi.list(botId, { query }).then(v => { if (live) { setVideos(v); setError(null); } }, e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    }, query ? 180 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [botId, query]);

  const create = async () => {
    setCreating(true);
    try {
      const v = await videoApi.create(botId, { size, threadId });
      onOpen(v.id, v.title);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setCreating(false); }
  };

  return (
    <div className="video-scroll @container flex h-full min-h-0 flex-col overflow-y-auto bg-panel">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-5 py-8">
        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-ink">New video</h2>
          <div className="grid grid-cols-2 gap-2 @min-[460px]:grid-cols-4">
            {PRESETS.map(p => {
              const s = VIDEO_SIZES[p.key];
              return (
                <button key={p.key} type="button" onClick={() => setSize(p.key)} aria-pressed={size === p.key}
                  className={cn("flex h-[88px] flex-col items-center justify-center gap-2 rounded-xl transition-colors", size === p.key ? "bg-ink/[.1] text-ink ring-1 ring-ink/25" : "bg-ink/[.04] text-ink/65 hover:bg-ink/[.078]")}>
                  <AspectGlyph width={s.width} height={s.height} size={26} />
                  <span className="flex flex-col items-center leading-tight">
                    <span className="text-[12.5px]">{p.label}</span>
                    <span className="text-[10.5px] text-ink-secondary">{aspectName(s.width, s.height)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="button" onClick={create} disabled={creating}
            className="flex h-9 items-center justify-center gap-2 self-start rounded-lg bg-accent px-3.5 text-[13px] font-medium text-[var(--color-accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-60">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} strokeWidth={2} />}New video
          </button>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h2 className="flex-1 text-[15px] font-semibold text-ink">Videos</h2>
            <label className="flex h-8 w-52 items-center gap-2 rounded-lg bg-ink/[.04] px-2.5 text-ink-secondary focus-within:ring-1 focus-within:ring-ink/20">
              <Search size={13} />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" aria-label="Search videos"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink/35" />
            </label>
          </div>
          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
          {!videos && !error && <p className="px-1 py-3 text-[12.5px] text-ink-secondary">Loading…</p>}
          {videos && videos.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-ink/[.03] px-6 py-10 text-center">
              <Clapperboard size={22} strokeWidth={1.5} className="text-ink/35" />
              <p className="text-[12.5px] text-ink-secondary">{query ? "No videos match." : "No videos yet. Start one above, or ask bos to cut one from your clips."}</p>
            </div>
          )}
          <div className="flex flex-col">
            {videos?.map(v => (
              <button key={v.id} type="button" onClick={() => onOpen(v.id, v.title)}
                className="flex h-14 items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-ink/[.078]">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ink/[.06] text-ink/55"><AspectGlyph width={v.width} height={v.height} size={16} /></span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] text-ink">{v.title}</span>
                  <span className="truncate text-[11.5px] text-ink-secondary">
                    {fmtTime(v.duration).replace(/\.\d+$/, "")} · {v.clipCount} {v.clipCount === 1 ? "clip" : "clips"} · {relativeTime(v.updatedAt)}
                  </span>
                </span>
                <RenderBadge summary={v} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function RenderBadge({ summary }: { summary: VideoSummary }) {
  const r = summary.lastRender;
  if (!r) return null;
  if (r.status === "queued" || r.status === "running") return <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-ink-secondary"><Loader2 size={11} className="animate-spin" />{Math.round(r.progress * 100)}%</span>;
  if (r.status === "done") return <span className={cn("flex shrink-0 items-center gap-1 text-[11px]", r.revision === summary.revision ? "text-success" : "text-ink-secondary")} title={r.revision === summary.revision ? "Rendered" : "Rendered an earlier cut"}><Check size={12} />{r.revision === summary.revision ? "Rendered" : "Older render"}</span>;
  if (r.status === "failed") return <span className="flex shrink-0 items-center gap-1 text-[11px] text-danger" title={r.error}><TriangleAlert size={11} />Render failed</span>;
  return null;
}
