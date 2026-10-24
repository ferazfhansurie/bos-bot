// The blank tab: an empty page bos fills in. There is no prompt of its own:
// you ask bos in the chat as usual ("start a new tab, make it my dashboard"),
// the bundled blank-tab skill has it write an html file in the working
// folder and call open_tab, and this tab (or a fresh one) shows that file
// live, sandboxed like a chat html preview. Later messages edit the same
// file. A deck presents fullscreen, one top-level section per screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, FileText, FolderOpen, LayoutDashboard, Loader2, Pin, PinOff, Play, Presentation, RefreshCw, SquareDashed, X } from "lucide-react";

import { ARTIFACT_FRAME_NAME } from "@/components/HtmlArtifact";
import { videoApi } from "@/components/videos/video-api";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import { fetchRaw, statPath, WorkspaceFilesError } from "@/lib/workspace-files-client";
import { useStore } from "@/state/store";
import type { WorkspaceTab, WorkspaceTabKind } from "@/lib/thread-workspace";
import { CanvasLibrary } from "./CanvasLibrary";
import { isPinned, pinPage, unpinPage, usePins } from "./pins";
import { CANVAS_STARTERS, COMPOSER_INSERT_EVENT, type ComposerInsertDetail, type LibraryItem, type LibraryKind, canvasDocument, htmlTitle } from "./canvas";

interface Props {
  tab: WorkspaceTab;
  target: TerminalTarget;
  active: boolean;
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

export function CanvasTab({ tab, target, active, setTab, replace }: Props) {
  if (!tab.ref) return <BlankPrompt target={target} setTab={setTab} replace={replace} />;
  return <CanvasView path={tab.ref} title={tab.title} target={target} from={tab.from} active={active} setTab={setTab} />;
}

function BlankPrompt({ target, setTab, replace }: { target: TerminalTarget } & Pick<Props, "setTab" | "replace">) {
  const [error, setError] = useState("");
  const open = (item: LibraryItem) => {
    if (item.kind === "page") setTab({ ref: item.id, title: item.title });
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

const STARTER_ICON: Record<string, typeof FileText> = { presentation: Presentation, dashboard: LayoutDashboard, doc: FileText, video: Clapperboard };

function CanvasView({ path, title, target: here, from, active, setTab }: { path: string; title?: string; target: TerminalTarget; from?: string; active: boolean; setTab: Props["setTab"] }) {
  // a page pinned from another chat lives in that chat's folder
  // keyed on ids, not identity: a new target object must not reload the page
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => from ? { ...here, threadId: from } : here, [here.botId, here.threadId, from]);
  const busy = useThreadBusy(target);
  const page = { botId: target.botId, threadId: target.threadId, path };
  const pins = usePins(target.botId);
  const pinned = isPinned(pins, page);
  const togglePin = () => pinned ? unpinPage(page) : pinPage({ ...page, title: title || "Blank tab" });
  // a pin added from the new tab's chooser carries the file name; the page's own title replaces it once it loads
  const stale = Boolean(title) && pins.some(p => p.threadId === page.threadId && p.path === path && p.title !== title);
  useEffect(() => { if (stale && title) pinPage({ botId: target.botId, threadId: target.threadId, path, title }); }, [stale, title, target, path]);
  const { openTab } = useWorkspace();
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [presenting, setPresenting] = useState(false);
  const [slide, setSlide] = useState({ at: 0, count: 0 });
  const [hint, setHint] = useState(false);
  const [escaped, setEscaped] = useState(false);
  const mtime = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const presentingRef = useRef(false); presentingRef.current = presenting;
  const slideRef = useRef(0); slideRef.current = slide.at;
  const frameId = useMemo(() => `canvas-${++frameCounter}`, []);
  const srcDoc = useMemo(() => html === null ? "" : canvasDocument(html, frameId), [html, frameId]);
  const titleRef = useRef(title); titleRef.current = title;
  // setTab is a fresh function on every dock render; holding it in a ref keeps
  // load stable, so the frame isn't torn down (white flash, scroll to top)
  const setTabRef = useRef(setTab); setTabRef.current = setTab;

  const load = useCallback(async (force = false) => {
    try {
      const st = await statPath(target, path);
      setMissing(false);
      if (!force && st.mtime === mtime.current) return;
      const text = await (await fetchRaw(target, path)).text();
      mtime.current = st.mtime; setHtml(text); setError("");
      const named = htmlTitle(text);
      if (named && named !== titleRef.current) setTabRef.current({ title: named });
    } catch (e) {
      if (e instanceof WorkspaceFilesError && e.status === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [target, path]);
  useEffect(() => { mtime.current = 0; setHtml(null); void load(true); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, busy || html === null ? FAST_POLL : SLOW_POLL);
    return () => clearInterval(timer);
  }, [active, busy, html, load]);
  // the turn that writes the page may finish between polls
  useEffect(() => { if (!busy) void load(); }, [busy, load]);
  useEffect(() => { loads.current = 0; setEscaped(false); }, [srcDoc]);

  const tell = useCallback((cmd: string, extra: Record<string, unknown> = {}) => {
    frame.current?.contentWindow?.postMessage({ bosCanvas: frameId, cmd, ...extra }, "*");
  }, [frameId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { bosCanvas?: unknown; slide?: unknown; count?: unknown; exit?: unknown; info?: unknown } | null;
      if (!data || data.bosCanvas !== frameId) return;
      if (data.exit) { void stopPresenting(); return; }
      const count = typeof data.count === "number" ? data.count : 0;
      setSlide(s => data.info ? { at: s.at, count } : { at: typeof data.slide === "number" ? data.slide : 0, count });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId]);

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
        <span className="min-w-0 flex-1 truncate px-1.5 text-[13px] font-medium text-ink">{title || "Blank tab"}</span>
        {busy && <span className="inline-flex items-center gap-1.5 px-1.5 text-[12px] text-ink/55"><Loader2 size={13} className="animate-spin" />bos is drawing</span>}
        <button type="button" title={pinned ? "Unpin from new tab" : "Pin to new tab"} aria-label={pinned ? "Unpin from new tab" : "Pin to new tab"} aria-pressed={pinned}
          onClick={togglePin} data-testid="canvas-pin"
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink">{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
        {!from && <button type="button" title="Show in files" aria-label="Show in files" onClick={() => openTab("files", { path })}
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink"><FolderOpen size={15} /></button>}
        <button type="button" title="Reload" aria-label="Reload" onClick={() => void load(true)}
          className="flex size-8 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.06] hover:text-ink"><RefreshCw size={15} /></button>
        <button type="button" onClick={() => void present()} disabled={waiting} data-testid="canvas-present"
          className="ms-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-app transition-opacity disabled:opacity-30">
          <Play size={13} fill="currentColor" />Present
        </button>
      </div>
      <div ref={stage} className={cn("canvas-stage relative min-h-0 flex-1 bg-white", presenting && "fixed inset-0 z-[100]")}>
        {waiting ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-app text-[13px] text-ink/55">
            {error ? <p role="alert" className="text-danger">{error}</p>
              : <><Loader2 size={18} className="animate-spin" /><p>{busy || !missing ? "bos is drawing this page…" : "nothing here yet. ask bos in the chat to draw it."}</p></>}
          </div>
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
