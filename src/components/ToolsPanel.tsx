import { createElement, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, Folder, Globe, LayoutGrid, MessageSquare, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { TerminalPanel } from "./TerminalPanel";
import { ChatMarkdown } from "./ChatMarkdown";
import { api, openThread, useStore, useStreamText, type Message } from "@/state/store";
import { type TerminalTarget } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { browserAddress, type ToolKind } from "@/lib/tools-panel";

type WebGuest = HTMLElement & { goBack(): void; goForward(): void; reload(): void; getURL(): string; getTitle(): string };
const button = "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";
const tools = [
  { kind: "files", name: "Files", icon: Folder },
  { kind: "side-chat", name: "Side chat", icon: MessageSquare },
  { kind: "terminal", name: "Terminal", icon: SquareTerminal },
  { kind: "page", name: "New page", icon: FileText },
  { kind: "browser", name: "Browser", icon: Globe },
] as const;

function BrowserGuest({ url, onNavigate, onError }: { url: string; onNavigate: (url: string, title: string) => void; onError: () => void }) {
  const guest = useRef<WebGuest | null>(null);
  const callbacks = useRef({ onNavigate, onError }); callbacks.current = { onNavigate, onError };
  useEffect(() => {
    const element = guest.current; if (!element) return;
    const update = () => callbacks.current.onNavigate(element.getURL(), element.getTitle());
    const fail = (event: Event) => { if ((event as Event & { errorCode?: number }).errorCode !== -3) callbacks.current.onError(); };
    const events = ["did-navigate", "did-navigate-in-page", "page-title-updated"];
    events.forEach(name => element.addEventListener(name, update));
    element.addEventListener("did-fail-load", fail);
    return () => { events.forEach(name => element.removeEventListener(name, update)); element.removeEventListener("did-fail-load", fail); };
  }, []);
  return createElement("webview", { src: url, partition: window.ogb?.toolsBrowserPartition, className: "h-full w-full", ref: guest });
}

function BrowserTool({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState([{ id: 1, url: "about:blank", title: "New tab" }]);
  const [active, setActive] = useState(1);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const next = useRef(2);
  const host = useRef<HTMLDivElement>(null);
  const guest = (id: number) => host.current?.querySelector(`[data-browser-tab="${id}"] webview`) as WebGuest | null;
  useEffect(() => window.ogb?.onToolsBrowserPopup?.((url) => {
    const address = browserAddress(url);
    if (!address) return;
    const id = next.current++;
    setTabs(t => [...t, { id, url: address, title: "New tab" }]); setActive(id); setAddress(address);
  }), []);
  return <div ref={host} className={cn("flex h-full min-h-0 flex-col", !visible && "hidden")}>
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline px-2 py-1">
      {tabs.map(tab => <div key={tab.id} className={cn("flex max-w-48 shrink-0 items-center rounded-md", tab.id === active && "bg-raised")}>
        <button className="truncate px-2 py-1 text-xs" onClick={() => { setActive(tab.id); setAddress(guest(tab.id)?.getURL() || tab.url); }}>{tab.title}</button>
        {tabs.length > 1 && <button className={button} aria-label="Close browser tab" onClick={() => { setTabs(t => t.filter(x => x.id !== tab.id)); if (active === tab.id) { const other = tabs.find(x => x.id !== tab.id)!; setActive(other.id); setAddress(guest(other.id)?.getURL() || other.url); } }}><X size={12}/></button>}
      </div>)}
      <button className={button} aria-label="New browser tab" onClick={() => { const id = next.current++; setTabs(t => [...t, { id, url: "about:blank", title: "New tab" }]); setActive(id); setAddress(""); }}><Plus size={16}/></button>
    </div>
    <form className="flex shrink-0 items-center gap-1 border-b border-hairline p-2" onSubmit={event => {
      event.preventDefault(); const url = browserAddress(address);
      if (!url) { setError("Enter an http or https address."); return; }
      setError(""); setTabs(t => t.map(tab => tab.id === active ? { ...tab, url } : tab));
    }}>
      <button type="button" className={button} aria-label="Browser back" onClick={() => guest(active)?.goBack()}><ArrowLeft size={14}/></button>
      <button type="button" className={button} aria-label="Browser forward" onClick={() => guest(active)?.goForward()}><ArrowRight size={14}/></button>
      <button type="button" className={button} aria-label="Reload browser" onClick={() => guest(active)?.reload()}><RefreshCw size={14}/></button>
      <input aria-label="Search or enter a URL" className="min-w-0 flex-1 rounded-lg bg-raised px-3 py-1.5 text-sm outline-none" placeholder="Search or enter a URL" value={address} onChange={e => setAddress(e.target.value)}/>
    </form>
    {error && <p role="alert" className="px-3 py-2 text-xs text-danger">{error}</p>}
    {tabs.map(tab => <div key={tab.id} data-browser-tab={tab.id} className={cn("relative min-h-0 flex-1", tab.id !== active && "hidden")}>
      <BrowserGuest url={tab.url} onNavigate={(url, title) => {
        setTabs(t => t.map(item => item.id === tab.id ? { ...item, title: title || "New tab" } : item));
        if (tab.id === active) { setAddress(url === "about:blank" ? "" : url); setError(""); }
      }} onError={() => { if (tab.id === active) setError("This page could not load."); }}/>

    </div>)}
  </div>;
}

type Entry = { name: string; path: string; kind: "dir" | "file" };
function FilesTool({ target }: { target: TerminalTarget }) {
  const [path, setPath] = useState(""); const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<{ path: string; content: string; binary: boolean; truncated: boolean } | null>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const params = new URLSearchParams({ botId: target.botId, threadId: target.threadId });
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(""); setFile(null);
    const timer = setTimeout(() => {
      const args = new URLSearchParams({ botId: target.botId, threadId: target.threadId, path, q: query });
      void api(`/api/workspace-files/${query ? "search" : "list"}?${args}`, { signal: abort.signal }).then(result => {
        if (abort.signal.aborted) return;
        setEntries(query ? result.files.map((p: string) => ({ name: p, path: p, kind: "file" })) : result.entries); setTruncated(result.truncated);
      }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, query ? 180 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [target.botId, target.threadId, path, query]);
  const readGeneration = useRef(0);
  useEffect(() => { readGeneration.current++; }, [path, query, target.botId, target.threadId]);
  const read = async (entry: Entry) => {
    if (entry.kind === "dir") { setPath(entry.path); setQuery(""); return; }
    const generation = ++readGeneration.current; setLoading(true); setError("");
    try { const result = await api(`/api/workspace-files/read?${params}&path=${encodeURIComponent(entry.path)}`); if (generation === readGeneration.current) setFile(result); }
    catch (e) { if (generation === readGeneration.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation === readGeneration.current) setLoading(false); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-hairline p-2">
      <button className={button} disabled={!path && !file} aria-label="Parent folder" onClick={() => { if (file) { readGeneration.current++; setFile(null); setLoading(false); } else setPath(path.split("/").slice(0, -1).join("/")); }}><ArrowLeft size={15}/></button>
      <span className="min-w-0 flex-1 truncate text-xs" title={file?.path || path}>{file?.path || path || "Working folder"}</span>
    </div>
    <input aria-label="Search workspace files" className="m-2 rounded-lg bg-raised px-3 py-2 text-sm outline-none" placeholder="Find a file…" value={query} onChange={e => setQuery(e.target.value)}/>
    {error && <p role="alert" className="px-3 py-2 text-sm text-danger">{error}</p>}
    {loading && <p role="status" className="px-3 py-2 text-xs text-ink-secondary">Loading…</p>}
    {file ? <div className="min-h-0 flex-1 overflow-auto p-3">{file.binary ? <p className="text-sm text-ink-secondary">Binary file · preview unavailable</p> : <pre className="whitespace-pre text-xs leading-5">{file.content}</pre>}{file.truncated && <p className="mt-2 text-xs text-ink-secondary">Preview limited to 256 KB.</p>}</div>
      : <div className="min-h-0 flex-1 overflow-auto p-2">{entries.map(entry => <button key={entry.path} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-raised" onClick={() => void read(entry)}>
        {entry.kind === "dir" ? <Folder size={15} className="shrink-0 text-ink-secondary"/> : <FileText size={15} className="shrink-0 text-ink-secondary"/>}<span className="truncate">{entry.name}</span>
      </button>)}{!loading && !entries.length && <p className="p-2 text-xs text-ink-secondary">No files found.</p>}{truncated && <p className="p-2 text-xs text-ink-secondary">Results limited. Narrow your search.</p>}</div>}
  </div>;
}

function PageTool({ target }: { target: TerminalTarget }) {
  const key = `bos.tools.page:${target.botId}:${target.threadId}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  const [error, setError] = useState(false);
  return <div className="flex h-full min-h-0 flex-col p-3">
    <p className="mb-2 text-xs text-ink-secondary">{error ? "Could not save this page on this computer." : "Saved on this computer"}</p>
    <textarea aria-label="Page notes" placeholder="Write something…" className="min-h-0 flex-1 resize-none bg-transparent text-sm leading-6 outline-none" value={text} onChange={e => { setText(e.target.value); try { localStorage.setItem(key, e.target.value); setError(false); } catch { setError(true); } }}/>
  </div>;
}

function SideThread({ botId, threadId, visible, onOpen }: { botId: string; threadId: string; visible: boolean; onOpen: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]); const [draft, setDraft] = useState("");
  const [error, setError] = useState(""); const [sending, setSending] = useState(false);
  const streaming = useStreamText(threadId);
  const refresh = async (signal?: AbortSignal) => {
    const result = await api(`/api/threads/${threadId}/messages?limit=100`, { signal });
    if (!signal?.aborted) setMessages(result.messages);
  };
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController(); let inFlight = false;
    const read = async () => { if (inFlight) return; inFlight = true; try { await refresh(abort.signal); } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); } finally { inFlight = false; } };
    void read(); const timer = setInterval(() => void read(), 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [threadId, visible]);
  const send = async () => {
    if (!draft.trim() || sending) return; setSending(true); setError("");
    const text = draft;
    try { await api(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text, threadId, sendId: crypto.randomUUID() }) }); setDraft(current => current === text ? "" : current); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <button className="px-3 py-2 text-left text-xs text-ink-secondary hover:text-ink" onClick={onOpen}>Open full conversation</button>
    <div className="min-h-0 flex-1 overflow-auto px-3" aria-label="Side chat messages">{messages.filter(message => message.kind === "text").map(message => <div key={message.id} className={cn("my-3 rounded-lg p-2 text-sm", message.role === "user" && "bg-raised")}><ChatMarkdown text={message.text || ""}/></div>)}{streaming && <ChatMarkdown text={streaming}/>}</div>
    {error && <p role="alert" className="px-3 text-xs text-danger">{error}</p>}
    <form className="flex shrink-0 gap-2 border-t border-hairline p-2" onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="Side chat message" className="min-w-0 flex-1 resize-none rounded-lg bg-raised p-2 text-sm" value={draft} onChange={e => setDraft(e.target.value)}/><button type="submit" className={button} disabled={sending || !draft.trim()}>Send</button></form>
  </div>;
}

function SideChatTool({ target, visible }: { target: TerminalTarget; visible: boolean }) {
  const { state, dispatch } = useStore(); const [id, setId] = useState(""); const [creating, setCreating] = useState(false); const [error, setError] = useState("");
  const bot = state.bots.find(b => b.id === target.botId);
  const tasks = bot?.tasks?.filter(t => t.threadId !== target.threadId) || [];
  const task = tasks.find(t => t.threadId === id);
  const create = async () => {
    setCreating(true); setError("");
    try { const result = await api(`/api/bots/${target.botId}/tasks`, { method: "POST", body: JSON.stringify({ title: "Side chat", activate: false }) }); dispatch({ type: "botPatched", bot: result.bot }); setId(result.task.threadId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setCreating(false); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-hairline p-2">
      <select aria-label="Side chat thread" className="min-w-0 flex-1 rounded bg-raised p-1.5 text-sm" value={id} onChange={e => setId(e.target.value)}><option value="">Choose a thread</option>{tasks.map(t => <option key={t.threadId} value={t.threadId}>{t.title || "Untitled"}</option>)}</select>
      <button className={button} disabled={!bot || creating} aria-label="New side chat" onClick={() => void create()}><Plus size={16}/></button>
    </div>
    {error && <p role="alert" className="p-3 text-sm text-danger">{error}</p>}
    {task && bot ? <SideThread key={id} botId={bot.id} threadId={id} visible={visible} onOpen={() => openThread(dispatch, { botId: bot.id, threadId: id }, state)}/> : <p className="p-4 text-sm text-ink-secondary">Choose a thread or start a side chat.</p>}
  </div>;
}

/** The terminal remains mounted while another tool is visible, so changing
 * tabs never kills a shell. Closing the entire panel releases its PTY. */
export function ToolsPanel({ target, onClose }: { target: TerminalTarget; onClose: () => void }) {
  const [active, setActive] = useState<ToolKind>("home");
  const [opened, setOpened] = useState<ToolKind[]>([]);
  const open = (kind: ToolKind) => { setOpened(current => current.includes(kind) ? current : [...current, kind]); setActive(kind); };
  return <section aria-label="Tools" data-testid="tools-panel" className="flex h-full min-w-0 flex-1 flex-col border-l border-hairline bg-app">
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline px-2">
      <button className={button} aria-label="Tools home" aria-pressed={active === "home"} onClick={() => setActive("home")}><LayoutGrid size={17}/></button>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">{opened.map(kind => <button key={kind} className={cn("shrink-0 rounded-md px-2 py-1.5 text-xs", active === kind ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised")} aria-pressed={active === kind} onClick={() => setActive(kind)}>{tools.find(t => t.kind === kind)?.name}</button>)}</div>
      <button className={button} aria-label="Close tools" onClick={onClose}><X size={16}/></button>
    </header>
    {active === "home" && <div className="p-5"><h2 className="mb-4 text-lg font-semibold">Tools</h2><div className="grid grid-cols-2 gap-2">{tools.map(tool => <button key={tool.kind} data-tool={tool.kind} className="flex min-h-14 items-center gap-3 rounded-xl bg-raised px-3 py-3 text-left text-sm hover:bg-raised/70" onClick={() => open(tool.kind)}><tool.icon size={18} className="shrink-0 text-ink-secondary"/>{tool.name}</button>)}</div></div>}
    {opened.map(kind => <div key={kind} className={cn("min-h-0 flex-1", active === kind ? "flex flex-col" : "hidden")}>
      {kind === "terminal" && <TerminalPanel target={target} onClose={onClose}/>}
      {kind === "files" && <FilesTool target={target}/>}
      {kind === "browser" && <BrowserTool visible={active === kind}/>}
      {kind === "page" && <PageTool target={target}/>}
      {kind === "side-chat" && <SideChatTool target={target} visible={active === kind}/>}
    </div>)}
  </section>;
}
