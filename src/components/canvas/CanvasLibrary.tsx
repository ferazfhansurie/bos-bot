// The blank tab's library, under the prompt: every page bos wrote in this
// conversation's folder, plus this bot's docs and videos, laid out like
// ChatGPT's library (title, pill tabs, search, New, grid or list). Pages show
// a live preview; rows open in this same tab.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Box, ChevronDown, Clapperboard, Copy, Download, FileText, LayoutGrid, List, MoreHorizontal, Search, SquareDashed, Trash2 } from "lucide-react";

import { pageApi } from "@/components/pages/page-api";
import { videoApi } from "@/components/videos/video-api";
import { Menu, anchorOf, type MenuAnchor, type MenuEntry } from "@/components/workbench/Menu";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/memory";
import type { TerminalTarget } from "@/lib/terminal";
import { fetchRaw, listFolder } from "@/lib/workspace-files-client";
import type { AppSummary } from "../../../shared/apps";
import { appApi } from "./app-api";
import { appIcon } from "./app-icons";
import { CANVAS_DIR, LIBRARY_FILTERS, LIBRARY_KIND_LABEL, canvasDocument, canvasFileTitle, libraryView, type LibraryFilter, type LibraryItem, type LibraryKind } from "./canvas";

const ICON: Record<LibraryKind, typeof FileText> = { app: Box, page: SquareDashed, doc: FileText, video: Clapperboard };
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
  const [actions, setActions] = useState<{ item: LibraryItem; anchor: MenuAnchor } | null>(null);
  const [reload, setReload] = useState(0);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const setLayout = (next: Layout) => { setLayoutState(next); localStorage.setItem(LAYOUT_KEY, next); };
  useEffect(() => {
    let live = true;
    const none = () => [] as LibraryItem[];
    const appList = appApi.listForBot(target.botId).catch(() => [] as AppSummary[]);
    void appList.then(a => { if (live) setApps(a); });
    void Promise.all([
      appList.then(list => list.map(appItem)),
      Promise.all([listFolder(target, CANVAS_DIR), appList]).then(([l, list]) => l.entries
        .filter(e => e.kind === "file" && /\.html?$/i.test(e.name) && !list.some(a => a.threadId === target.threadId && a.path === e.path))
        .map((e): LibraryItem => ({ kind: "page", id: e.path, title: canvasFileTitle(e.name), at: e.mtime ?? 0 })), none),
      pageApi.list(target.botId).then(ps => ps.map((p): LibraryItem => ({ kind: "doc", id: p.id, title: p.title || "Untitled doc", at: p.updatedAt })), none),
      videoApi.list(target.botId).then(vs => vs.map((v): LibraryItem => ({ kind: "video", id: v.id, title: v.title || "Untitled video", at: v.updatedAt })), none),
    ]).then(parts => { if (live) setItems(parts.flat()); });
    return () => { live = false; };
  }, [target, reload]);
  // a bot made, renamed or deleted an app
  useEffect(() => {
    const onChanged = (event: Event) => {
      const d = (event as CustomEvent<{ botId?: string; meta?: boolean; deleted?: boolean }>).detail;
      if (d?.botId === target.botId && (d.meta || d.deleted)) setReload(n => n + 1);
    };
    window.addEventListener("bos-app-changed", onChanged);
    return () => window.removeEventListener("bos-app-changed", onChanged);
  }, [target.botId]);
  const appActions = (item: LibraryItem): MenuEntry[] => {
    const app = apps.find(a => a.id === item.id);
    if (!app) return [];
    const collections = Object.keys(app.collections);
    return [
      // an installed app is its author's page: install it again rather than copy it
      ...app.installed ? [] : [{ key: "dup", label: "Duplicate", icon: Copy, onSelect: () => void appApi.duplicate(app.id).then(() => setReload(n => n + 1), () => undefined) }],
      { key: "export", label: "Export", icon: Download, submenu: [
        { key: "json", label: "Everything (json)", onSelect: () => { location.assign(appApi.exportUrl(app.id, "json")); } },
        ...collections.map((c): MenuEntry => ({ key: c, label: `${c} (csv)`, onSelect: () => { location.assign(appApi.exportUrl(app.id, "csv", c)); } })),
      ] },
      { type: "separator", key: "sep" },
      { key: "delete", label: "Delete app and its data", icon: Trash2, danger: true, onSelect: () => {
        if (window.confirm(app.installed ? `Remove ${app.name} and all its data?` : `Delete ${app.name} and all its data? The page file stays in Files.`)) void appApi.destroy(app.id).then(() => setReload(n => n + 1), () => undefined);
      } },
    ];
  };
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
              {rows.slice(0, 60).map(item => <Card key={`${item.kind}:${item.id}`} item={item} target={target} onOpen={onOpen}
                onMore={item.kind === "app" ? anchor => setActions({ item, anchor }) : undefined} />)}
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex h-10 items-center gap-3 px-2 text-[13px] text-ink-secondary">
                <span className="min-w-0 flex-1">Name</span>
                <span className="hidden w-20 shrink-0 sm:block">Kind</span>
                <span className="flex w-24 shrink-0 items-center gap-1">Updated<ArrowDown size={13} /></span>
              </div>
              {rows.slice(0, 100).map(item => {
                const Icon = item.kind === "app" ? appIcon(item.icon) : ICON[item.kind];
                return (
                  <div key={`${item.kind}:${item.id}`} className="relative border-t border-hairline/70">
                    <button type="button" onClick={() => onOpen(item)}
                      className={cn("flex h-[60px] w-full items-center gap-3 px-2 text-left transition-colors hover:bg-raised/40", item.kind === "app" && "pe-11")}>
                      <Icon size={18} strokeWidth={1.7} className="shrink-0 text-ink-secondary" />
                      <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{item.title}{item.detail && <span className="ms-2 text-[13px] text-ink-secondary">{item.detail}</span>}</span>
                      <span className="hidden w-20 shrink-0 text-[14px] text-ink-secondary sm:block">{LIBRARY_KIND_LABEL[item.kind]}</span>
                      <span className="w-24 shrink-0 text-[14px] text-ink-secondary">{item.at ? relativeTime(item.at) : ""}</span>
                    </button>
                    {item.kind === "app" && <MoreButton title={item.title} onMore={anchor => setActions({ item, anchor })} className="end-1.5 top-1/2 -translate-y-1/2" />}
                  </div>
                );
              })}
            </div>
          )}
      </div>

      {actions && (
        <Menu anchor={actions.anchor} align="end" label={actions.item.title} width={230} onClose={() => setActions(null)} entries={appActions(actions.item)} />
      )}
      {menu && (
        <Menu anchor={menu} align="end" label="New" width={200} onClose={() => setMenu(null)} entries={[
          { key: "app", label: "App", icon: Box, onSelect: () => onNew("app") },
          { key: "page", label: "Page", icon: SquareDashed, onSelect: () => onNew("page") },
          { key: "doc", label: "Doc", icon: FileText, onSelect: () => onNew("doc") },
          { key: "video", label: "Video", icon: Clapperboard, onSelect: () => onNew("video") },
        ]} />
      )}
    </section>
  );
}

function MoreButton({ title, onMore, className }: { title: string; onMore: (anchor: MenuAnchor) => void; className?: string }) {
  return <button type="button" aria-label={`${title} options`} title="Options" aria-haspopup="menu" onClick={e => onMore(anchorOf(e.currentTarget))}
    className={cn("absolute flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink", className)}><MoreHorizontal size={16} /></button>;
}

// "1 contacts" reads wrong; collection names are plural nouns, so one record drops the s
const countLabel = (name: string, n: number) => `${n} ${n !== 1 ? name : name.replace(/ies$/, "y").replace(/(?<!s)s$/, "")}`;

const appItem = (app: AppSummary): LibraryItem => {
  const counts = Object.entries(app.collections).sort((a, b) => b[1] - a[1]);
  const detail = counts.length ? countLabel(counts[0]![0], counts[0]![1]) : "no data yet";
  return { kind: "app", id: app.id, title: app.name, at: app.updatedAt, detail, icon: app.icon };
};

/** A room's blank tab: the apps its people share. */
export function RoomApps({ roomId, onOpen }: { roomId: string; onOpen: (app: AppSummary) => void }) {
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    appApi.listForRoom(roomId).then(a => { if (live) setApps(a); }, () => { if (live) setApps([]); });
    return () => { live = false; };
  }, [roomId, reload]);
  useEffect(() => {
    const onChanged = (event: Event) => { if ((event as CustomEvent<{ meta?: boolean; deleted?: boolean }>).detail?.meta) setReload(n => n + 1); };
    window.addEventListener("bos-app-changed", onChanged);
    return () => window.removeEventListener("bos-app-changed", onChanged);
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-app px-6 pb-16 sm:px-12" data-testid="room-apps">
      <div className="flex w-full max-w-[720px] flex-col gap-5 pt-[10vh]">
        <h1 className="text-center text-[24px] font-normal tracking-[-0.01em] text-ink">apps in this room</h1>
        <p className="text-center text-[14px] text-ink-secondary">everyone here uses the same data. share an app from its tab in your chat with a bot.</p>
        {apps === null ? null : apps.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-ink-secondary">No apps shared here yet.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {apps.map(app => {
              const Icon = appIcon(app.icon);
              const item = appItem(app);
              return (
                <button key={app.id} type="button" onClick={() => onOpen(app)} data-testid="room-app"
                  className="flex items-center gap-3 rounded-2xl border border-hairline/80 bg-card p-4 text-left transition-colors hover:border-ink/25">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised"><Icon size={19} strokeWidth={1.7} className="text-ink" /></span>
                  <span className="flex min-w-0 flex-col"><span className="truncate text-[15px] font-medium text-ink">{app.name}</span><span className="truncate text-[13px] text-ink-secondary">{item.detail}</span></span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ item, target, onOpen, onMore }: { item: LibraryItem; target: TerminalTarget; onOpen: (item: LibraryItem) => void; onMore?: (anchor: MenuAnchor) => void }) {
  if (item.kind === "app") return <AppCard item={item} onOpen={onOpen} onMore={onMore} />;
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

function AppCard({ item, onOpen, onMore }: { item: LibraryItem; onOpen: (item: LibraryItem) => void; onMore?: (anchor: MenuAnchor) => void }) {
  const Icon = appIcon(item.icon);
  return (
    <div className="relative aspect-square">
      <button type="button" onClick={() => onOpen(item)} aria-label={item.title} data-kind="app"
        className="flex size-full flex-col overflow-hidden rounded-[18px] border border-hairline/80 bg-card p-4 text-left transition-colors hover:border-ink/25">
        <span className="flex size-11 items-center justify-center rounded-xl bg-raised"><Icon size={21} strokeWidth={1.7} className="text-ink" /></span>
        <span className="mt-auto line-clamp-2 text-[15px] font-medium leading-5 text-ink">{item.title}</span>
        <span className="mt-0.5 text-[12.5px] text-ink-secondary">{item.detail}{item.at ? ` · ${relativeTime(item.at)}` : ""}</span>
      </button>
      {onMore && <MoreButton title={item.title} onMore={onMore} className="end-2.5 top-2.5" />}
    </div>
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
