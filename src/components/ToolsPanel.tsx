import {createElement, useEffect, useRef, useState} from "react";
import {ArrowLeft, ArrowRight, Download, ExternalLink, FileText, Folder, Globe, LoaderCircle, Plus, RefreshCw, Search, Square, SquareTerminal, X} from "lucide-react";
import {BrowserPanel} from "./BrowserPanel";
import type {Bot} from "@/state/store";
import {PrimaryBrowser} from "./PrimaryBrowser";
import {TerminalPanel} from "./TerminalPanel";
import {WorkspaceFilesPanel, WorkspaceFilePreview} from "./WorkspaceFilesPanel";
import type {ToolsBrowserDownload} from "@/types/ogb";
import type {TerminalTarget} from "@/lib/terminal";
import {cn} from "@/lib/cn";
import {browserAddress, browserSupported} from "@/lib/tools-panel";
import {loadWorkspaceState, newWorkspaceTab, sanitizeWorkspaceState, workspaceStorageKey, type WorkspaceTab} from "@/lib/workspace-tabs";

type WebGuest = HTMLElement & {goBack():void;goForward():void;reload():void;stop():void;getURL():string;getTitle():string;canGoBack():boolean;canGoForward():boolean;findInPage(text:string):void;stopFindInPage(action:string):void;setZoomFactor(factor:number):void};
type BrowserState = {url:string;title:string;loading:boolean;back:boolean;forward:boolean;error:string};
const button="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30";
const iconFor = (kind: WorkspaceTab["kind"]) => kind==="terminal" ? SquareTerminal : kind==="files" ? Folder : kind==="file" ? FileText : Globe;
function BrowserUnavailable() {
  const desktop=Boolean(window.ogb);
  return <div role="status" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"><Globe size={22} className="text-ink-secondary"/><p className="text-sm">{desktop ? "This desktop app is too old for the browser." : "The browser works in the BOS desktop app."}</p>{desktop && <p className="max-w-64 text-xs text-ink-secondary">Install the full BOS Bot download, then reopen Tools. An in-app update alone keeps the old app.</p>}</div>;
}
function BrowserGuest({url,partition,onState}: {url:string;partition:string|undefined;onState:(state:BrowserState)=>void}) {
  const guest=useRef<WebGuest|null>(null), callback=useRef(onState);callback.current=onState;
  useEffect(()=>{
    const el=guest.current;if(!el)return;
    let loading=false,error="";
    const update=()=>{try{callback.current({url:el.getURL(),title:el.getTitle(),loading,back:el.canGoBack(),forward:el.canGoForward(),error});}catch{/* guest not attached yet */}};
    const start=()=>{loading=true;error="";update();},stop=()=>{loading=false;update();};
    const fail=(e:Event)=>{const failure=e as Event & {errorCode?:number;isMainFrame?:boolean};if(failure.errorCode!==-3 && failure.isMainFrame!==false){error="This page could not load.";loading=false;update();}};
    const events=["did-navigate","did-navigate-in-page","page-title-updated","dom-ready"];
    events.forEach(name=>el.addEventListener(name,update));el.addEventListener("did-start-loading",start);el.addEventListener("did-stop-loading",stop);el.addEventListener("did-fail-load",fail);
    return()=>{events.forEach(name=>el.removeEventListener(name,update));el.removeEventListener("did-start-loading",start);el.removeEventListener("did-stop-loading",stop);el.removeEventListener("did-fail-load",fail);};
  },[]);
  return createElement("webview",{src:url,partition,className:"h-full w-full",ref:guest});
}
/** A keyed workspace prevents pending requests and guest state crossing threads. */
export function ToolsPanel({target,onClose,browserTarget=target,browserBot}: {target:TerminalTarget;onClose:()=>void;browserTarget?:TerminalTarget;browserBot?:Bot}) {
  return window.ogb?.primaryBrowser ? <DailyTools browserBot={browserBot} target={target} browserTarget={browserTarget} onClose={onClose}/> : <Workspace key={workspaceStorageKey(target.botId,target.threadId)} target={target} onClose={onClose}/>;
}
function Workspace({target,onClose}: {target:TerminalTarget;onClose:()=>void}) {
  const key=workspaceStorageKey(target.botId,target.threadId);
  const [state,setState]=useState(()=>loadWorkspaceState(key));
  const [address,setAddress]=useState(""),[error,setError]=useState(""),[find,setFind]=useState<string|null>(null),[zoom,setZoom]=useState(1),[browser,setBrowser]=useState<Record<string,BrowserState>>({});
  const root=useRef<HTMLElement>(null),addressInput=useRef<HTMLInputElement>(null),closed=useRef<WorkspaceTab[]>([]);
  const active=state.tabs.find(t=>t.id===state.active)!;
  const workspaceId=JSON.stringify([target.botId,target.threadId]);
  const [partition,setPartition]=useState<string|undefined>(()=>window.ogb?.toolsBrowserPartitionFor ? undefined : window.ogb?.toolsBrowserPartition);
  const [partitionError,setPartitionError]=useState("");
  const [downloads,setDownloads]=useState<ToolsBrowserDownload[]>([]),[showDownloads,setShowDownloads]=useState(false);
  useEffect(()=>{
    if(!partition)return;
    let alive=true;
    void window.ogb?.toolsBrowserDownloads?.(partition).then(items=>{if(alive)setDownloads(items.slice(-50));}).catch(()=>{});
    const unsubscribe=window.ogb?.onToolsBrowserDownload?.(download=>{if(download.partition===partition)setDownloads(items=>[...items.filter(item=>item.id!==download.id),download].slice(-50));});
    return()=>{alive=false;unsubscribe?.();};
  },[partition]);
  useEffect(()=>{let cancelled=false;if(window.ogb?.toolsBrowserPartitionFor)void window.ogb.toolsBrowserPartitionFor(workspaceId).then(value=>{if(!cancelled)setPartition(value);}).catch(()=>{if(!cancelled)setPartitionError("Browser session unavailable.");});return()=>{cancelled=true;};},[workspaceId]);
  const current=browser[active.id];
  const guest=(id:string)=>root.current?.querySelector(`[data-browser-tab="${id}"] webview`) as WebGuest|null;
  useEffect(()=>{try{const clean=sanitizeWorkspaceState(state);if(clean)localStorage.setItem(key,JSON.stringify(clean));}catch{/* storage unavailable */}},[state,key]);
  useEffect(()=>{setAddress(active.kind==="browser" ? (browser[active.id]?.url || active.url || "") : "");setError("");setFind(null);setZoom(1);},[active.id]);
  const add=(tab:WorkspaceTab)=>{setState(s=>s.tabs.length>=24 ? s : {tabs:[...s.tabs,tab],active:tab.id});};
  const newTab=()=>{add(newWorkspaceTab());setTimeout(()=>addressInput.current?.focus(),0);};
  const close=(id:string)=>setState(s=>{const index=s.tabs.findIndex(t=>t.id===id),tab=s.tabs[index];if(tab){closed.current=[tab,...closed.current].slice(0,10);}let tabs=s.tabs.filter(t=>t.id!==id);if(!tabs.length)tabs=[newWorkspaceTab()];return {tabs,active:s.active===id ? tabs[Math.min(index,tabs.length-1)].id:s.active};});
  const openTool=(kind:"terminal"|"files")=>{const existing=state.tabs.find(t=>t.kind===kind);if(existing)setState(s=>({...s,active:existing.id}));else add({id:crypto.randomUUID(),kind,title:kind==="terminal"?"Terminal":"Files",...(kind==="files"?{path:""}:{})});};
  const openFile=(path:string)=>{const existing=state.tabs.find(t=>t.kind==="file" && t.path===path);if(existing)setState(s=>({...s,active:existing.id}));else add({id:crypto.randomUUID(),kind:"file",title:path.split("/").pop() || path,path});};
  const navigate=()=>{const url=browserAddress(address);if(!url){setError("Enter an http or https address.");return;}setError("");setState(s=>({...s,tabs:s.tabs.map(t=>t.id===s.active?{id:t.id,kind:"browser",title:"Loading…",url}:t)}));};
  useEffect(()=>window.ogb?.onToolsBrowserPopup?.((url,source)=>{if(source?.partition && source.partition!==partition)return;const clean=browserAddress(url);if(clean)add({id:crypto.randomUUID(),kind:"browser",title:"New tab",url:clean});}),[partition]);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{
    if(!root.current?.contains(document.activeElement) || !(e.metaKey||e.ctrlKey))return;
    if(e.key.toLowerCase()==="t"){e.preventDefault();if(e.shiftKey){const tab=closed.current.shift();if(tab)add({...tab,id:crypto.randomUUID()});}else newTab();}
    else if(e.key.toLowerCase()==="w"){e.preventDefault();close(state.active);}
    else if(e.key.toLowerCase()==="l"){e.preventDefault();addressInput.current?.focus();addressInput.current?.select();}
    else if(e.key.toLowerCase()==="f" && active.kind==="browser"){e.preventDefault();setFind("");}
    else if(/^[1-9]$/.test(e.key)){const tab=state.tabs[Number(e.key)-1];if(tab){e.preventDefault();setState(s=>({...s,active:tab.id}));}}
  };window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);},[state,active.kind]);
  return <section ref={root} aria-label="Tools" data-testid="tools-panel" className="flex h-full min-w-0 flex-1 flex-col border-l border-hairline bg-app">
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline px-2"><div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">{state.tabs.map(tab=>{const Icon=iconFor(tab.kind);return <div key={tab.id} className={cn("flex max-w-56 shrink-0 items-center rounded-xl",tab.id===state.active?"bg-raised":"text-ink-secondary")}><button aria-pressed={tab.id===state.active} onClick={()=>setState(s=>({...s,active:tab.id}))} className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs"><Icon size={14} className="shrink-0"/><span className="truncate">{tab.title}</span></button><button className={button} aria-label={tab.kind==="browser"?"Close browser tab":`Close ${tab.title} tab`} onClick={()=>close(tab.id)}><X size={12}/></button></div>;})}</div><button className={button} aria-label="New browser tab" title="New tab" onClick={newTab}><Plus size={17}/></button><button className={button} aria-label="Close tools" onClick={onClose}><X size={16}/></button></header>
    {(active.kind==="home" || active.kind==="browser") && <form className="flex shrink-0 items-center gap-1 border-b border-hairline p-2" onSubmit={e=>{e.preventDefault();navigate();}}><button type="button" className={button} aria-label="Browser back" disabled={!current?.back} onClick={()=>guest(active.id)?.goBack()}><ArrowLeft size={15}/></button><button type="button" className={button} aria-label="Browser forward" disabled={!current?.forward} onClick={()=>guest(active.id)?.goForward()}><ArrowRight size={15}/></button><button type="button" className={button} aria-label={current?.loading?"Stop loading":"Reload browser"} disabled={active.kind!=="browser"} onClick={()=>current?.loading?guest(active.id)?.stop():guest(active.id)?.reload()}>{current?.loading?<Square size={14}/>:<RefreshCw size={15}/>}</button><input ref={addressInput} aria-label="Search or enter a URL" className="min-w-0 flex-1 rounded-full bg-raised px-4 py-2 text-sm outline-none focus:ring-1 focus:ring-hairline" placeholder="Search or enter a URL" value={address} onChange={e=>setAddress(e.target.value)}/>{active.kind==="browser" && <><button type="button" className={button} aria-label="Downloads" disabled={!window.ogb?.toolsBrowserDownloads} onClick={()=>setShowDownloads(value=>!value)}><Download size={15}/></button><button type="button" className={button} aria-label="Find in page" onClick={()=>setFind(find===null?"":null)}><Search size={15}/></button><button type="button" className={button} aria-label="Browser zoom" title="Change zoom" onClick={()=>{const factor=zoom>=1.5?.75:zoom+.25;setZoom(factor);guest(active.id)?.setZoomFactor(factor);}}><span className="text-xs">{Math.round(zoom*100)}%</span></button><button type="button" className={button} aria-label="Open in external browser" disabled={!window.ogb?.openExternal} onClick={()=>{const url=browserAddress(current?.url || active.url || "");if(url && url!=="about:blank")void window.ogb?.openExternal?.(url);}}><ExternalLink size={15}/></button></>}</form>}
    {(error || current?.error) && <p role="alert" className="px-3 py-2 text-xs text-danger">{error || current?.error}</p>}
    {showDownloads && active.kind==="browser" && <div className="max-h-48 shrink-0 overflow-auto border-b border-hairline p-3"><div className="mb-2 flex items-center justify-between"><p className="text-xs text-ink-secondary">Downloads</p><button className={button} aria-label="Close downloads" onClick={()=>setShowDownloads(false)}><X size={13}/></button></div>{!downloads.length && <p className="text-xs text-ink-secondary">No downloads in this session.</p>}{[...downloads].reverse().map(item=><div key={item.id} className="flex items-center justify-between gap-3 py-1 text-xs"><span className="truncate">{item.fileName}</span><span className="shrink-0 text-ink-secondary">{item.state==="progressing" ? (item.totalBytes ? `${Math.round(item.receivedBytes/item.totalBytes*100)}%` : `${Math.round(item.receivedBytes/1024)} KB`) : item.state}</span></div>)}</div>}
    {find!==null && active.kind==="browser" && <div className="flex items-center gap-2 border-b border-hairline px-3 py-2"><input autoFocus aria-label="Find text in page" className="min-w-0 flex-1 rounded bg-raised px-2 py-1 text-sm" value={find} onChange={e=>{setFind(e.target.value);if(e.target.value)guest(active.id)?.findInPage(e.target.value);else guest(active.id)?.stopFindInPage("clearSelection");}} onKeyDown={e=>{if(e.key==="Enter" && find)guest(active.id)?.findInPage(find);if(e.key==="Escape"){guest(active.id)?.stopFindInPage("clearSelection");setFind(null);}}}/><button className={button} aria-label="Close find" onClick={()=>{guest(active.id)?.stopFindInPage("clearSelection");setFind(null);}}><X size={14}/></button></div>}
    {state.tabs.map(tab=><div key={tab.id} data-browser-tab={tab.kind==="browser"?tab.id:undefined} className={cn("relative min-h-0 flex-1",tab.id!==state.active&&"hidden")}>
      {tab.kind==="home" && <div className="p-6"><h2 className="ui-panel-title mb-4">Tools</h2><div className="grid grid-cols-2 gap-3">{([{kind:"terminal",name:"Terminal",icon:SquareTerminal},{kind:"files",name:"Files",icon:Folder}] as const).map(tool=><button key={tool.kind} data-tool={tool.kind} className="flex min-h-16 items-center gap-3 rounded-xl bg-raised px-4 text-left text-sm hover:bg-raised/70" onClick={()=>openTool(tool.kind)}><tool.icon size={18} className="text-ink-secondary"/>{tool.name}</button>)}<button data-tool="browser" className="col-span-2 flex items-center gap-3 rounded-xl bg-raised px-4 py-3 text-left text-sm" onClick={()=>{setAddress("");addressInput.current?.focus();setState(s=>({...s,tabs:s.tabs.map(t=>t.id===tab.id?{...t,kind:"browser",url:"about:blank",title:"Browser"}:t)}));}}><Globe size={18} className="text-ink-secondary"/>Browser</button></div>{state.tabs.some(t=>t.kind==="browser"||t.kind==="file") && <div className="mt-6"><p className="mb-2 text-xs text-ink-secondary">Open in this workspace</p>{state.tabs.filter(t=>t.kind==="browser"||t.kind==="file").map(t=><button key={t.id} onClick={()=>setState(s=>({...s,active:t.id}))} className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-raised">{t.title}</button>)}</div>}</div>}
      {tab.kind==="terminal" && <TerminalPanel target={target} onClose={()=>close(tab.id)}/>}
      {tab.kind==="files" && <WorkspaceFilesPanel target={target} onOpen={openFile}/>}
      {tab.kind==="file" && <WorkspaceFilePreview target={target} path={tab.path || ""}/>}
      {tab.kind==="browser" && (browserSupported(window.ogb)?(partition?<><BrowserGuest url={tab.url || "about:blank"} partition={partition} onState={value=>{setBrowser(s=>({...s,[tab.id]:value}));if(value.url && value.url!=="about:blank"){setState(s=>({...s,tabs:s.tabs.map(t=>t.id===tab.id?{...t,title:value.title || "Browser",url:value.url}:t)}));if(tab.id===state.active)setAddress(value.url);}}}/>{browser[tab.id]?.loading && <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-app/80 p-2"><LoaderCircle size={15} className="animate-spin text-ink-secondary"/></div>}</>:<p role="status" className="p-4 text-sm text-ink-secondary">{partitionError || "Preparing browser…"}</p>):<BrowserUnavailable/>)}
    </div>)}
  </section>;
}

function DailyTools({target,onClose,browserTarget,browserBot}: {target:TerminalTarget;onClose:()=>void;browserTarget:TerminalTarget;browserBot?:Bot}) {
  const [mode,setMode]=useState<"home"|"browser"|"terminal"|"files"|"file"|"bot-browser">("browser");
  useEffect(()=>window.ogb?.primaryBrowser?.onExternalURL(()=>setMode("browser")),[]);
  const [file,setFile]=useState(""); const [expanded,setExpanded]=useState(false);
  const expand=()=>{const next=!expanded;setExpanded(next);window.dispatchEvent(new CustomEvent("bos-browser-expand",{detail:next}));};
  return <section aria-label="Tools" data-testid="tools-panel" className="flex h-full min-w-0 flex-1 flex-col border-l border-hairline bg-app">
    {mode!=="browser"&&<header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
      <button className={button} onClick={()=>setMode("browser")}>{mode==="bot-browser"?"Your browser":"Browser"}</button>{mode==="bot-browser"&&<span className="flex-1 truncate px-2 text-xs text-ink-secondary">{browserBot?.name||"Bot"} workspace</span>}<button className={button} onClick={()=>setMode("terminal")}>Terminal</button><button className={button} onClick={()=>setMode("files")}>Files</button><div className="flex-1"/><button className={button} aria-label="Close tools" onClick={()=>{if(expanded){setExpanded(false);window.dispatchEvent(new CustomEvent("bos-browser-expand",{detail:false}));}onClose();}}><X size={15}/></button>
    </header>}
    <div className={cn("flex min-h-0 flex-1 flex-col",mode!=="browser"&&"hidden")}><PrimaryBrowser visible={mode==="browser"} expanded={expanded} onExpand={expand} target={browserTarget} onTool={setMode} onClose={()=>{if(expanded){setExpanded(false);window.dispatchEvent(new CustomEvent("bos-browser-expand",{detail:false}));}onClose();}}/></div>
    {mode==="home"&&<div className="p-4">{(["browser","terminal","files"] as const).map(kind=><button data-tool={kind} key={kind} className={button} onClick={()=>setMode(kind)}>{kind}</button>)}</div>}
    {mode==="bot-browser"&&<div className="flex min-h-0 flex-1 flex-col p-2">{browserBot&&!browserBot.remote?<><p className="mb-2 px-2 text-xs text-ink-secondary">Separate from your tabs. Watching leaves the bot in control.</p><BrowserPanel bot={browserBot}/></>:<p className="p-4 text-xs text-ink-secondary">This bot works on another server. Open its computer to view its workspace.</p>}</div>}
    {mode==="terminal"&&<TerminalPanel key={workspaceStorageKey(target.botId,target.threadId)} target={target} onClose={()=>setMode("browser")}/>}
    {mode==="files"&&<WorkspaceFilesPanel key={workspaceStorageKey(target.botId,target.threadId)} target={target} onOpen={path=>{setFile(path);setMode("file");}}/>}
    {mode==="file"&&<WorkspaceFilePreview key={`${workspaceStorageKey(target.botId,target.threadId)}:${file}`} target={target} path={file}/>}
  </section>;
}
