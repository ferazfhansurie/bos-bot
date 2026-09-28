import { useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { engineReady } from "@/components/EngineLibrary";
import { inputClass } from "./beats/shared";

/** Write-only connection form. Keys never enter chat, URLs or persisted browser state. */
export function FreeModelSetup({compact=false}:{compact?:boolean}={}) {
 const {state,dispatch}=useStore();
 const [open,setOpen]=useState(false),[key,setKey]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const pending=useRef(false);
 const connected=state.instances.find(item=>item.instanceId==="bos-free");
 const ready=connected && engineReady(connected);
 const connect=async()=>{
  if(pending.current||!key.trim())return;
  pending.current=true;setBusy(true);setError("");
  try {
   const result=await api("/api/onboarding/free-model",{method:"POST",body:JSON.stringify({key}),timeoutMs:30000});
   setKey("");dispatch({type:"instances",instances:result.instances??[]});
   const instance=result.instances?.find((item:{instanceId:string})=>item.instanceId==="bos-free");
   if(!instance||!engineReady(instance))setError("Your key is saved, but free models are unavailable right now. Check again shortly.");
   else setOpen(false);
  } catch {setError("Could not connect. Check your OpenRouter key and connection, then try again.");}
  finally {pending.current=false;setBusy(false);}
 };
 return <section className={compact?"rounded-lg border border-hairline p-2":"mt-4 rounded-xl border border-accent/40 bg-accent/5 p-4"} aria-label="Free models">
  {!compact && <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Start free</h3><span className="text-xs text-ink-secondary">{ready?"Connected":"No paid-model fallback"}</span></div>}
  {(!compact || open) && <p className="mt-2 text-sm text-ink-secondary">Use OpenRouter's available free models with your own account. Free usage has provider limits and may be busy. This connection only sends requests to verified zero-price models that support tools.</p>}
  {!open?<button className={compact?"ui-button w-full":"ui-button mt-3"} onClick={()=>setOpen(true)}>{ready?"Reconnect OpenRouter":"Connect free models"}</button>:<form className="mt-3 space-y-3" onSubmit={event=>{event.preventDefault();void connect();}}>
   <a className="text-sm text-accent underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Create an OpenRouter API key</a>
   <label className="block text-sm">OpenRouter API key<input type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key} disabled={busy} onChange={event=>setKey(event.target.value)} className={`${inputClass} mt-2`} placeholder="Paste your key here, never in chat"/></label>
   <p className="text-xs text-ink-secondary">Saved privately on this BOS server. Connecting checks your key without generating a response. Your tasks are sent to OpenRouter when you start them.</p>
   <button className="ui-button" disabled={busy||!key.trim()} type="submit">{busy?"Connecting…":"Connect and continue free"}</button>
   <button className="ui-button ml-2" disabled={busy} type="button" onClick={()=>{setKey("");setOpen(false);}}>Cancel</button>
  </form>}
  {error&&<p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
 </section>;
}
