// The blank tab: an empty page bos fills in. There is no prompt of its own:
// you ask bos in the chat as usual ("start a new tab, make it my dashboard"),
// the bundled blank-tab skill has it write an html file in the working
// folder and call open_tab, and this tab (or a fresh one) shows that file
// live, sandboxed like a chat html preview. Later messages edit the same
// file. A deck presents fullscreen, one top-level section per screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Clapperboard, Download, FileText, FolderOpen, LayoutDashboard, Loader2, Pin, PinOff, Play, Presentation, RefreshCw, Share2, SquareDashed, Users, X } from "lucide-react";

import { ARTIFACT_FRAME_NAME } from "@/components/HtmlArtifact";
import { videoApi } from "@/components/videos/video-api";
import { Menu, anchorOf, type MenuAnchor, type MenuEntry } from "@/components/workbench/Menu";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import { fetchRaw, statPath, WorkspaceFilesError } from "@/lib/workspace-files-client";
import { useStore } from "@/state/store";
import type { WorkspaceTab, WorkspaceTabKind } from "@/lib/thread-workspace";
import type { AppSummary } from "../../../shared/apps";
import { AppApiError, appApi, appRefId, APP_REF_PREFIX } from "./app-api";
import { appIcon } from "./app-icons";
import { appMeta, parseBridgeRequest, type BridgeRequest } from "./app-kit";
import { CanvasLibrary, RoomApps } from "./CanvasLibrary";
import { isPinned, pinPage, unpinPage, usePins } from "./pins";
import { CANVAS_STARTERS, COMPOSER_INSERT_EVENT, type ComposerInsertDetail, type LibraryItem, type LibraryKind, canvasDocument, htmlTitle } from "./canvas";

interface Props {
  tab: WorkspaceTab;
  target: TerminalTarget;
  active: boolean;
  /** a room's tab: only apps shared into it open here */
  room?: boolean;
  setTab: (patch: { title?: string; ref?: string }) => void;
  replace: (kind: WorkspaceTabKind, options?: { ref?: string; title?: string; path?: string; from?: string }) => void;
}

const FAST_POLL = 1200, SLOW_POLL = 4000;
let frameCounter = 0;

/** Whether this conversation's bot is mid-turn. */
function useThreadBusy(target: TerminalTarget): boolean {
  const { state } = useStore();
  const bot = state.bots.find(b => b.id === target.botId);
  const task = bot?.tasks?.find(t => t.threadId === target.threadId);
  return Boolean(task ? task.busy : bot?.threadId === target.threadId && bot?.busy);
}

/** Put words in this conversation's chat composer, caret at the end. */
function typeInChat(target: TerminalTarget, text: string) {
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail: { botId: target.botId, threadId: target.threadId, text } }));
}

export function CanvasTab({ tab, target, active, setTab, replace, room }: Props) {
  if (!tab.ref) return room ? <RoomApps roomId={target.botId} onOpen={app => setTab({ ref: APP_REF_PREFIX + app.id, title: app.name })} />
    : <BlankPrompt target={target} setTab={setTab} replace={replace} />;
  if (room && !appRefId(tab.ref)) return <p className="p-5 text-[13px] text-ink-secondary">Blank tabs belong to direct conversations. Share an app into this room to use it here.</p>;
  return <CanvasView path={tab.ref} title={tab.title} target={target} from={tab.from} active={active} setTab={setTab} />;
}

function BlankPrompt({ target, setTab, replace }: { target: TerminalTarget } & Pick<Props, "setTab" | "replace">) {
  const [error, setError] = useState("");
  const open = (item: LibraryItem) => {
    if (item.kind === "app") setTab({ ref: APP_REF_PREFIX + item.id, title: item.title });
    else if (item.kind === "page") setTab({ ref: item.id, title: item.title });
    else replace(item.kind === "doc" ? "page" : "video", { ref: item.id, title: item.title });
  };
  const video = async () => {
    // videos have their own editor and pipeline
    try {
      const made = await videoApi.create(target.botId, { title: "Untitled video", threadId: target.threadId });
      replace("video", { ref: made.id, title: made.title });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const starter = (id: string, prompt: string) => { if (id === "video") void video(); else typeInChat(target, prompt); };
  const onNew = (kind: LibraryKind) => {
    if (kind === "page") typeInChat(target, "");
    else if (kind === "app") typeInChat(target, "make me an app for ");
    else if (kind === "video") void video();
    else replace("page");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-app px-6 pb-16 sm:px-12" data-testid="blank-tab">
      <div className="flex w-full max-w-[720px] flex-col items-center gap-5 pt-[12vh]">
        <h1 className="text-center text-[28px] font-normal tracking-[-0.01em] text-ink">what should this page be?</h1>
        <p className="text-center text-[15px] text-ink-secondary">tell bos in the chat. it draws the page right here.</p>
        <div className="flex flex-wrap justify-center gap-2">
          {CANVAS_STARTERS.map(s => {
            const Icon = STARTER_ICON[s.id] ?? SquareDashed;
            return (
              <button key={s.id} type="button" onClick={() => starter(s.id, s.prompt)}
                className="inline-flex h-[38px] items-center gap-2 rounded-full border border-hairline px-3.5 text-[14px] text-ink-secondary transition-colors hover:bg-raised/50 hover:text-ink">
                <Icon size={16} strokeWidth={1.8} />{s.label}
              </button>
            );
          })}
        </div>
        {error && <p role="alert" className="text-center text-[13px] text-danger">{error}</p>}
      </div>
      <div className="mt-[8vh] w-full max-w-[1100px]">
        <CanvasLibrary target={target} onOpen={open} onNew={onNew} />
      </div>
    </div>
  );
}

const STARTER_ICON: Record<string, typeof FileText> = { crm: Users, app: Box, presentation: Presentation, dashboard: LayoutDashboard, doc: FileText, video: Clapperboard };

const BRIDGE_INFLIGHT = 32;

/** The app's colour scheme, for the kit's tokens. */
function hostTheme(): "light" | "dark" | undefined {
  const scheme = getComputedStyle(document.documentElement).getPropertyValue("--code-color-scheme").trim();
  return scheme === "dark" || scheme === "light" ? scheme : undefined;
}

/** One bridge request, answered by the server under the app id the tab
 * resolved; the page never names an app. */
async function runBridge(appId: string, req: BridgeRequest): Promise<unknown> {
  const { collection, id } = req;
  if (req.op === "list") return appApi.records(appId, collection);
  if (req.op === "get") return appApi.record(appId, collection, id!);
  const op = req.op === "put" ? { op: "put" as const, collection, id, record: req.record }
    : req.op === "patch" ? { op: "patch" as const, collection, id: id!, fields: req.fields }
    : { op: "delete" as const, collection, id: id! };
  const { records } = await appApi.write(appId, [op]);
  return req.op === "remove" ? true : records[0];
}

function CanvasView({ path, title, target: here, from, active, setTab }: { path: string; title?: string; target: TerminalTarget; from?: string; active: boolean; setTab: Props["setTab"] }) {
  // a page pinned from another chat lives in that chat's folder
  // keyed on ids, not identity: a new target object must not reload the page
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => from ? { ...here, threadId: from } : here, [here.botId, here.threadId, from]);
  // "app:a-…": an app opened by id (a room, the library); its page comes from /api/apps
  const appRef = appRefId(path);
  const busy = useThreadBusy(target);
  const page = { botId: target.botId, threadId: target.threadId, path };
  const pins = usePins(target.botId);
  const pinned = isPinned(pins, page);
  const togglePin = () => pinned ? unpinPage(page) : pinPage({ ...page, title: title || "Blank tab" });
  // a pin added from the new tab's chooser carries the file name; the page's own title replaces it once it loads
  const stale = !appRef && Boolean(title) && pins.some(p => p.threadId === page.threadId && p.path === path && p.title !== title);
  useEffect(() => { if (stale && title) pinPage({ botId: target.botId, threadId: target.threadId, path, title }); }, [stale, title, target, path]);
  const { openTab } = useWorkspace();
  const { state } = useStore();
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [presenting, setPresenting] = useState(false);
  const [slide, setSlide] = useState({ at: 0, count: 0 });
  const [hint, setHint] = useState(false);
  const [escaped, setEscaped] = useState(false);
  const [app, setApp] = useState<AppSummary | null>(null);
  const [owner, setOwner] = useState(!appRef);
  const [gone, setGone] = useState(false);
  const [menu, setMenu] = useState<{ kind: "share" | "export"; anchor: MenuAnchor } | null>(null);
  const mtime = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const presentingRef = useRef(false); presentingRef.current = presenting;
  const slideRef = useRef(0); slideRef.current = slide.at;
  const frameId = useMemo(() => `canvas-${++frameCounter}`, []);
  const isApp = useMemo(() => html !== null && appMeta(html) !== null, [html]);
  const srcDoc = useMemo(() => html === null ? "" : canvasDocument(html, frameId, isApp), [html, frameId, isApp]);
  const titleRef = useRef(title); titleRef.current = title;
  // setTab is a fresh function on every dock render; holding it in a ref keeps
  // load stable, so the frame isn't torn down (white flash, scroll to top)
  const setTabRef = useRef(setTab); setTabRef.current = setTab;
  const appRefState = useRef<AppSummary | null>(null); appRefState.current = app;
  const hello = useRef(false);
  const queued = useRef<BridgeRequest[]>([]);
  const inflight = useRef(0);

  const load = useCallback(async (force = false) => {
    try {
      if (appRef) {
        const got = await appApi.page(appRef);
        setMissing(false); setApp(got.app); setOwner(got.owner);
        if (!force && got.mtime === mtime.current) return;
        mtime.current = got.mtime; setHtml(got.html); setError("");
        if (got.app.name !== titleRef.current) setTabRef.current({ title: got.app.name });
        return;
      }
      const st = await statPath(target, path);
      setMissing(false);
      if (!force && st.mtime === mtime.current) return;
      const text = await (await fetchRaw(target, path)).text();
      mtime.current = st.mtime; setHtml(text); setError("");
      const meta = appMeta(text);
      const named = meta?.name || htmlTitle(text);
      if (named && named !== titleRef.current) setTabRef.current({ title: named });
      // the owner's own page: register it (or pick up a renamed meta) so its data has a home
      if (meta) setApp(await appApi.ensure(target.botId, target.threadId, path));
    } catch (e) {
      if ((e instanceof WorkspaceFilesError || e instanceof AppApiError) && e.status === 404) { setMissing(true); if (appRef) setGone(true); }
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [target, path, appRef]);
  useEffect(() => { mtime.current = 0; setHtml(null); setApp(null); setGone(false); void load(true); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, busy || html === null ? FAST_POLL : appRef ? SLOW_POLL * 2 : SLOW_POLL);
    return () => clearInterval(timer);
  }, [active, busy, html, load, appRef]);
  // the turn that writes the page may finish between polls
  useEffect(() => { if (!busy) void load(); }, [busy, load]);
  useEffect(() => { loads.current = 0; setEscaped(false); hello.current = false; }, [srcDoc]);

  const tell = useCallback((cmd: string, extra: Record<string, unknown> = {}) => {
    frame.current?.contentWindow?.postMessage({ bosCanvas: frameId, cmd, ...extra }, "*");
  }, [frameId]);
  const toPage = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ bosCanvas: frameId, ...message }, "*");
  }, [frameId]);

  const answer = useCallback((req: BridgeRequest) => {
    const current = appRefState.current;
    if (!current) { if (queued.current.length < 50) queued.current.push(req); else toPage({ appReply: { rid: req.rid, ok: false, error: "app is still loading" } }); return; }
    if (inflight.current >= BRIDGE_INFLIGHT) { toPage({ appReply: { rid: req.rid, ok: false, error: "too many requests at once" } }); return; }
    inflight.current += 1;
    runBridge(current.id, req)
      .then(value => toPage({ appReply: { rid: req.rid, ok: true, value } }),
        (e: unknown) => toPage({ appReply: { rid: req.rid, ok: false, error: e instanceof Error ? e.message : String(e) } }))
      .finally(() => { inflight.current -= 1; });
  }, [toPage]);
  const greet = useCallback(() => {
    const current = appRefState.current;
    if (!hello.current || !current) return;
    toPage({ appInit: { app: { id: current.id, name: current.name }, theme: hostTheme() } });
  }, [toPage]);
  // the app resolved after the page started asking
  useEffect(() => {
    if (!app) return;
    greet();
    for (const req of queued.current.splice(0)) answer(req);
  }, [app, greet, answer]);
  // a bot, a teammate or another tab changed this app's data
  useEffect(() => {
    if (!app) return;
    const onChanged = (event: Event) => {
      const frameEvent = (event as CustomEvent<{ appId?: string; collections?: string[]; deleted?: boolean; meta?: boolean }>).detail;
      if (!frameEvent || frameEvent.appId !== app.id) return;
      if (frameEvent.deleted) { setGone(true); return; }
      if (frameEvent.meta) void appApi.get(app.id).then(r => setApp(r.app), () => undefined);
      if (frameEvent.collections?.length) toPage({ appChanged: { collections: frameEvent.collections } });
    };
    window.addEventListener("bos-app-changed", onChanged);
    return () => window.removeEventListener("bos-app-changed", onChanged);
  }, [app, toPage]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { bosCanvas?: unknown; slide?: unknown; count?: unknown; exit?: unknown; info?: unknown; app?: unknown; appHello?: unknown } | null;
      if (!data || data.bosCanvas !== frameId) return;
      if (data.appHello) { hello.current = true; greet(); return; }
      if (data.app !== undefined) {
        const req = parseBridgeRequest(data.app);
        if ("error" in req) { if (req.rid !== undefined) toPage({ appReply: { rid: req.rid, ok: false, error: req.error } }); return; }
        answer(req);
        return;
      }
      if (data.exit) { void stopPresenting(); return; }
      const count = typeof data.count === "number" ? data.count : 0;
      setSlide(s => data.info ? { at: s.at, count } : { at: typeof data.slide === "number" ? data.slide : 0, count });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId, greet, answer, toPage]);

  const stopPresenting = useCallback(async () => {
    tell("stop"); setPresenting(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }, [tell]);
  const present = async () => {
    if (!stage.current || html === null) return;
    setPresenting(true); setHint(true);
    try { await stage.current.requestFullscreen({ navigationUI: "hide" }); } catch { /* the stage still covers the tab */ }
    tell("start", { slide: 0 });
    frame.current?.focus();
    setTimeout(() => setHint(false), 2600);
  };
  useEffect(() => {
    const onFullscreen = () => { if (!document.fullscreenElement && presentingRef.current) { tell("stop"); setPresenting(false); } };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [tell]);
  useEffect(() => {
    if (!presenting) return;
    // keys pressed while the tab (not the page) has focus
    const onKey = (event: globalThis.KeyboardEvent) => {
      const k = event.key;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) { event.preventDefault(); tell("next"); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) { event.preventDefault(); tell("prev"); }
      else if (k === "Escape") { event.preventDefault(); void stopPresenting(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, tell, stopPresenting]);

  const waiting = html === null;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="canvas-tab">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline/60 px-2">
        {isApp && app ? (() => {
          const Icon = appIcon(app.icon);
          return <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-[13px] font-medium text-ink" data-testid="canvas-app-name">
            <Icon size={15} strokeWidth={1.8} className="shrink-0 text-ink/70" /><span className="truncate">{app.name}</span>
            {app.sharedRoomIds.length > 0 && <span className="shrink-0 rounded-full bg-ink/[.06] px-2 py-0.5 text-[11px] font-normal text-ink/60">shared</span>}
          </span>;
        })() : <span className="min-w-0 flex-1 truncate px-1.5 text-[13px] font-medium text-ink">{title || "Blank tab"}</span>}
        {busy && <span className="inline-flex items-center gap-1.5 px-1.5 text-[12px] text-ink/55"><Loader2 size={13} className="animate-spin" /><span className="hidden sm:inline">bos is drawing</span></span>}
        {!appRef && <button type="button" title={pinned ? "Unpin from new tab" : "Pin to new tab"} aria-label={pinned ? "Unpin from new tab" : "Pin to new tab"} aria-pressed={pinned}
          onClick={togglePin} data-testid="canvas-pin"
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink">{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>}
        {!from && !appRef && <button type="button" title="Show in files" aria-label="Show in files" onClick={() => openTab("files", { path })}
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink"><FolderOpen size={15} /></button>}
        <button type="button" title="Reload" aria-label="Reload" onClick={() => void load(true)}
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink"><RefreshCw size={15} /></button>
        {isApp && app && <button type="button" title="Export" aria-label="Export" aria-haspopup="menu" data-testid="canvas-export"
          onClick={e => setMenu({ kind: "export", anchor: anchorOf(e.currentTarget) })}
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink"><Download size={15} /></button>}
        {isApp && app && owner ? (
          <button type="button" aria-haspopup="menu" data-testid="canvas-share" onClick={e => setMenu({ kind: "share", anchor: anchorOf(e.currentTarget) })}
            className="ms-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-app">
            <Share2 size={13} />Share
          </button>
        ) : !isApp && (
          <button type="button" onClick={() => void present()} disabled={waiting} data-testid="canvas-present"
            className="ms-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-app transition-opacity disabled:opacity-30">
            <Play size={13} fill="currentColor" />Present
          </button>
        )}
      </div>
      {menu && app && (
        <Menu anchor={menu.anchor} align="end" width={260} label={menu.kind === "share" ? "Share into a room" : "Export"} onClose={() => setMenu(null)}
          entries={menu.kind === "share" ? shareEntries(app, state.groups, next => { void appApi.update(app.id, { sharedRoomIds: next }).then(setApp, e => setError(e instanceof Error ? e.message : String(e))); })
            : exportEntries(app)} />
      )}
      <div ref={stage} className={cn("canvas-stage relative min-h-0 flex-1 bg-white", presenting && "fixed inset-0 z-[100]")}>
        {waiting ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-app text-[13px] text-ink/55">
            {error ? <p role="alert" className="text-danger">{error}</p>
              : <><Loader2 size={18} className="animate-spin" /><p>{busy || !missing ? "bos is drawing this page…" : "nothing here yet. ask bos in the chat to draw it."}</p></>}
          </div>
        ) : gone ? (
          <div role="status" className="absolute inset-0 flex items-center justify-center bg-app p-5 text-center text-[13px] text-ink/60">This app was deleted or is no longer shared here.</div>
        ) : escaped ? (
          <div role="status" className="p-5 text-[13px] text-ink/60">This page tried to leave its sandbox and was stopped. Open it in Files to read the source.</div>
        ) : (
          <iframe ref={frame} name={ARTIFACT_FRAME_NAME} title={title || "Blank tab"} sandbox="allow-scripts" referrerPolicy="no-referrer" allow=""
            srcDoc={srcDoc} data-testid="canvas-frame"
            onLoad={() => {
              loads.current += 1;
              if (loads.current > 1) { setEscaped(true); return; }
              // a live edit while presenting reloads the page: keep the slide
              if (presentingRef.current) tell("start", { slide: slideRef.current });
            }}
            className="block size-full border-0" />
        )}
        {presenting && (
          <>
            <button type="button" aria-label="Exit present mode" onClick={() => void stopPresenting()}
              className="absolute end-4 top-4 flex size-9 items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"><X size={17} /></button>
            {slide.count > 0 && <span className="pointer-events-none absolute bottom-4 end-5 rounded-full bg-black/45 px-2.5 py-1 text-[12px] tabular-nums text-white/90">{slide.at + 1} / {slide.count}</span>}
            {hint && <span className="pointer-events-none absolute bottom-4 start-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1.5 text-[12px] text-white/90">arrows, space or click to move. esc to exit</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** Rooms the owner can share this app into; picking one toggles it. */
function shareEntries(app: AppSummary, groups: readonly { id: string; name: string; home?: unknown }[], save: (rooms: string[]) => void): MenuEntry[] {
  const rooms = groups.filter(g => !g.home);
  if (!rooms.length) return [{ key: "none", label: "No rooms yet. Make a room first.", disabled: true }];
  return [
    { type: "label", key: "hint", label: "teammates in the room use the same data" },
    ...rooms.map((room): MenuEntry => {
      const on = app.sharedRoomIds.includes(room.id);
      return { key: room.id, label: room.name, checked: on, onSelect: () => save(on ? app.sharedRoomIds.filter(id => id !== room.id) : [...app.sharedRoomIds, room.id]) };
    }),
  ];
}

function download(url: string) {
  const a = document.createElement("a");
  a.href = url; a.download = ""; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

function exportEntries(app: AppSummary): MenuEntry[] {
  const collections = Object.entries(app.collections);
  return [
    { key: "json", label: "Everything (json)", icon: Download, onSelect: () => download(appApi.exportUrl(app.id, "json")) },
    ...(collections.length ? [{ type: "separator" as const, key: "sep" }] : []),
    ...collections.map(([name, count]): MenuEntry => ({ key: `csv-${name}`, label: `${name} (csv)`, hint: String(count), onSelect: () => download(appApi.exportUrl(app.id, "csv", name)) })),
  ];
}
