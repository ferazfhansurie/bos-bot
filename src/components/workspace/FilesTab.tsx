import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Copy, File, Folder, FolderOpen, LoaderCircle, MoreHorizontal, PanelLeft, RefreshCw } from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import { RowContextMenu, openRowMenu, type RowMenuAt, type RowMenuItem } from "@/components/RowContextMenu";
import { openInItems } from "@/components/workspace/open-in";
import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import {
  RAW_PREVIEW, absolutePath, fetchRaw, listFolder, readFile, statPath,
  type WorkspaceEntry, type WorkspaceFile,
} from "@/lib/workspace-files-client";

const TREE_POLL_MS = 4000;
const FILE_POLL_MS = 2500;
const HIGHLIGHT_MAX = 160 * 1024;

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
  const remembered = tabMemory(tabId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(remembered.expanded));
  const [treeOpen, setTreeOpen] = useState(remembered.tree);
  const [listings, setListings] = useState<Record<string, WorkspaceEntry[]>>({});
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ at: RowMenuAt; items: RowMenuItem[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const where = useMemo(() => ({ botId: target.botId, threadId: target.threadId }), [target.botId, target.threadId]);

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
          <button type="button" title={entry.path}
            onClick={() => (entry.kind === "dir" ? toggle(entry.path) : onPath(entry.path))}
            onContextMenu={(event) => entryMenu(event, entry)}
            style={{ paddingLeft: 6 + depth * 12 }}
            className={cn("flex h-[24px] w-full items-center gap-1 pr-2 text-left text-[12.5px]", selected ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover hover:text-ink")}>
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
    <div className={cn("flex min-h-0 flex-col", path ? "w-[220px] shrink-0 border-r border-hairline/50" : "flex-1")} data-testid="workspace-file-tree">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate" title={root}>{root ? root.split(/[\\/]/).filter(Boolean).pop() : ""}</span>
        <button type="button" title="refresh" aria-label="refresh" onClick={() => { void load(""); for (const dir of expanded) void load(dir); }}
          className="rounded p-1 hover:bg-raised hover:text-ink"><RefreshCw size={12} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {error ? <p role="alert" className="px-3 py-2 text-[12px] text-danger">{error}</p> : renderDir("", 0)}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 bg-app" data-testid="workspace-files">
      {(treeOpen || !path) && tree}
      {path && <FileViewer key={`${target.botId}:${target.threadId}:${path}`} target={target} path={path} root={root} active={active}
        treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} />}
      {menu && <RowContextMenu at={menu.at} label="file" items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

const LANGS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "mdx", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", css: "css", scss: "scss", less: "less", html: "html",
  htm: "html", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", toml: "toml", sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  sql: "sql", dart: "dart", php: "php", vue: "vue", svelte: "svelte", graphql: "graphql", gql: "graphql", lua: "lua", r: "r",
  ini: "ini", env: "dotenv", prisma: "prisma", tf: "hcl", ps1: "powershell", bat: "bat", diff: "diff", patch: "diff", csv: "csv",
};
const NAMED: Record<string, string> = { dockerfile: "docker", makefile: "make", gemfile: "ruby", podfile: "ruby", rakefile: "ruby" };

function languageFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMED[name]) return NAMED[name]!;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return LANGS[ext] ?? "text";
}

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

function FileViewer({ target, path, root, active, treeOpen, onToggleTree }: {
  target: TerminalTarget; path: string; root: string; active: boolean; treeOpen: boolean; onToggleTree: () => void;
}) {
  const where = useMemo(() => ({ botId: target.botId, threadId: target.threadId }), [target.botId, target.threadId]);
  const raw = RAW_PREVIEW.test(path);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [error, setError] = useState("");
  const [html, setHtml] = useState("");
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

  const lang = languageFor(path);
  const content = file?.content ?? "";
  useEffect(() => {
    setHtml("");
    if (!file || file.binary || !content || content.length > HIGHLIGHT_MAX || lang === "text") return;
    let alive = true;
    void import("shiki").then((shiki) => shiki.codeToHtml(content, {
      lang: lang in shiki.bundledLanguages ? lang : "text",
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: "light-dark()",
    })).then((out) => { if (alive) setHtml(out); }).catch(() => {});
    return () => { alive = false; };
  }, [file, content, lang]);

  const absolute = absolutePath(root, path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const markdown = isMarkdown(path) && !source;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workspace-file-viewer">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline/50 px-2 text-[12px]">
        <button type="button" onClick={onToggleTree} title={treeOpen ? "hide files" : "show files"} aria-label={treeOpen ? "hide files" : "show files"}
          className={cn("rounded p-1 hover:bg-raised hover:text-ink", treeOpen ? "text-ink" : "text-ink-secondary")}><PanelLeft size={13} /></button>
        <span className="min-w-0 flex-1 truncate text-ink-secondary" title={path}>
          {path.includes("/") && <span>{path.slice(0, path.lastIndexOf("/") + 1)}</span>}<span className="text-ink">{name}</span>
        </span>
        {isMarkdown(path) && (
          <button type="button" onClick={() => setSource((value) => !value)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-raised hover:text-ink">
            {source ? "preview" : "source"}
          </button>
        )}
        {root && <button type="button" title="more" aria-label="more" onClick={(event) => openRowMenu(event, setMenu)}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"><MoreHorizontal size={14} /></button>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? <p role="alert" className="p-4 text-[12.5px] text-danger">{error}</p>
          : raw ? (blobUrl ? (/\.pdf$/i.test(path)
            ? <iframe title={name} src={blobUrl} className="h-full w-full border-0 bg-app" />
            : <div className="flex min-h-full items-center justify-center p-4"><img src={blobUrl} alt={name} className="max-h-full max-w-full object-contain" /></div>)
            : <Loading />)
          : !file ? <Loading />
          : file.binary ? <p className="p-4 text-[12.5px] text-ink-secondary">binary file · {formatSize(file.size)}</p>
          : markdown ? <div className="px-5 py-4 text-[14px] text-ink"><ChatMarkdown text={content} /></div>
          : html ? <div className="chat-md workspace-code text-[12.5px] [&_pre]:min-h-full [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:leading-[1.55]" dangerouslySetInnerHTML={{ __html: html }} />
          : <pre className="whitespace-pre p-3 font-mono text-[12.5px] leading-[1.55] text-ink">{content}</pre>}
        {file?.truncated && !file.binary && <p className="px-3 pb-3 text-[11.5px] text-ink-secondary">showing the first {formatSize(content.length)} of {formatSize(file.size)}</p>}
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kb`;
  return `${(bytes / 1024 / 1024).toFixed(1)} mb`;
}
