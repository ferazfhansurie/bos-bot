import { createElement, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, LayoutGrid, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { TerminalPanel } from "./TerminalPanel";
import { type TerminalTarget } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { browserAddress, browserSupported, type ToolKind } from "@/lib/tools-panel";

type WebGuest = HTMLElement & { goBack(): void; goForward(): void; reload(): void; getURL(): string; getTitle(): string };
const button = "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";
const tools = [
  { kind: "terminal", name: "Terminal", icon: SquareTerminal },
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

function BrowserUnavailable({ visible }: { visible: boolean }) {
  const desktop = Boolean(window.ogb);
  return <div role="status" className={cn("flex h-full flex-col items-center justify-center gap-2 p-6 text-center", !visible && "hidden")}>
    <Globe size={22} className="text-ink-secondary"/>
    <p className="text-sm">{desktop ? "This desktop app is too old for the browser." : "The browser works in the BOS desktop app."}</p>
    {desktop && <p className="max-w-64 text-xs text-ink-secondary">Install the full BOS Bot download, then reopen Tools. An in-app update alone keeps the old app.</p>}
  </div>;
}

function BrowserTool({ visible }: { visible: boolean }) {
  return browserSupported(window.ogb) ? <BrowserTabs visible={visible}/> : <BrowserUnavailable visible={visible}/>;
}

function BrowserTabs({ visible }: { visible: boolean }) {
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
    {active === "home" && <div className="p-5"><h2 className="ui-panel-title mb-4">Tools</h2><div className="grid grid-cols-2 gap-2">{tools.map(tool => <button key={tool.kind} data-tool={tool.kind} className="flex min-h-14 items-center gap-3 rounded-xl bg-raised px-3 py-3 text-left text-sm hover:bg-raised/70" onClick={() => open(tool.kind)}><tool.icon size={18} className="shrink-0 text-ink-secondary"/>{tool.name}</button>)}</div></div>}
    {opened.map(kind => <div key={kind} className={cn("min-h-0 flex-1", active === kind ? "flex flex-col" : "hidden")}>
      {kind === "terminal" && <TerminalPanel target={target} onClose={onClose}/>}
      {kind === "browser" && <BrowserTool visible={active === kind}/>}
    </div>)}
  </section>;
}
