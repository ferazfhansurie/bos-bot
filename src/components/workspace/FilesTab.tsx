import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Copy, File, Folder, FolderOpen, LoaderCircle, MoreHorizontal, PanelLeft, Search, Folders, RefreshCw } from "lucide-react";

import { FilePreview } from "@/components/FilePreview";
import { RowContextMenu, openRowMenu, type RowMenuAt, type RowMenuItem } from "@/components/RowContextMenu";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { openIn, openInAvailable, openInItems } from "@/components/workspace/open-in";
import { cn } from "@/lib/cn";
import { formatSize, hasSource, previewKind } from "@/lib/file-preview";
import type { TerminalTarget } from "@/lib/terminal";
import {
  RAW_PREVIEW, absolutePath, fetchRaw, listFolder, readFile, statPath, searchFiles,
  type WorkspaceEntry, type WorkspaceFile,
} from "@/lib/workspace-files-client";

const TREE_POLL_MS = 4000;
const FILE_POLL_MS = 2500;

/** Tree state per tab survives the tab being hidden or moved between panels. */
const memory = new Map<string, { expanded: Set<string>; tree: boolean }>();
function tabMemory(tabId: string) {
  let entry = memory.get(tabId);
  if (!entry) { entry = { expanded: new Set(), tree: true }; memory.set(tabId, entry); }
  return entry;
}

/** Poll only while the tab is on screen and the window is in front. */
function usePoll(active: boolean, ms: number, tick: () => void) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") ref.current(); }, ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}

const signature = (entries: WorkspaceEntry[]) => entries.map((entry) => `${entry.kind}:${entry.name}:${entry.mtime ?? ""}:${entry.size ?? ""}`).join("|");

export function FilesTab({ target, tabId, path, active, onPath }: {
  target: TerminalTarget; tabId: string; path?: string; active: boolean; onPath: (path: string | undefined) => void;
}) {
  const { setQuickOpen } = useWorkspace();
  const [filter, setFilter] = useState('');
  const [matches, setMatches] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const remembered = tabMemory(tabId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(remembered.expanded));
  const [treeOpen, setTreeOpen] = useState(remembered.tree);
  const [listings, setListings] = useState<Record<string, WorkspaceEntry[]>>({});
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ at: RowMenuAt; items: RowMenuItem[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const where = useMemo(() => ({ botId: target.botId, threadId: target.threadId }), [target.botId, target.threadId]);

  useEffect(() => {
    if (!filter.trim()) { setMatches([]); setSearching(false); setSearchError(''); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void searchFiles(where, filter.trim(), controller.signal).then(data => {setMatches(data.files);setSearchError('');})
        .catch(cause => {if (!controller.signal.aborted) setSearchError(cause instanceof Error ? cause.message : 'Search unavailable');})
        .finally(() => {if (!controller.signal.aborted) setSearching(false);});
    }, 120);
    return () => {clearTimeout(timer); controller.abort();};
  }, [where, filter]);

  useEffect(() => { remembered.expanded = expanded; remembered.tree = treeOpen; }, [remembered, expanded, treeOpen]);

  const load = useCallback(async (dir: string) => {
    try {
      const listing = await listFolder(where, dir);
      setRoot(listing.root);
      setListings((all) => (all[dir] && signature(all[dir]) === signature(listing.entries) ? all : { ...all, [dir]: listing.entries }));
      if (!dir) setError("");
    } catch (cause) {
      if (!dir) setError(cause instanceof Error ? cause.message : "folder unavailable");
      else setListings((all) => { const next = { ...all }; delete next[dir]; return next; });
    }
  }, [where]);

  useEffect(() => { void load(""); }, [load]);
  // open the folders above a file shown from chat or quick open
  useEffect(() => {
    if (!path) return;
    const parts = path.split("/").slice(0, -1);
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    if (ancestors.every((dir) => expanded.has(dir))) return;
    setExpanded((current) => new Set([...current, ...ancestors]));
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const dir of expanded) if (!listings[dir]) void load(dir); }, [expanded, listings, load]);
  usePoll(active && treeOpen, TREE_POLL_MS, () => { void load(""); for (const dir of expanded) void load(dir); });

  const toggle = (dir: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    return next;
  });

  const entryMenu = (event: ReactMouseEvent, entry: WorkspaceEntry) => {
    const absolute = absolutePath(root, entry.path);
    openRowMenu(event, (at) => setMenu({ at, items: [
      ...openInItems(absolute, entry.kind === "dir"),
      { key: "copy", label: "copy path", icon: <Copy size={15} />, onSelect: () => void navigator.clipboard?.writeText(absolute) },
    ] }));
  };

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const entries = listings[dir];
    if (!entries) return depth === 0 ? null : <div style={{ paddingLeft: 12 + depth * 12 }} className="py-1 text-[12px] text-ink-secondary"><LoaderCircle size={12} className="animate-spin" /></div>;
    if (!entries.length && depth === 0) return <p className="px-3 py-2 text-[12px] text-ink-secondary">this folder is empty</p>;
    return entries.map((entry) => {
      const open = entry.kind === "dir" && expanded.has(entry.path);
      const selected = entry.path === path;
      return (
        <div key={entry.path}>
          <button type="button" title={entry.path} ref={selected ? scrollIntoView : undefined}
            onClick={() => (entry.kind === "dir" ? toggle(entry.path) : onPath(entry.path))}
            onContextMenu={(event) => entryMenu(event, entry)}
            style={{ paddingLeft: 6 + depth * 12 }}
            className={cn("flex h-[29px] w-full items-center gap-1 pr-2 text-left text-[12.5px]", selected ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover hover:text-ink")}>
            {entry.kind === "dir"
              ? <>{open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}{open ? <FolderOpen size={13} className="shrink-0" /> : <Folder size={13} className="shrink-0" />}</>
              : <><span className="w-3 shrink-0" /><File size={13} className="shrink-0" /></>}
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          {open && renderDir(entry.path, depth + 1)}
        </div>
      );
    });
  };

  const tree = (
    <div className={cn("flex min-h-0 flex-col", "w-[38%] min-w-[150px] max-w-[260px] shrink-0 border-l border-hairline/50")} data-testid="workspace-file-tree">
      <div className="flex shrink-0 items-center gap-1 p-2">
        <input aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={e=>setFilter(e.target.value)} className="h-7 min-w-0 flex-1 rounded-lg bg-ink/[.04] px-2 text-[12px] outline-none focus:ring-1 focus:ring-ink/20"/>
        <button type="button" title="Refresh files" aria-label="Refresh files" onClick={() => {void load('');for (const dir of expanded) void load(dir);}} className="rounded p-1 text-ink-secondary hover:bg-raised"><RefreshCw size={13}/></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {error || searchError ? <p role="alert" className="px-3 py-2 text-[12px] text-danger">{error || searchError}</p> : filter.trim() ? searching ? <Loading/> : matches.length ? matches.map(match=><button key={match} onClick={()=>onPath(match)} className={cn("flex h-[29px] w-full items-center gap-2 px-3 text-left text-[12.5px] hover:bg-raised", match===path ? 'text-ink bg-raised' : 'text-ink-secondary')}><File size={13}/><span className="truncate">{match}</span></button>) : <div className="p-4 text-center text-[12px] text-ink-secondary">No matching files<button className="mt-2 block w-full text-ink underline" onClick={()=>setFilter('')}>Clear file filter</button></div> : renderDir("", 0)}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="workspace-files">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px]">
        <button title={root || '/'} onClick={()=>onPath(undefined)} className="min-w-0 truncate rounded-lg bg-ink/[.04] px-2 py-1">/ {path?.split('/').slice(0,-1).join('/')}</button>
        <span className="flex-1"/>
        <button aria-label="Search files" title="Search files ⌘P" onClick={()=>setQuickOpen(true)} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><Search size={16}/></button>
        <button aria-label="Toggle file tree" title="Toggle file tree" onClick={()=>setTreeOpen(value=>!value)} className={cn("rounded-lg p-1.5 hover:bg-raised",treeOpen ? 'bg-ink/[.08] text-ink' : 'text-ink-secondary')}><Folders size={16}/></button>
      </div>
      <div className="flex min-h-0 flex-1">
        {path ? <FileViewer key={`${target.botId}:${target.threadId}:${path}`} target={target} path={path} root={root} active={active}
          treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} /> : <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-ink/50"><Folders size={28} strokeWidth={1.5}/><h2 className="text-[15px] font-medium text-ink">Open file</h2><p className="text-[13px]">Select a file from the workspace tree</p></div>}
        {treeOpen && tree}
      </div>
      {menu && <RowContextMenu at={menu.at} label="file" items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

/** Bring a file opened from chat or quick open into view in the tree. */
const scrollIntoView = (element: HTMLElement | null) => element?.scrollIntoView({ block: "nearest" });

function FileViewer({ target, path, root, active, treeOpen, onToggleTree }: {
  target: TerminalTarget; path: string; root: string; active: boolean; treeOpen: boolean; onToggleTree: () => void;
}) {
  const where = useMemo(() => ({ botId: target.botId, threadId: target.threadId }), [target.botId, target.threadId]);
  const raw = RAW_PREVIEW.test(path);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [menu, setMenu] = useState<RowMenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const mtime = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      if (raw) {
        const [info, blob] = await Promise.all([statPath(where, path), fetchRaw(where, path)]);
        mtime.current = info.mtime;
        setBlobUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return URL.createObjectURL(blob); });
      } else {
        const next = await readFile(where, path);
        mtime.current = next.mtime;
        setFile(next);
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "file unavailable");
    }
  }, [where, path, raw]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => setBlobUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return ""; }), []);
  // the bot edits files while you watch: reload when the file changes on disk
  usePoll(active, FILE_POLL_MS, () => {
    void statPath(where, path).then((info) => { if (info.mtime !== mtime.current) void load(); }).catch(() => setError("this file is gone"));
  });

  const absolute = absolutePath(root, path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = raw ? previewKind(path) : file && !file.binary && previewKind(path) === "other" ? "text" : previewKind(path);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workspace-file-viewer">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline/50 px-2 text-[12px]">
        <button type="button" onClick={onToggleTree} title={treeOpen ? "hide files" : "show files"} aria-label={treeOpen ? "hide files" : "show files"}
          className={cn("rounded p-1 hover:bg-raised hover:text-ink", treeOpen ? "text-ink" : "text-ink-secondary")}><PanelLeft size={13} /></button>
        <span className="min-w-0 flex-1 truncate text-ink-secondary" title={path}>
          {path.includes("/") && <span>{path.slice(0, path.lastIndexOf("/") + 1)}</span>}<span className="text-ink">{name}</span>
        </span>
        {hasSource(kind) && (
          <button type="button" onClick={() => setSource((value) => !value)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-raised hover:text-ink">
            {source ? "preview" : "source"}
          </button>
        )}
        {root && <button type="button" title="more" aria-label="more" onClick={(event) => openRowMenu(event, setMenu)}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"><MoreHorizontal size={14} /></button>}
      </div>
      <div className={cn("min-h-0 flex-1", raw || (kind === "html" && !source) ? "overflow-hidden" : "overflow-auto")}>
        {error ? <p role="alert" className="p-4 text-[12.5px] text-danger">{error}</p>
          : raw ? (blobUrl ? <FilePreview name={name} kind={kind} url={blobUrl} /> : <Loading />)
          : !file ? <Loading />
          : <FilePreview name={name} kind={kind} text={file.binary ? undefined : file.content} source={source} size={file.size}
            empty={root && openInAvailable() ? <button type="button" onClick={() => openIn(absolute, "default")} className="rounded-lg bg-ink/[.06] px-3 py-1.5 text-[12.5px] text-ink hover:bg-ink/[.1]">open with default app</button> : undefined} />}
        {file?.truncated && !file.binary && <p className="px-3 pb-3 text-[11.5px] text-ink-secondary">showing the first {formatSize(file.content.length)} of {formatSize(file.size)}</p>}
      </div>
      {menu && <RowContextMenu at={menu} label="file" onClose={closeMenu} items={[
        ...openInItems(absolute),
        { key: "copy", label: "copy path", icon: <Copy size={15} />, onSelect: () => void navigator.clipboard?.writeText(absolute) },
      ]} />}
    </div>
  );
}

function Loading() {
  return <div className="flex justify-center p-6 text-ink-secondary"><LoaderCircle size={16} className="animate-spin" /></div>;
}
