import { Menu, anchorOf, type MenuAnchor, type MenuEntry } from '@/components/workbench/Menu';
import { NewTabPage } from '@/components/workbench/NewTabPage';
import { usePickTool, useNewTabExtras } from '@/components/workbench/builtins';
import { browserTabsSnapshot, handleBrowserCommands, publishBrowserTabs, sendBrowserCommand } from '@/components/workbench/browser-tabs';
import { useWorkspace } from '@/components/workspace/WorkspaceContext';
import { useTabKinds } from '@/components/workbench/registry';
import { browserCommand } from '../../electron/browser-keybindings.mjs';
import { BrowserSitePermissions } from './BrowserSitePermissions';
import { type MouseEvent, createElement, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Download, Globe, History, KeyRound, Maximize2, Minimize2, MoreHorizontal, Plus, Shield, RefreshCw, Search, Settings, Star, X, PanelLeft, Share, Copy, Folder, SquareTerminal, Play, Mail, Github, MousePointer2, Minus, Printer, Camera, Monitor, Smartphone, ZoomIn, Check, Pencil, Trash2 } from 'lucide-react';
import { browserSuggestions, browserStartSites, siteName } from '@/lib/browser-suggestions';
import { MausAvatar, type MausAvatarHandle } from './Avatar';
import './PrimaryBrowser.css';
import { browserAddress } from '@/lib/tools-panel';
import { cn } from '@/lib/cn';
import type { TerminalTarget } from '@/lib/terminal';
import type { BrowserAgentCommand, BrowserAgentState, BrowserLibrary, BrowserProfile, BrowserTab, ChromePreview } from '@/lib/primary-browser-types';

const button = 'rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30';
const field = 'min-w-0 rounded-lg border border-hairline bg-raised px-3 py-2 text-sm outline-none';
// Webviews stay mounted for the most recently shown tabs only; restoring 100
// saved tabs must not load 100 pages. Tabs the bot holds always stay live.
const LIVE_TABS = 32;
const newTab = (): BrowserTab => ({ id: crypto.randomUUID(), title: 'New tab', url: 'about:blank' });
type Guest = HTMLElement & { loadURL(url: string): Promise<void>; getURL(): string; getTitle(): string; getWebContentsId(): number; canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void; reload(): void; reloadIgnoringCache(): void; stop(): void; findInPage(text: string, options?: {forward?:boolean;findNext?:boolean}): void; stopFindInPage(action: string): void; setZoomFactor(factor: number): void; getZoomFactor(): number; openDevTools(): void; print(): void };
type PageState = { favicon?: string; loading: boolean; back: boolean; forward: boolean; error: string };
function BrowserGuest({ tab, partition, onState }: { tab: BrowserTab; partition: string; onState: (id: string, state: PageState, url: string, title: string) => void }) {
  const ref = useRef<Guest | null>(null), callback = useRef(onState), initial = useRef(tab.url); callback.current = onState;
  useEffect(() => { const el = ref.current; if (!el) return; try { if (el.getURL() && el.getURL() !== tab.url) void el.loadURL(tab.url).catch(() => {}); } catch { /* attaching */ } }, [tab.url]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let loading = false, error = '', favicon = '';
    const update = () => { try { callback.current(tab.id, { favicon, loading, error, back: el.canGoBack(), forward: el.canGoForward() }, el.getURL(), el.getTitle()); } catch { /* guest attaching */ } };
    const start = () => { loading = true; error = ''; update(); }, stop = () => { loading = false; update(); };
    const fail = (event: Event) => { const e = event as Event & { isMainFrame?: boolean; errorCode?: number }; if (e.isMainFrame !== false && e.errorCode !== -3) { error = 'This page could not load. Try reloading.'; loading = false; update(); } };
    const favicons = (event: Event) => { const url = (event as Event & { favicons?: string[] }).favicons?.[0]; if (url && /^https?:|^data:image\//i.test(url)) { favicon = url; update(); } };
    el.addEventListener('page-favicon-updated', favicons);
    const events = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready'];
    events.forEach(e => el.addEventListener(e, update)); el.addEventListener('did-start-loading', start); el.addEventListener('did-stop-loading', stop); el.addEventListener('did-fail-load', fail);
    return () => { el.removeEventListener('page-favicon-updated', favicons); events.forEach(e => el.removeEventListener(e, update)); el.removeEventListener('did-start-loading', start); el.removeEventListener('did-stop-loading', stop); el.removeEventListener('did-fail-load', fail); };
  }, [tab.id]);
  return createElement('webview', { ref, src: initial.current, partition, allowpopups: "true", className: 'h-full w-full', style: { flex: 1 } });
}

/** A profile's badge: its initial on a colour fixed by its id, like chrome's avatar. */
export function profileHue(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function ProfileAvatar({ profile, size = 20 }: { profile: BrowserProfile; size?: number }) {
  return <span aria-hidden className="browser-profile-avatar" style={{ width: size, height: size, fontSize: Math.round(size * .5), background: `hsl(${profileHue(profile.id)} 50% 46%)` }}>{[...profile.name.trim()][0]?.toUpperCase() || '?'}</span>;
}
type ProfileSwitcher = { profiles: BrowserProfile[]; select: (id: string) => void; add: () => void; manage: () => void };

export function PrimaryBrowser({ visible=true, integrated=false, expanded, onExpand, target, onTool, onClose }: { visible?:boolean; integrated?:boolean; expanded: boolean; onExpand: () => void; target: TerminalTarget; onTool: (tool: "terminal" | "files") => void; onClose: () => void }) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [selected, setSelected] = useState(''), [visited, setVisited] = useState<string[]>([]), [error, setError] = useState('');
  const [name, setName] = useState(''), [creating, setCreating] = useState(false), [managing, setManaging] = useState(false), [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { let live = true; void window.ogb?.primaryBrowser?.action('profiles').then(data => { if (!live) return; setProfiles(data.profiles); setSelected(data.selected); setVisited([data.selected]); }).catch(() => { if (live) setError('Browser profiles could not load. Your saved data has not been reset.'); }); return () => { live = false; }; }, []);
  const select = async (id: string) => { try { await window.ogb!.primaryBrowser!.action('select', { profileId: id }); setSelected(id); setVisited(ids => ids.includes(id) ? ids : [...ids, id]); setError(''); } catch { setError('Could not switch browser profile.'); } };
  const rename = async (id: string, value: string) => { try { const p = await window.ogb!.primaryBrowser!.action('rename', { profileId: id, name: value }) as BrowserProfile; setProfiles(all => all.map(x => x.id === id ? p : x)); setRenaming(null); setError(''); } catch { setError('Could not rename this browser profile.'); } };
  // Main asks for confirmation natively; null means the person cancelled.
  const remove = async (id: string) => {
    try {
      const next = await window.ogb!.primaryBrowser!.action('delete', { profileId: id }) as { profiles: BrowserProfile[]; selected: string } | null;
      if (!next) return;
      setProfiles(next.profiles); setSelected(next.selected); setVisited(ids => { const kept = ids.filter(x => x !== id); return kept.includes(next.selected) ? kept : [...kept, next.selected]; }); setRenaming(null); setError('');
    } catch (e) { setError(e instanceof Error && /bot/.test(e.message) ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not delete this browser profile.'); }
  };
  const switcher: ProfileSwitcher = { profiles, select: id => void select(id), add: () => { setManaging(true); setCreating(true); }, manage: () => setManaging(true) };
  return <div className="relative flex h-full min-h-0 flex-1 flex-col" data-testid="primary-browser">
    {managing && <div className="browser-sheet z-20" role="dialog" aria-label="Browser profiles"><div className="flex items-center justify-between mb-3"><span className="text-sm font-medium">Profiles</span><button className={button} aria-label="Close profiles" onClick={()=>{setManaging(false);setCreating(false);setRenaming(null);}}><X size={15}/></button></div>
      <ul className="browser-profile-list" aria-label="Browser profiles">{profiles.map(p => <li key={p.id} className={cn(p.id === selected && 'is-current')}>
        {renaming?.id === p.id ? <form className="flex min-w-0 flex-1 gap-2" onSubmit={e=>{e.preventDefault();void rename(p.id, renaming.name);}}><input autoFocus aria-label={`Rename ${p.name}`} className={`${field} min-w-0 flex-1 py-1`} value={renaming.name} maxLength={60} onChange={e=>setRenaming({ id: p.id, name: e.target.value })} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setRenaming(null);}}}/><button className={button} disabled={!renaming.name.trim()}>Save</button></form> : <>
        <button className="browser-profile-pick" aria-current={p.id === selected ? 'true' : undefined} onClick={()=>void select(p.id)}><ProfileAvatar profile={p}/><span className="truncate">{p.name}</span>{p.id === selected && <Check size={14} className="ml-auto shrink-0 text-accent"/>}</button>
        <button className={button} aria-label={`Rename ${p.name}`} title="Rename" onClick={()=>setRenaming({ id: p.id, name: p.name })}><Pencil size={14}/></button>
        <button className={button} aria-label={`Delete ${p.name}`} title={profiles.length <= 1 ? 'Keep at least one profile' : 'Delete profile'} disabled={profiles.length <= 1} onClick={()=>void remove(p.id)}><Trash2 size={14}/></button></>}
      </li>)}</ul>
      <button className={cn(button, 'mt-2 flex items-center gap-2 text-sm')} aria-label="Add browser profile" onClick={()=>setCreating(v=>!v)}><Plus size={14}/>Add profile</button>{creating && <form className="flex gap-2 mt-3" onSubmit={e=>{e.preventDefault();void(async()=>{try{const p=await window.ogb!.primaryBrowser!.action('create',{name});setProfiles(all=>[...all,p]);await select(p.id);setName('');setCreating(false);}catch{setError('Could not create this browser profile.');}})();}}><input autoFocus aria-label="New browser profile name" placeholder="Personal, work or a client" value={name} onChange={e=>setName(e.target.value)} className={`${field} flex-1`} maxLength={60}/><button className={button} disabled={!name.trim()}>Create</button></form>}</div>}
    {error && <p role="alert" className="p-3 text-xs text-danger">{error}</p>}
    {visited.filter(id => profiles.some(p => p.id === id)).map(id => <div key={id} className={cn('flex min-h-0 flex-1 flex-col', id !== selected && 'browser-parked browser-idle')}><ProfileBrowser integrated={integrated} profile={profiles.find(p => p.id === id)!} selected={id === selected} enabled={visible&&id === selected} target={target} expanded={expanded} onExpand={onExpand} onTool={onTool} onClose={onClose} onProfiles={()=>setManaging(true)} switcher={switcher} /></div>)}
  </div>;
}

function ProfileBrowser({ integrated, profile, selected, enabled, expanded, onExpand, onTool, onClose, onProfiles, switcher }: { switcher: ProfileSwitcher; profile: BrowserProfile; selected: boolean; enabled: boolean; target: TerminalTarget; expanded: boolean; onExpand: () => void; onTool: (tool: "terminal" | "files") => void; onClose: () => void; onProfiles: () => void; integrated: boolean }) {
  const bridge = window.ogb!.primaryBrowser!;
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null); const [profileMenu, setProfileMenu] = useState<MenuAnchor | null>(null);
  const [library, setLibrary] = useState<BrowserLibrary | null>(null), [tabs, setTabs] = useState<BrowserTab[]>([]), [active, setActive] = useState(''), [error, setError] = useState('');
  const [address, setAddress] = useState(''), [pages, setPages] = useState<Record<string, PageState>>({}), [panel, setPanel] = useState<string | null>(null), [find, setFind] = useState<string | null>(null), [filter, setFilter] = useState(''), [zoom, setZoom] = useState(1);
  const [sources, setSources] = useState<BrowserProfile[]>([]), [source, setSource] = useState(''), [preview, setPreview] = useState<ChromePreview | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [importBookmarks, setImportBookmarks] = useState(true), [importHistory, setImportHistory] = useState(false), [importTabs, setImportTabs] = useState(false), [importCookies,setImportCookies] = useState(false);
  const [agent, setAgent] = useState<BrowserAgentState['tabs']>({}), [recent, setRecent] = useState<string[]>([]);
  const [addressFocused, setAddressFocused] = useState(false), [suggestionsOpen, setSuggestionsOpen] = useState(false), [suggestionIndex, setSuggestionIndex] = useState(-1), [favouriteURL,setFavouriteURL] = useState(''), [favouriteName,setFavouriteName] = useState('');
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(timer);},[notice]);
  const [passwords, setPasswords] = useState<{ id: string; origin: string; username: string; botSignIn: boolean }[]>([]);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), closed = useRef<BrowserTab[]>([]), ready = useRef(false);
  const tab = tabs.find(t => t.id === active), current = pages[active];
  const call = useCallback((action: string, data: Record<string, unknown> = {}) => bridge.action(action, { ...data, profileId: profile.id }), [bridge, profile.id]);
  const reloadLibrary = useCallback(async () => { const data = await bridge.action('read', { profileId: profile.id }); setLibrary(data); return data; }, [bridge, profile.id]);
  useEffect(() => { let live = true; void reloadLibrary().then(d => { if (!live) return; const initial = d.tabs.length ? d.tabs : [newTab()]; setTabs(initial); setActive(d.active || initial[0].id); ready.current = true; }).catch(() => { if (live) setError('Saved browser data could not load. It has not been reset.'); }); return () => { live = false; ready.current = false; }; }, [reloadLibrary]);
  useEffect(() => { if (!ready.current) return; const timer = setTimeout(() => { void call('tabs', { state: { tabs, active } }).catch(() => setError('Could not save your tabs.')); }, 150); return () => clearTimeout(timer); }, [tabs, active, call]);
  useEffect(() => { setAddress(tab?.url === 'about:blank' ? '' : tab?.url || ''); setFind(null); setZoom(1); requestAnimationFrame(()=>{try{const el=root.current?.querySelector(`[data-primary-tab="${active}"] webview`) as Guest|null;if(el)setZoom(el.getZoomFactor());}catch{/* attaching */}}); setError(''); setPasswords([]); }, [active]);
  useEffect(() => { if (document.activeElement !== input.current) setAddress(tab?.url === 'about:blank' ? '' : tab?.url || ''); }, [tab?.url]);
  const guest = () => root.current?.querySelector(`[data-primary-tab="${active}"] webview`) as Guest | null;
  const guestId = () => { try { return guest()?.getWebContentsId(); } catch { return undefined; } };
  const add = (item = newTab(), background = false) => { if (tabs.length >= 100) { setError('Close a tab before opening another.'); return; } setTabs(all => [...all, item]); if (!background) { setActive(item.id); setPanel(null); if (item.url==='about:blank') setTimeout(() => input.current?.focus(), 0); } };
  const close = (id = active) => { setTabs(all => { const at = all.findIndex(t => t.id === id); const closing = all[at]; if (closing) closed.current = [closing, ...closed.current].slice(0, 20); const next = all.filter(t => t.id !== id); if (!next.length) next.push(newTab()); if (id === active) setActive(next[Math.min(Math.max(0, at), next.length - 1)].id); return next; }); };
  const open = (url: string, event?:MouseEvent<HTMLButtonElement>) => { const clean = browserAddress(url); if (!clean) { setError('Enter a web address or search.'); return; } const modified = Boolean(event&&(event.metaKey||event.ctrlKey||event.button===1)), botsOwn = agent[active]?.mode === 'bot' && agent[active]?.own === true; if (agent[active]?.mode === 'bot' && !botsOwn && !modified) person('agent-take-over'); if(modified){event!.preventDefault();add({id:crypto.randomUUID(),title:'Loading…',url:clean},!event!.shiftKey);return;} if(botsOwn){add({id:crypto.randomUUID(),title:'Loading…',url:clean});setSuggestionsOpen(false);input.current?.blur();return;} setTabs(all => all.map(t => t.id === active ? { ...t, url: clean, title: 'Loading…' } : t)); setAddress(clean); setSuggestionsOpen(false); input.current?.blur(); setPanel(null); };
  const shortcut = (command: string) => {
    const el=guest();
    if (command==='address') { input.current?.focus(); input.current?.select(); }
    else if (command==='new-tab') add();
    else if (command==='reopen-tab') { const item=closed.current.shift(); if(item)add({...item,id:crypto.randomUUID()}); }
    else if (command==='close-tab') close();
    else if (command==='find') setFind('');
    else if (command==='reload') el?.reload();
    else if (command==='hard-reload') el?.reloadIgnoringCache();
    else if (command==='back'&&el?.canGoBack()) el.goBack();
    else if (command==='forward'&&el?.canGoForward()) el.goForward();
    else if (command==='next-tab'||command==='previous-tab') { const ordered=[...tabs].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))); const at=ordered.findIndex(t=>t.id===active); const next=ordered[(at+(command==='next-tab'?1:-1)+ordered.length)%ordered.length]; if(next)setActive(next.id); }
    else if (/^tab-[1-9]$/.test(command)) { const ordered=[...tabs].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))); const t=command==='tab-9'?ordered.at(-1):ordered[Number(command.slice(4))-1];if(t)setActive(t.id); }
    else if(command.startsWith('zoom-')) { const next=command==='zoom-reset'?1:Math.max(.5,Math.min(3,Math.round((zoom+(command==='zoom-in'?.1:-.1))*10)/10));setZoom(next);el?.setZoomFactor(next); }
    else if(command==='find-next'||command==='find-previous') {if(find)el?.findInPage(find,{forward:command==='find-next',findNext:true});else setFind('');}
    else if(command==='bookmark') {if(tab&&tab.url!=='about:blank')void run('bookmark',{title:tab.title,url:tab.url});}
    else if(command==='downloads') void showPanel('downloads');
    else if(command==='history') void showPanel('history');
    else if(command==='print') el?.print();
    else if(command==='developer-tools') el?.openDevTools();
  };
  const shortcutRef = useRef(shortcut); shortcutRef.current = shortcut;
  const addRef=useRef(add);addRef.current=add;
  useEffect(()=>window.ogb?.onToolsBrowserPopup?.((url,source)=>{if(source?.partition!==library?.partition)return;addRef.current({id:crypto.randomUUID(),title:'Loading…',url},source?.background===true);}),[library?.partition]);
  useEffect(() => bridge.onShortcut(e => { if (enabled && e.partition === library?.partition) {const command=e.command||browserCommand({key:e.key,shift:e.shift,meta:true});if(command)shortcutRef.current(command);} }), [bridge, enabled, library?.partition]);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if (!enabled || !root.current?.contains(document.activeElement)) return; const command=browserCommand(e);if(command){e.preventDefault();shortcutRef.current(command);} }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [enabled]);
  useEffect(() => window.ogb?.onToolsBrowserDownload?.(download => { if (download.partition === library?.partition) setLibrary(d => d ? { ...d, downloads: [download, ...d.downloads.filter(x => x.id !== download.id)].slice(0, 200) } : d); }), [library?.partition]);
  useEffect(()=>{
    const el=root.current;if(!el||!enabled)return;
    const update=()=>{void call('browser-focus',{focused:el.contains(document.activeElement)}).catch(()=>{});};
    const leave=()=>queueMicrotask(update);el.addEventListener('focusin',update);el.addEventListener('focusout',leave);
    return()=>{el.removeEventListener('focusin',update);el.removeEventListener('focusout',leave);void call('browser-focus',{focused:false}).catch(()=>{});};
  },[enabled,library?.partition,call]);
  // The bot drives these same tabs. Main mirrors the strip from these reports
  // and sends commands back; agent state says which tabs it holds.
  useEffect(() => bridge.onAgentState(state => setAgent(state.tabs ?? {})), [bridge]);
  useEffect(() => { if (active) setRecent(ids => ids[0] === active ? ids : [active, ...ids.filter(id => id !== active)].slice(0, LIVE_TABS)); }, [active]);
  useEffect(() => {
  if (!library) return;
    const timer = setTimeout(() => {
      const guestOf = (id: string) => { try { const el = root.current?.querySelector(`[data-primary-tab="${id}"] webview`) as Guest | null; const n = el?.getWebContentsId(); return typeof n === 'number' && n > 0 ? n : undefined; } catch { return undefined; } };
      void call('agent-tabs', { selected, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, guestId: guestOf(t.id) })), active }).catch(() => {});
    }, 80);
    return () => clearTimeout(timer);
  }, [library, selected, tabs, active, pages, recent, call]);
  useEffect(() => () => { void bridge.action('agent-tabs', { profileId: profile.id, mounted: false }).catch(() => {}); }, [bridge, profile.id]);
  const closeRef = useRef<(id: string) => void>(() => {}); closeRef.current = close;
  const shownRef = useRef<BrowserTab | undefined>(undefined); shownRef.current = tab;
  useEffect(() => bridge.onAgentCommand((command: BrowserAgentCommand) => {
    if (command.profileId !== profile.id || typeof command.tabId !== 'string') return;
    // The bot's tabs open behind the person's page; only an empty start page gives way.
    if (command.op === 'new') { setTabs(all => all.some(t => t.id === command.tabId) || all.length >= 100 ? all : [...all, { id: command.tabId, title: 'Loading…', url: command.url || 'about:blank' }]); if (!command.background || !shownRef.current || shownRef.current.url === 'about:blank') { setActive(command.tabId); setPanel(null); } }
    else if (command.op === 'activate') setTabs(all => { if (all.some(t => t.id === command.tabId)) setActive(command.tabId); return all; });
    else if (command.op === 'navigate' && command.url) setTabs(all => all.map(t => t.id === command.tabId ? { ...t, url: command.url!, title: 'Loading…' } : t));
    else if (command.op === 'close') closeRef.current(command.tabId);
  }), [bridge, profile.id]);
  useEffect(() => {
    if (!integrated || !selected) return;
    publishBrowserTabs({ tabs: tabs.map(t => ({ ...t, favicon: pages[t.id]?.favicon, loading: pages[t.id]?.loading, agent: agent[t.id]?.mode === 'bot' ? 'bot' : agent[t.id] ? 'person' : undefined })), active });
  }, [integrated, selected, tabs, active, pages, agent]);
  useEffect(() => {
    if (!integrated || !selected) return;
    return () => publishBrowserTabs(null);
  }, [integrated, selected]);
  const stripCommand = useRef<(command: import('@/components/workbench/browser-tabs').BrowserTabCommand) => void>(() => {});
  stripCommand.current = command => {
    const item = 'id' in command ? tabs.find(t => t.id === command.id) : undefined;
    if (command.op === 'new') {
      if (command.reuseBlank && tabs.length===1 && tabs[0].url==='about:blank') {setActive(tabs[0].id);setPanel(null);return;}
      const next = { ...newTab(), ...(command.url ? {url: command.url} : {}) };
      if (tabs.length >= 100) return setError('Close a tab before opening another.');
      setTabs(all => { const at = command.after ? all.findIndex(t => t.id === command.after) : -1; return at < 0 ? [...all, next] : [...all.slice(0, at + 1), next, ...all.slice(at + 1)]; });
      if (!command.background) { setActive(next.id); setPanel(null); }
    } else if (item) {
      if (command.op === 'activate') { setActive(item.id); setPanel(null); }
      else if (command.op === 'close') close(item.id);
      else if (command.op === 'duplicate') add({...item, id: crypto.randomUUID()});
      else if (command.op === 'copy-url') void navigator.clipboard.writeText(item.url).catch(() => setError('Could not copy this URL.'));
      else if (command.op === 'external') window.ogb?.openExternal?.(item.url);
      else if (command.op === 'reload') (root.current?.querySelector(`[data-primary-tab="${item.id}"] webview`) as Guest | null)?.reload();
      else if (command.op === 'close-others' || command.op === 'close-right') {
        const at = tabs.indexOf(item);
        const kept = command.op === 'close-others' ? [item] : tabs.slice(0, at + 1);
        closed.current = [...tabs.filter(t => !kept.includes(t)), ...closed.current].slice(0, 20);
        setTabs(kept); if (!kept.some(t => t.id === active)) setActive(item.id);
      }
    }
  };
  useEffect(() => {
    if (!integrated || !selected || !library) return;
    return handleBrowserCommands(command => stripCommand.current(command));
  }, [integrated, selected, Boolean(library)]);
  const person = (action: 'agent-take-over' | 'agent-give-back' | 'agent-stop', tabId = active) => { void bridge.action(action, { tabId }).catch(() => setError('Could not change who controls the browser.')); };
  useEffect(() => bridge.onExternalURL(value => { if (value.profileId===profile.id && !value.reveal) void reloadLibrary().then(d=>{setTabs(d.tabs);setActive(d.active);setPanel(null);}); }), [bridge,profile.id,reloadLibrary]);
  const update = useCallback((id: string, state: PageState, url: string, title: string) => { setPages(p => ({ ...p, [id]: state })); if (url) setTabs(all => all.map(t => t.id === id && (t.url !== url || (title && t.title !== title)) ? { ...t, url, title: title || t.title } : t)); }, []);
  const run = async (action: string, data: Record<string, unknown> = {}) => { if (busy) return; setBusy(true); setError(''); try { if (['inspect-element','device-toolbar'].includes(action) && agent[active]?.mode === 'bot') await bridge.action('agent-take-over',{tabId:active}); const result = await call(action, data); const fresh = await reloadLibrary(); if (result && (['undo-import','restore-library'].includes(action)||(action==='import-chrome'&&Array.isArray(data.categories)&&data.categories.includes('tabs')))) { const next=fresh.tabs.length?fresh.tabs:[newTab()]; setTabs(next);setActive(fresh.active||next[0].id); } return result; } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'This browser action failed.'); } finally { setBusy(false); } };
  const showPanel = async (name: string) => { setPanel(panel === name ? null : name); setFilter(''); setError(''); if (name === 'bookmarks' || name === 'history' || name === 'settings') await reloadLibrary().catch(() => setError('Could not read the browser library.')); if (name === 'import') { try { const p = await bridge.action('chrome-profiles'); setSources(p); setSource(p[0]?.id ?? ''); setPreview(null); } catch { setError('Could not find chrome profiles.'); } } if (name === 'passwords') { try { const el = guest(); if (el) setPasswords(await bridge.action('passwords', { profileId: profile.id, guestId: el.getWebContentsId() })); } catch { setError('Secure password storage is unavailable.'); } } };
  useEffect(()=>{if(!panel)return;const dismiss=(e:KeyboardEvent)=>{if(e.key==='Escape')setPanel(null);};window.addEventListener('keydown',dismiss);return()=>window.removeEventListener('keydown',dismiss);},[panel]);
  useEffect(()=>{if(panel!=='privacy')return;let live=true;const update=()=>void call('blocker-status',{guestId:guestId()}).then(data=>{if(live)setLibrary(all=>all?{...all,blocker:data as BrowserLibrary['blocker']}:all);}).catch(()=>{});update();const timer=setInterval(update,1000);return()=>{live=false;clearInterval(timer);};},[panel,active,call]);
  const suggestions = library ? browserSuggestions([...library.bookmarks,...library.history],address) : [];
  const filtered = (panel === 'history' ? library?.history : library?.bookmarks)?.filter(e => `${e.title} ${e.url} ${e.folder || ''}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 150) ?? [];
  const hasPage = Boolean(tab && tab.url !== 'about:blank' && current);
  const menuEntries: MenuEntry[] = [
    { key:'find', label:'Find in page', icon:Search, shortcut:'⌘F', onSelect:()=>setFind('') },
    { key:'print', label:'Print', icon:Printer, shortcut:'⌘P', disabled:!hasPage, onSelect:()=>guest()?.print() },
    { type:'separator', key:'s-zoom' },
    { type:'custom', key:'zoom', render:()=> <div className="flex h-8 items-center gap-2 px-2 text-[13px]"><span className="flex-1">Zoom</span><button aria-label="Zoom out" className={button} onClick={()=>shortcut('zoom-out')}><Minus size={14}/></button><button aria-label="Reset zoom" onClick={()=>shortcut('zoom-reset')}>{Math.round(zoom*100)}%</button><button aria-label="Zoom in" className={button} onClick={()=>shortcut('zoom-in')}><Plus size={14}/></button></div> },
    { key:'devices', label:'Device toolbar', icon:Monitor, disabled:!hasPage, submenu:[
      { key:'desktop', label:'Desktop', icon:Monitor, onSelect:()=>void run('device-toolbar',{guestId:guestId(),device:'desktop'}) },
      { key:'mobile', label:'Mobile · 390 × 844', icon:Smartphone, onSelect:()=>void run('device-toolbar',{guestId:guestId(),device:'mobile'}) },
      { key:'tablet', label:'Tablet · 820 × 1180', onSelect:()=>void run('device-toolbar',{guestId:guestId(),device:'tablet'}) },
    ] },
    { key:'screenshot', label:'Take a screenshot', icon:Camera, disabled:!hasPage, onSelect:()=>void run('screenshot',{guestId:guestId()}) },
    { type:'separator', key:'s-data' },
    { key:'import', label:'Import cookies and passwords…', onSelect:()=>void showPanel('import') },
    { key:'passwords', label:'Passwords and autofill', icon:KeyRound, submenu:[{key:'saved',label:'Saved passwords',onSelect:()=>void showPanel('passwords')},{key:'import-passwords',label:'Import passwords…',onSelect:()=>void run('import-passwords')}] },
    { key:'downloads', label:'Downloads', icon:Download, onSelect:()=>void showPanel('downloads') },
    { key:'history', label:'History', icon:History, onSelect:()=>void showPanel('history') },
    { key:'clear', label:'Clear browsing data', onSelect:()=>void showPanel('clear') },
    { type:'separator', key:'s-settings' },
    { key:'profiles', label:'Browser profiles', onSelect:onProfiles },
    { key:'bookmarks', label:'Bookmarks', icon:BookOpen, onSelect:()=>void showPanel('bookmarks') },
    ...(library?.blocker ? [{key:'privacy',label:'Privacy protection',icon:Shield,onSelect:()=>void showPanel('privacy')}] : []),
    { key:'settings', label:'Browser settings', icon:Settings, onSelect:()=>void showPanel('settings') },
  ];
  if (!library) return <p role="status" className="p-4 text-sm text-ink-secondary">{error || 'Opening your browser…'}</p>;
  return <div ref={root} className="relative flex min-h-0 flex-1 flex-col">
    <form className={cn("browser-toolbar", integrated && "workbench-browser-toolbar")} onSubmit={e=>{e.preventDefault();open(address);}}>
      {!integrated && <button type="button" className={button} aria-label="Workspace tools" onClick={()=>setPanel(panel==='tools'?null:'tools')}><PanelLeft size={17}/></button>}
      {integrated ? <><div className="flex h-8 shrink-0 items-center rounded-full bg-ink/[.06] px-1">
        <button type="button" className={button} aria-label="Browser back" disabled={!current?.back} onClick={()=>guest()?.goBack()}><ArrowLeft size={16}/></button>
        <button type="button" className={button} aria-label="Browser forward" disabled={!current?.forward} onClick={()=>guest()?.goForward()}><ArrowRight size={16}/></button>
        <span className="mx-1 h-4 w-px bg-ink/[.12]"/><button type="button" className={button} aria-label="Reload browser" onClick={()=>current?.loading?guest()?.stop():guest()?.reload()}>{current?.loading?<X size={16}/>:<RefreshCw size={16}/>}</button>
      </div><button type="button" className={button} aria-label="Select element" disabled={!hasPage} onClick={()=>void run('inspect-element',{guestId:guestId()})}><MousePointer2 size={16}/></button></> : <>
      <button type="button" className={button} aria-label="Browser back" disabled={!current?.back} onClick={()=>guest()?.goBack()}><ArrowLeft size={16}/></button><button type="button" className={button} aria-label="Browser forward" disabled={!current?.forward} onClick={()=>guest()?.goForward()}><ArrowRight size={16}/></button>
      </>}
      <div className="browser-address"><input ref={input} aria-label="Search or enter a URL" autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={addressFocused&&suggestionsOpen&&suggestions.length>0} aria-controls={`browser-suggestions-${profile.id}`} aria-activedescendant={suggestionsOpen&&suggestionIndex>=0?`browser-option-${profile.id}-${suggestionIndex}`:undefined} placeholder="Search or enter a URL" title={tab?.url === "about:blank" ? undefined : tab?.url} value={addressFocused?address:displayAddress(tab?.url)} onFocus={()=>{setAddressFocused(true);setAddress(tab?.url==='about:blank'?'':tab?.url||'');}} onChange={e=>{setAddress(e.target.value);setSuggestionsOpen(true);setSuggestionIndex(-1);}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setSuggestionsOpen(false);setSuggestionIndex(-1);}else if(suggestionsOpen&&suggestions.length&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();setSuggestionIndex(i=>e.key==='ArrowDown'?(i+1)%suggestions.length:i<0?suggestions.length-1:(i-1+suggestions.length)%suggestions.length);}else if(e.key==='Enter'&&suggestionsOpen&&suggestionIndex>=0&&suggestions[suggestionIndex]){e.preventDefault();open(suggestions[suggestionIndex].url);}}} onBlur={()=>{setSuggestionsOpen(false);setSuggestionIndex(-1);setAddressFocused(false);setAddress(tab?.url==='about:blank'?'':tab?.url||'');}}/>{Math.round(zoom*100)!==100&&<button type="button" className="browser-zoom-chip" aria-label={`Zoom ${Math.round(zoom*100)}%. Reset to 100%`} title="Reset zoom (⌘ 0)" onMouseDown={e=>e.preventDefault()} onClick={()=>shortcut('zoom-reset')}><ZoomIn size={11}/>{Math.round(zoom*100)}%</button>}{!integrated && <button type="button" className={button} aria-label="Reload browser" onClick={()=>current?.loading?guest()?.stop():guest()?.reload()}><RefreshCw size={13} className={current?.loading?'animate-spin':''}/></button>}{addressFocused&&suggestionsOpen&&suggestions.length>0&&<div className="browser-suggestions" role="listbox" aria-label="Suggested sites" id={`browser-suggestions-${profile.id}`}>{suggestions.map((item,index)=><button key={item.url} type="button" role="option" aria-selected={index===suggestionIndex} id={`browser-option-${profile.id}-${index}`} onMouseDown={e=>e.preventDefault()} onClick={event=>open(item.url,event)} onAuxClick={event=>{if(event.button===1)open(item.url,event);}}><Globe size={15}/><span><strong>{item.title}</strong><small>{item.display}</small></span></button>)}</div>}</div>

      <button type="button" className="browser-profile-chip" aria-label={`Browser profile: ${profile.name}. Switch profile`} aria-haspopup="menu" aria-expanded={Boolean(profileMenu)} title={`${profile.name} · switch profile`} onClick={e=>setProfileMenu(anchorOf(e.currentTarget))}><ProfileAvatar profile={profile} size={18}/><span className="browser-profile-chip-name">{profile.name}</span></button>
      {integrated ? <button type="button" className={button} aria-label="Browser menu" onClick={e=>setMenuAnchor(anchorOf(e.currentTarget))}><MoreHorizontal size={17}/></button> : <>
      {library.blocker&&<button type="button" className={button} aria-label="Privacy protection" title="Ad and tracker blocking" onClick={()=>void showPanel('privacy')}><Shield size={16}/></button>}
      <button type="button" className={button} aria-label="Share browser page" onClick={()=>setPanel(panel==='share'?null:'share')}><Share size={16}/></button><button type="button" className={button} aria-label="New browser tab" onClick={()=>add()}><Plus size={17}/></button><button type="button" className={button} aria-label="Browser menu" onClick={()=>void showPanel('menu')}><MoreHorizontal size={17}/></button>
      </>}
    </form>
    {!integrated && <div className="browser-tabs">{[...tabs].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))).map(t=><div key={t.id} className={cn('browser-tab',active===t.id&&'is-active')}><button aria-pressed={active===t.id} onClick={()=>{setActive(t.id);setPanel(null);}}>{agent[t.id]&&<span className={cn('browser-agent-dot',agent[t.id].mode!=='bot'&&'is-paused')} aria-label={agent[t.id].mode==='bot'?'bot is using this tab':'you have control of this tab'} />}{t.pinned&&<Star size={11}/>}<span>{t.title==='Loading…'?displayAddress(t.url):t.title}</span></button><button className="browser-tab-close" aria-label={`Close ${t.title}`} onClick={()=>close(t.id)}><X size={11}/></button></div>)}</div>}
    {profileMenu && <Menu anchor={profileMenu} label="Browser profiles" align="end" width={240} onClose={()=>setProfileMenu(null)} entries={[
      { type:'label', key:'title', label:'Browser profile' },
      ...switcher.profiles.map(p => ({ key:p.id, label:p.name, checked:p.id === profile.id, onSelect:()=>{ if (p.id !== profile.id) switcher.select(p.id); } })),
      { type:'separator', key:'sep' },
      { key:'add', label:'Add profile', icon:Plus, onSelect:switcher.add },
      { key:'manage', label:'Manage profiles', icon:Settings, onSelect:switcher.manage },
    ]}/>}
    {menuAnchor && <Menu anchor={menuAnchor} label="Browser options" align="end" entries={menuEntries} onClose={()=>setMenuAnchor(null)} width={280}/> }
    {(error||current?.error)&&<p role="alert" className="shrink-0 px-3 py-2 text-xs text-danger">{error||current?.error}</p>}
    {notice&&<div role="status" className="browser-toast"><span>{notice}</span><button className={button} aria-label="Dismiss browser notice" onClick={()=>setNotice('')}><X size={13}/></button></div>}
    {find !== null && <div className="flex shrink-0 gap-2 border-b border-hairline p-2"><input autoFocus aria-label="Find text in page" className={`${field} flex-1`} value={find} onChange={e => { setFind(e.target.value); if (e.target.value) guest()?.findInPage(e.target.value); else guest()?.stopFindInPage('clearSelection'); }} onKeyDown={e => { if (e.key === 'Enter') guest()?.findInPage(find,{forward:!e.shiftKey,findNext:true}); if (e.key === 'Escape') { guest()?.stopFindInPage('clearSelection'); setFind(null); } }} /><button className={button} aria-label="Close find" onClick={() => { guest()?.stopFindInPage('clearSelection'); setFind(null); }}><X size={15} /></button></div>}
    {panel && <div className={cn('browser-sheet', ['menu','tools','share','privacy'].includes(panel) && 'browser-popover')} role="region" aria-label={`Browser ${panel}`}>
      <div className="mb-3 flex items-center justify-between"><p className="text-sm font-medium">{panel === 'tools' ? 'Workspace' : panel === 'share' ? 'Share' : panel === 'menu' ? 'Browser' : panel === 'import' ? 'Bring chrome into bos' : panel[0].toUpperCase() + panel.slice(1)}</p><button className={button} aria-label="Close browser menu" onClick={() => setPanel(null)}><X size={15} /></button></div>
      {panel === 'menu' && <div className="browser-menu-items"><button aria-label="Manage browser profiles" onClick={()=>{setPanel(null);onProfiles();}}><Globe size={16}/>{profile.name}<span className="ml-auto text-xs text-ink-secondary">Profile</span></button>{([{ name: 'bookmarks', icon: BookOpen }, { name: 'history', icon: History }, { name: 'downloads', icon: Download }, { name: 'passwords', icon: KeyRound }, { name: 'import', icon: Globe }, { name: 'settings', icon: Settings }] as const).map(({ name, icon: Icon }) => <button key={name} className="flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-raised" onClick={() => void showPanel(name)}><Icon size={16} />{name === 'import' ? 'Import chrome' : name[0].toUpperCase() + name.slice(1)}</button>)}<button className={button} onClick={() => { setPanel(null); setFind(''); }}><Search size={15} />Find in page</button><button className={button} onClick={()=>setPanel('shortcuts')}>Keyboard shortcuts</button><button className={button} onClick={() => { const factor = zoom >= 1.5 ? .75 : zoom + .25; setZoom(factor); guest()?.setZoomFactor(factor); }}>Zoom {Math.round(zoom * 100)}%</button><button className={button} onClick={() => setTabs(all => all.map(t => t.id === active ? { ...t, pinned: !t.pinned } : t))}>{tab?.pinned ? 'Unpin tab' : 'Pin tab'}</button><button className={button} onClick={() => add({ ...tab!, id: crypto.randomUUID() })}>Duplicate tab</button><button className={button} onClick={() => { guest()?.print(); setPanel(null); }}>Print / save PDF</button><button className={button} onClick={() => { guest()?.openDevTools(); setPanel(null); }}>Developer tools</button></div>}
      {panel==='add-favourite'&&<form className="flex flex-col gap-3" onSubmit={e=>{e.preventDefault();const url=browserAddress(favouriteURL);if(!url||url==='about:blank'){setError('Enter a site address.');return;}void run('bookmark',{url,title:favouriteName.trim()||siteName(new URL(url).hostname.replace(/^www\./,''))}).then(result=>{if(result!==undefined){setPanel(null);setFavouriteURL('');setFavouriteName('');setNotice('Added to favourites.');}});}}><input aria-label="Favourite site address" className={field} placeholder="Website address" value={favouriteURL} onChange={e=>setFavouriteURL(e.target.value)} required/><input aria-label="Favourite site name" className={field} placeholder="Name (optional)" value={favouriteName} onChange={e=>setFavouriteName(e.target.value)} maxLength={100}/><button className="rounded-lg bg-raised px-3 py-2 text-sm" disabled={busy}>Add favourite</button></form>}
      {panel==='tools'&&<div className="browser-menu-items"><button onClick={()=>{setPanel(null);onTool('terminal');}}><SquareTerminal size={16}/>Terminal</button><button onClick={()=>{setPanel(null);onTool('files');}}><Folder size={16}/>Files</button><button onClick={()=>{setPanel(null);onExpand();}}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>} {expanded?'Show chat beside browser':'Expand browser'}</button><button onClick={onClose}><X size={16}/>Close browser</button></div>}
      {panel==='share'&&<div className="browser-menu-items"><button aria-label="Bookmark page" disabled={busy||!tab||tab.url==='about:blank'} onClick={()=>void run('bookmark',{url:tab?.url,title:tab?.title}).then(()=>{setPanel(null);setNotice('Added to favourites.');})}><Star size={16}/>Add to favourites</button><button disabled={!tab||tab.url==='about:blank'} onClick={()=>void navigator.clipboard.writeText(tab?.url||'').then(()=>{setPanel(null);setNotice('Link copied.');}).catch(()=>setError('Could not copy the link.'))}><Copy size={16}/>Copy link</button></div>}
      {(panel === 'bookmarks' || panel === 'history') && <><input aria-label={`Search ${panel}`} placeholder={`Search ${panel}`} className={`${field} mb-3`} value={filter} onChange={e => setFilter(e.target.value)} />{panel === 'history' && <button className={`${button} mb-2 text-left`} disabled={busy} onClick={() => void run('clear-history')}>Clear browsing history</button>}{filtered.map(e => <div key={e.id} className="flex items-center gap-2 border-b border-hairline py-2"><button className="min-w-0 flex-1 text-left" onClick={event => open(e.url,event)} onAuxClick={event=>{if(event.button===1)open(e.url,event);}}><p className="truncate text-sm">{e.title}</p><p className="truncate text-xs text-ink-secondary">{e.folder ? `${e.folder} · ` : ''}{e.url}</p></button>{panel === 'bookmarks' && <button className={button} aria-label={`Remove ${e.title}`} disabled={busy} onClick={() => void run('remove-bookmark', { id: e.id })}><X size={12} /></button>}</div>)}{!filtered.length && <p className="text-sm text-ink-secondary">Nothing saved here yet.</p>}</>}
      {panel === 'downloads' && <>{library.downloads.map(d => <div key={d.id} className="border-b border-hairline py-3"><p className="truncate text-sm">{d.fileName}</p><p className="text-xs text-ink-secondary">{d.state === 'progressing' ? `${d.totalBytes ? Math.round(d.receivedBytes / d.totalBytes * 100) + '%' : Math.round(d.receivedBytes / 1024) + ' KB'}` : d.state}</p>{d.state === 'completed' && <div className="flex gap-2"><button className={button} onClick={() => void run('download-open', { id: d.id })}>Open</button><button className={button} onClick={() => void run('download-reveal', { id: d.id })}>Show in folder</button></div>}</div>)}{!library.downloads.length && <p className="text-sm text-ink-secondary">No downloads yet.</p>}</>}
      {panel === 'import' && <div className="flex flex-col gap-3"><p className="text-xs text-ink-secondary">Import into {profile.name}. Chrome stays unchanged. Logins may need signing in again.</p><label className="text-sm">Chrome profile<select aria-label="Chrome source profile" className={`${field} mt-2 w-full`} value={source} onChange={e => { setSource(e.target.value); setPreview(null); }}>{sources.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}</select></label>{!sources.length && <p className="text-xs text-ink-secondary">No local chrome profiles found.</p>}<button className="rounded-lg bg-raised p-3 text-sm" disabled={busy || !source} onClick={() => { void (async () => { setBusy(true); try { setPreview(await bridge.action('preview-chrome', { profileId: profile.id, sourceId: source })); } catch { setError('Could not preview this chrome profile.'); } finally { setBusy(false); } })(); }}>Preview import</button>{preview && <><label className="flex gap-2 text-sm"><input type="checkbox" checked={importBookmarks} onChange={e => setImportBookmarks(e.target.checked)} />{preview.bookmarks} bookmarks, with folders</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={importHistory} disabled={Boolean(preview.historyError)} onChange={e => setImportHistory(e.target.checked)} />{preview.history} history entries</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={importTabs} disabled={Boolean(preview.tabsError)} onChange={e=>setImportTabs(e.target.checked)}/>{preview.tabs} saved open tabs</label>{preview.tabsError && <p className="text-xs text-ink-secondary">{preview.tabsError}</p>}<label className="flex gap-2 text-sm"><input type="checkbox" checked={importCookies} disabled={Boolean(preview.cookiesError)} onChange={e=>setImportCookies(e.target.checked)}/>Saved logins ({preview.cookies} cookies; keychain confirmation required)</label>{preview.cookiesError && <p className="text-xs text-ink-secondary">{preview.cookiesError}</p>}{preview.historyError && <p className="text-xs text-danger">{preview.historyError}</p>}<button className="rounded-lg bg-accent p-3 text-sm text-app" disabled={busy || (!importBookmarks && !importHistory && !importTabs && !importCookies)} onClick={() => { void run('import-chrome', { token: preview.token, categories: [...(importBookmarks ? ['bookmarks'] : []), ...(importHistory ? ['history'] : []), ...(importTabs ? ['tabs'] : []), ...(importCookies ? ['cookies'] : [])] }).then(result => { if (result) { setPreview(null); const counts=result as {bookmarks:number;history:number;tabs:number;cookies?:{imported:number;skipped:number}};setNotice(`Imported ${counts.bookmarks} bookmarks, ${counts.history} history entries and ${counts.tabs} tabs.${counts.cookies?` ${counts.cookies.imported} cookies imported; ${counts.cookies.skipped} skipped. Some accounts may need signing in again.`:''}`); } }); }}>Import selected data</button></>}<div className="border-t border-hairline pt-3"><button className="rounded-lg bg-raised p-3 text-sm" disabled={busy} onClick={() => void run('import-passwords').then(r => { if (r) setNotice('Passwords imported into the encrypted vault. Use Passwords on a sign-in page to fill them.'); })}>Import passwords from CSV</button><p className="mt-2 text-xs text-ink-secondary">In chrome: password manager → settings → export passwords. Choose that file here. Bos offers to delete the readable export after import. Passkeys are separate.</p></div>{library.imports.map(batch => <button key={batch.id} className={`${button} text-left`} disabled={busy} onClick={() => void run('undo-import', { id: batch.id })}>Undo {batch.source} import ({batch.added.bookmarks.length} bookmarks, {batch.added.history.length} history)</button>)}</div>}
      {panel === 'passwords' && <div className="flex flex-col gap-3"><p className="text-xs text-ink-secondary">Saved passwords for this page’s site. Filling and saving require your confirmation. Bots can sign in with a saved login without seeing the password; switch off Bots for any account they should not use.</p>{passwords.map(p => <div key={p.id} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{p.username || 'Saved account'}</span><label className="flex items-center gap-1 text-xs text-ink-secondary"><input type="checkbox" checked={p.botSignIn} disabled={busy} onChange={e => { const allowed = e.target.checked; void run('bot-sign-in', { id: p.id, allowed }).then(result => { if (typeof result === 'boolean') setPasswords(all => all.map(x => x.id === p.id ? { ...x, botSignIn: result } : x)); }); }} />Bots</label><button className={button} disabled={busy} onClick={() => void run('fill-password', { id: p.id, guestId: guestId() }).then(result => { if (result) { setPanel(null); setNotice('Password filled.'); } else if (result === false) setNotice('No password filled. Check the page or try again.'); })}>Fill</button><button className={button} disabled={busy} onClick={() => void run('remove-password', { id: p.id }).then(removed => { if (removed) setPasswords(all => all.filter(x => x.id !== p.id)); })}>Remove</button></div>)}<button className="rounded-lg bg-raised p-3 text-sm" disabled={busy} onClick={() => void run('save-password', { guestId: guestId() }).then(r => { if (r) setNotice('Password saved securely.'); })}>Save the password entered on this page</button><button className={button} onClick={() => void showPanel('import')}>Import chrome passwords</button></div>}
      {panel==='shortcuts'&&<div className="flex flex-col gap-2 text-sm"><p className="mb-1 font-medium">Keyboard shortcuts</p>{[['New tab','⌘ T'],['Reopen closed tab','⌘ ⇧ T'],['Close tab','⌘ W'],['Address bar','⌘ L'],['Find in page','⌘ F'],['Next / previous tab','⌃ Tab / ⌃ ⇧ Tab'],['Select a tab','⌘ 1–9'],['Back / forward','⌘ [ / ⌘ ]'],['Reload / fresh reload','⌘ R / ⌘ ⇧ R'],['Zoom / reset','⌘ + − / ⌘ 0'],['Save favourite','⌘ D'],['Downloads','⌘ ⇧ J'],['Open link in background','⌘ click / middle-click'],['Open link and switch','⌘ ⇧ click']].map(([label,keys])=><div key={label} className="flex items-center justify-between gap-4"><span>{label}</span><kbd className="shrink-0 text-xs text-ink-secondary">{keys}</kbd></div>)}<p className="mt-2 text-xs text-ink-secondary">On Windows and Linux, use Ctrl instead of ⌘.</p></div>}
      {panel==='privacy'&&library.blocker&&<div className="flex flex-col gap-3 text-sm"><p className="font-medium">Ad and tracker blocking</p><p className="text-xs text-ink-secondary">{library.blocker.blocked} requests blocked in this tab</p><label className="flex items-center justify-between gap-3">Enable protection<input type="checkbox" checked={library.blocker.enabled} onChange={e=>void run('blocker-toggle',{guestId:guestId(),enabled:e.target.checked}).then(data=>{if(data)setLibrary(all=>all?{...all,blocker:data as BrowserLibrary['blocker']}:all);})}/></label>{library.blocker.site&&<label className="flex items-center justify-between gap-3"><span className="truncate">On {library.blocker.site}</span><input type="checkbox" disabled={!library.blocker.enabled} checked={library.blocker.siteEnabled} onChange={e=>void run('blocker-toggle',{guestId:guestId(),siteOnly:true,enabled:e.target.checked}).then(data=>{if(data)setLibrary(all=>all?{...all,blocker:data as BrowserLibrary['blocker']}:all);})}/></label>}<button className="rounded-lg bg-raised p-3" onClick={()=>{guest()?.reload();setPanel(null);}}>Reload page</button><p className="text-xs text-ink-secondary">Changes apply to new requests. Reload when you’re ready.</p></div>}
      {panel === 'clear' && <div className="flex flex-col gap-3 text-sm"><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={()=>void run('clear-history')}>Clear browsing history</button><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={()=>void run('clear-site-data')}>Clear cookies and website data…</button><p className="text-xs text-ink-secondary">Website data removal asks for confirmation and signs this profile out. Saved passwords stay in the encrypted vault.</p></div>}
      {panel === 'settings' && <div className="flex flex-col gap-3 text-sm"><BrowserSitePermissions rules={library?.agentRules} save={async (origin, rule) => { await call('agent-site-rule', { origin, rule }); await reloadLibrary(); }} askFullAccess={library?.agentAskFullAccess === true} saveAskFullAccess={async ask => { await call('agent-full-access', { ask }); await reloadLibrary(); }} /><p className="text-xs text-ink-secondary">This profile stays signed in across conversations, restarts and updates. Other profiles keep separate website data.</p><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={() => void run('default-browser')}>Set bos as default browser</button><p className="text-xs text-ink-secondary">On macOS, choose BOS Bot under default web browser in desktop settings.</p><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={() => void run('reset-permissions')}>Reset website permissions</button><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={() => void run('clear-site-data')}>Clear website data and sign out</button><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={() => void run('export-library')}>Export bookmarks, history and tabs</button><button className="rounded-lg bg-raised p-3 text-left" disabled={busy} onClick={() => void run('restore-library')}>Restore bookmarks and history</button><p className="text-xs text-ink-secondary">Library exports exclude passwords and website sessions. Google chrome sync is not connected.</p></div>}
    </div>}
    <div className={cn('relative flex min-h-0 flex-1 flex-col', agent[active]?.mode === 'bot' && 'browser-agent-driving')}>
    {tabs.map(t => { const held = agent[t.id]; const live = t.id === active || held || recent.includes(t.id); return <div key={t.id} data-primary-tab={t.id} className={cn('relative flex min-h-0 flex-1 flex-col', t.id !== active && 'browser-parked', t.id !== active && !held && 'browser-idle')}>{t.url === 'about:blank' ? (integrated ? <IntegratedNewTab /> : <BrowserStart active={enabled&&t.id===active} bookmarks={library.bookmarks} history={library.history} onOpen={open} onAdd={()=>{setFavouriteURL('');setFavouriteName('');setPanel('add-favourite');}}/>) : (live ? <><BrowserGuest tab={t} partition={library.partition} onState={update} />{held?.mode === 'bot' && held.own && <div className="browser-agent-guard" aria-hidden />}{held?.mode === 'bot' && held.cursor && <span key={held.cursor.at} aria-hidden className="browser-agent-cursor" style={{ left: held.cursor.x, top: held.cursor.y }} />}</> : null) }</div>; })}
    {agent[active] && <div role="status" className="browser-agent-strip">{agent[active].mode === 'bot'
      ? <><span className={cn('browser-agent-dot', agent[active].busy && 'is-busy')} /><span>bos is browsing</span><button onClick={() => person('agent-take-over')}>take over</button><button onClick={() => person('agent-stop')}>stop</button></>
      : <><span>you have control</span><button onClick={() => person('agent-give-back')}>give back to bos</button><button onClick={() => person('agent-stop')}>end</button></>}</div>}
    </div>
  </div>;
}

function displayAddress(url?: string) { if(!url || url==='about:blank')return '';try{const parsed=new URL(url);return parsed.host.replace(/^www\./,'');}catch{return url;} }

function SiteTile({title,url,onClick}:{title:string;url:string;onClick:(event:MouseEvent<HTMLButtonElement>)=>void}) {
 let host='';try{host=new URL(url).hostname.replace(/^www\./,'');}catch{host=title;}
 const hue=[...host].reduce((n,c)=>(n*31+c.charCodeAt(0))%360,0);
 const Icon=host==='youtube.com'?Play:host==='mail.google.com'?Mail:host==='github.com'?Github:null;
 return <button title={url} onClick={onClick} onAuxClick={event=>{if(event.button===1)onClick(event);}}><span className="browser-favourite-icon browser-site-icon" style={{background:`linear-gradient(145deg,hsl(${hue} 45% 45% / .22),hsl(${hue} 45% 35% / .1))`,color:`hsl(${hue} 65% 65%)`}}>{Icon?<Icon size={25}/>:<span>{siteName(host).slice(0,1)}</span>}</span><span className="truncate max-w-full">{title||siteName(host)}</span></button>;
}

function BrowserStart({active,bookmarks,history,onOpen,onAdd}:{active:boolean;bookmarks:BrowserLibrary['bookmarks'];history:BrowserLibrary['history'];onOpen:(url:string,event?:MouseEvent<HTMLButtonElement>)=>void;onAdd:()=>void}) {
 const avatar=useRef<MausAvatarHandle>(null),body=useRef<HTMLDivElement>(null);
 const [gaze,setGaze]=useState({x:0,y:0}),[reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 useEffect(()=>{const query=window.matchMedia('(prefers-reduced-motion: reduce)');const update=()=>setReduced(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
 useEffect(()=>{if(!active||reduced)return;const timer=setInterval(()=>avatar.current?.blink(),4800);return()=>clearInterval(timer);},[active,reduced]);
 return <div className="browser-start" onPointerMove={active&&!reduced?e=>{const r=body.current?.getBoundingClientRect();if(r)setGaze({x:Math.max(-1,Math.min(1,(e.clientX-r.left-r.width/2)/220)),y:Math.max(-1,Math.min(1,(e.clientY-r.top-r.height/2)/220))});}:undefined} onPointerLeave={()=>setGaze({x:0,y:0})}><div ref={body} className={active&&!reduced?'browser-bos-alive':undefined} onClick={()=>{if(!reduced)avatar.current?.blink();}}><MausAvatar ref={avatar} color="#FFFFFF" size={80} label="bos" state="idle" animated={active&&!reduced} trackPointer={false} gaze={gaze}/></div><h1>bos</h1><div className="browser-sites-heading">{bookmarks.length?'Favourites':history.length?'Your sites':'Make yourself at home'}</div><div className="browser-favourites">{browserStartSites(bookmarks,history).map(b=><SiteTile key={b.id} title={b.title} url={b.url} onClick={event=>onOpen(b.url,event)}/>)}<button className="browser-add-favourite" onClick={onAdd}><span className="browser-favourite-icon"><Plus size={23}/></span><span>Add favourite</span></button></div></div>;
}

function IntegratedNewTab() {
  useTabKinds();
  const pick = usePickTool();
  const extras = useNewTabExtras();
  const {workspace, closeTab} = useWorkspace();
  return <NewTabPage {...extras} onPick={tool => {
    const browser = browserTabsSnapshot();
    pick(tool);
    if (browser.tabs.length > 1) sendBrowserCommand({op:'close',id:browser.active});
    else {const tab=workspace.tabs.find(tab=>tab.kind==='browser');if(tab)closeTab(tab.id);}
  }}/>;
}
