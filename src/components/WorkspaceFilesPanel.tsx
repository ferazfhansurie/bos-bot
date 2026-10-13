import {useEffect, useState} from "react";
import {ArrowUp, FileText, Folder, Search} from "lucide-react";
import { Skeleton } from "./Skeleton";
import type {TerminalTarget} from "@/lib/terminal";
type Entry = {name: string; path: string; kind: "dir" | "file"};
function endpoint(target: TerminalTarget, action: string, params: Record<string, string>) {
  return `/api/workspace-files/${action}?${new URLSearchParams({botId:target.botId, threadId:target.threadId, ...params})}`;
}
async function get(target: TerminalTarget, action: string, params: Record<string,string>, signal: AbortSignal) {
  const res = await fetch(endpoint(target, action, params), {signal}); const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Files unavailable"); return data;
}
export function WorkspaceFilesPanel({target, onOpen}: {target: TerminalTarget; onOpen: (path: string) => void}) {
  const [path, setPath] = useState(""), [query,setQuery]=useState(""), [entries,setEntries]=useState<Entry[]>([]), [error,setError]=useState(""), [loading,setLoading]=useState(false), [truncated,setTruncated]=useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setEntries([]);
    const timer = setTimeout(() => { void get(target, query.trim() ? "search" : "list", query.trim() ? {q:query} : {path},controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setEntries(query.trim() ? data.files.map((p:string)=>({name:p,path:p,kind:"file"})) : data.entries);setTruncated(Boolean(data.truncated));setLoading(false);
    }).catch(e => {if (!controller.signal.aborted) {setError(e.message);setLoading(false);}}); }, query ? 180 : 0);
    return () => {controller.abort();clearTimeout(timer);};
  },[target.botId,target.threadId,path,query]);
  return <div className="flex h-full min-h-0 flex-col"><div className="flex items-center gap-2 border-b border-hairline p-3"><Search size={15} className="text-ink-secondary"/><input aria-label="Search workspace files" placeholder="Find a file…" value={query} onChange={e=>setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none"/></div>
    <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 text-xs text-ink-secondary"><button aria-label="Parent folder" disabled={!path || Boolean(query)} onClick={()=>setPath(path.split("/").slice(0,-1).join("/"))} className="rounded p-1 hover:bg-raised disabled:opacity-30"><ArrowUp size={14}/></button><button onClick={()=>{setPath("");setQuery("");}}>Working folder</button><span className="truncate">{path && `/ ${path}`}</span></div>
    <div className="min-h-0 flex-1 overflow-auto p-2">{loading && <div role="status" aria-label="Loading files" className="space-y-3 p-3">{[0,1,2,3,4].map(i=><Skeleton key={i} className="h-7 w-full" />)}</div>}{error && <p role="alert" className="p-3 text-sm text-danger">{error}</p>}{!loading && !error && !entries.length && <p className="p-3 text-sm text-ink-secondary">{query ? "No matching files." : "This folder is empty."}</p>}{entries.map(entry=><button key={entry.path} onClick={()=>entry.kind==="dir" ? setPath(entry.path) : onOpen(entry.path)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-raised">{entry.kind==="dir" ? <Folder size={16} className="shrink-0 text-ink-secondary"/> : <FileText size={16} className="shrink-0 text-ink-secondary"/>}<span className="truncate">{entry.name}</span></button>)}{truncated && <p className="p-3 text-xs text-ink-secondary">Showing a limited set. Narrow your search.</p>}</div></div>;
}
export function WorkspaceFilePreview({target,path}: {target: TerminalTarget;path:string}) {
  const [data,setData]=useState<{content:string;binary:boolean;truncated:boolean;size:number}|null>(null),[error,setError]=useState("");
  useEffect(()=>{const c=new AbortController();setData(null);setError("");void get(target,"read",{path},c.signal).then(d=>{if(!c.signal.aborted)setData(d);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[target.botId,target.threadId,path]);
  return <div className="flex h-full min-h-0 flex-col"><div className="truncate border-b border-hairline px-4 py-2 text-xs text-ink-secondary">{path} · read only</div>{error ? <p role="alert" className="p-4 text-sm text-danger">{error}</p> : !data ? <div role="status" aria-label="Loading file" className="space-y-3 p-4">{[0,1,2,3,4,5].map(i=><Skeleton key={i} className={i%2 ? "h-4 w-2/3" : "h-4 w-5/6"} />)}</div> : data.binary ? <p className="p-4 text-sm text-ink-secondary">Binary file · {data.size.toLocaleString()} bytes. Text preview unavailable.</p> : <><pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5" dir="ltr">{data.content}</pre>{data.truncated && <p className="border-t border-hairline p-2 text-xs text-ink-secondary">Preview limited to the first 256 KB.</p>}</>}</div>;
}
