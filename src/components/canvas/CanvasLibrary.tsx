// The blank tab's library, under the prompt: every page bos wrote in this
// conversation's folder, plus this bot's docs and videos, laid out like
// ChatGPT's library (title, pill tabs, search, New, grid or list). Pages show
// a live preview; rows open in this same tab.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, Clapperboard, FileText, LayoutGrid, List, Search, SquareDashed } from "lucide-react";

import { pageApi } from "@/components/pages/page-api";
import { videoApi } from "@/components/videos/video-api";
import { Menu, anchorOf, type MenuAnchor } from "@/components/workbench/Menu";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/memory";
import type { TerminalTarget } from "@/lib/terminal";
import { fetchRaw, listFolder } from "@/lib/workspace-files-client";
import { CANVAS_DIR, LIBRARY_FILTERS, LIBRARY_KIND_LABEL, canvasDocument, canvasFileTitle, libraryView, type LibraryFilter, type LibraryItem, type LibraryKind } from "./canvas";

const ICON: Record<LibraryKind, typeof FileText> = { page: SquareDashed, doc: FileText, video: Clapperboard };
const LAYOUT_KEY = "bos.canvas.library-layout";
type Layout = "grid" | "list";

export function CanvasLibrary({ target, onOpen, onNew }: {
  target: TerminalTarget;
  onOpen: (item: LibraryItem) => void;
  onNew: (kind: LibraryKind) => void;
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [layout, setLayoutState] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const setLayout = (next: Layout) => { setLayoutState(next); localStorage.setItem(LAYOUT_KEY, next); };
  useEffect(() => {
    let live = true;
    const none = () => [] as LibraryItem[];
    void Promise.all([
      listFolder(target, CANVAS_DIR).then(l => l.entries
        .filter(e => e.kind === "file" && /\.html?$/i.test(e.name))
        .map((e): LibraryItem => ({ kind: "page", id: e.path, title: canvasFileTitle(e.name), at: e.mtime ?? 0 })), none),
      pageApi.list(target.botId).then(ps => ps.map((p): LibraryItem => ({ kind: "doc", id: p.id, title: p.title || "Untitled doc", at: p.updatedAt })), none),
      videoApi.list(target.botId).then(vs => vs.map((v): LibraryItem => ({ kind: "video", id: v.id, title: v.title || "Untitled video", at: v.updatedAt })), none),
    ]).then(parts => { if (live) setItems(parts.flat()); });
    return () => { live = false; };
  }, [target]);
  const rows = useMemo(() => libraryView(items ?? [], filter, query), [items, filter, query]);

  return (
    <section className="flex w-full flex-col" data-testid="canvas-library" aria-label="Library">
      <div className="flex items-center gap-3">
        <h2 className="shrink-0 text-[24px] font-semibold tracking-[-0.01em] text-ink">Library</h2>
        <div className="ms-auto flex min-w-0 items-center gap-2">
          <div className="hidden shrink-0 items-center sm:flex" role="radiogroup" aria-label="Layout">
            {(["grid", "list"] as const).map(id => {
              const Icon = id === "grid" ? LayoutGrid : List;
              return (
                <button key={id} type="button" role="radio" aria-checked={layout === id} aria-label={id === "grid" ? "Grid view" : "List view"} onClick={() => setLayout(id)}
                  className={cn("flex size-8 items-center justify-center rounded-full transition-colors",
                    layout === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink")}>
                  <Icon size={17} strokeWidth={1.8} />
                </button>
              );
            })}
          </div>
          <label className="flex h-8 w-[240px] min-w-[96px] shrink items-center gap-2 rounded-full border border-hairline px-3 focus-within:border-ink/30">
            <Search size={15} className="shrink-0 text-ink-secondary" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search library" aria-label="Search library"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-secondary" />
          </label>
          <button type="button" aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={e => setMenu(menu ? null : anchorOf(e.currentTarget))}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-ink ps-3.5 pe-2.5 text-[14px] font-medium text-app transition-opacity hover:opacity-90">
            New<ChevronDown size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-1" role="tablist" aria-label="Library sections">
        {LIBRARY_FILTERS.map(f => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className={cn("h-9 rounded-full px-4 text-[15px] transition-colors",
              filter === f.id ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {items === null ? null
          : rows.length === 0 ? (
            <p className="py-12 text-center text-[14px] text-ink-secondary">
              {items.length === 0 ? "Pages you make show up here." : "Nothing matches."}
            </p>
          ) : layout === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5">
              {rows.slice(0, 60).map(item => <Card key={`${item.kind}:${item.id}`} item={item} target={target} onOpen={onOpen} />)}
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex h-10 items-center gap-3 px-2 text-[13px] text-ink-secondary">
                <span className="min-w-0 flex-1">Name</span>
                <span className="hidden w-20 shrink-0 sm:block">Kind</span>
                <span className="flex w-24 shrink-0 items-center gap-1">Updated<ArrowDown size={13} /></span>
              </div>
              {rows.slice(0, 100).map(item => {
                const Icon = ICON[item.kind];
                return (
                  <button key={`${item.kind}:${item.id}`} type="button" onClick={() => onOpen(item)}
                    className="flex h-[60px] items-center gap-3 border-t border-hairline/70 px-2 text-left transition-colors hover:bg-raised/40">
                    <Icon size={18} strokeWidth={1.7} className="shrink-0 text-ink-secondary" />
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{item.title}</span>
                    <span className="hidden w-20 shrink-0 text-[14px] text-ink-secondary sm:block">{LIBRARY_KIND_LABEL[item.kind]}</span>
                    <span className="w-24 shrink-0 text-[14px] text-ink-secondary">{item.at ? relativeTime(item.at) : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
      </div>

      {menu && (
        <Menu anchor={menu} align="end" label="New" width={200} onClose={() => setMenu(null)} entries={[
          { key: "page", label: "Page", icon: SquareDashed, onSelect: () => onNew("page") },
          { key: "doc", label: "Doc", icon: FileText, onSelect: () => onNew("doc") },
          { key: "video", label: "Video", icon: Clapperboard, onSelect: () => onNew("video") },
        ]} />
      )}
    </section>
  );
}

function Card({ item, target, onOpen }: { item: LibraryItem; target: TerminalTarget; onOpen: (item: LibraryItem) => void }) {
  const Icon = ICON[item.kind];
  const when = item.at ? `Edited ${relativeTime(item.at)}` : "";
  return (
    <button type="button" onClick={() => onOpen(item)} aria-label={item.title} data-kind={item.kind}
      className="group relative aspect-square overflow-hidden rounded-[18px] border border-hairline/80 bg-card text-left transition-colors hover:border-ink/25">
      {item.kind === "page" ? (
        <>
          <PageThumb target={target} path={item.id} />
          <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-4 pb-3.5 pt-8">
            <span className="line-clamp-2 text-[14px] font-medium leading-5 text-white">{item.title}</span>
            <span className="text-[12.5px] text-white/65">{when}</span>
          </span>
        </>
      ) : (
        <span className="flex h-full flex-col p-4">
          <span className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">{item.title}</span>
          <span className="flex flex-1 items-center justify-center"><Icon size={34} strokeWidth={1.4} className="text-ink-secondary" /></span>
          <span className="text-[12.5px] text-ink-secondary">{when}</span>
        </span>
      )}
    </button>
  );
}

const THUMB_WIDTH = 1280;

/** The page itself, scripts off, scaled down to the card. */
function PageThumb({ target, path }: { target: TerminalTarget; path: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchRaw(target, path, ctrl.signal).then(b => b.text()).then(setHtml, () => undefined);
    return () => ctrl.abort();
  }, [target, path]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = width / THUMB_WIDTH;
  return (
    <span ref={box} className="pointer-events-none absolute inset-0 block bg-white" aria-hidden>
      {html !== null && width > 0 && (
        <iframe title="" tabIndex={-1} sandbox="" loading="lazy" srcDoc={canvasDocument(html, "thumb")}
          style={{ width: THUMB_WIDTH, height: THUMB_WIDTH, transform: `scale(${scale})`, transformOrigin: "0 0" }}
          className="border-0" />
      )}
    </span>
  );
}
