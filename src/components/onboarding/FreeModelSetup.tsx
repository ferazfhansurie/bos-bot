import { useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { engineReady } from "@/components/EngineLibrary";
import { inputClass } from "./beats/shared";
import { PresetProviderMark } from "@/components/ProviderIcons";

/** Write-only connection form. Keys never enter chat, URLs or persisted browser state. */
export function FreeModelSetup({compact=false}:{compact?:boolean}={}) {
 const {state,dispatch}=useStore();
 const [open,setOpen]=useState(false),[key,setKey]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const pending=useRef(false);
 const connected=state.instances.find(item=>item.instanceId==="bos-free");
 const ready=connected && engineReady(connected);
 const connect=async(hosted=false)=>{
  if(pending.current||(!hosted&&!key.trim()))return;
  pending.current=true;setBusy(true);setError("");
  try {
   const result=await api("/api/onboarding/free-model",{method:"POST",body:JSON.stringify(hosted?{hosted:true}:{key}),timeoutMs:30000});
   setKey("");dispatch({type:"instances",instances:result.instances??[]});
   const instance=result.instances?.find((item:{instanceId:string})=>item.instanceId==="bos-free");
   if(!instance||!engineReady(instance))setError(hosted?"BOS Free is connected, but it isn't answering right now. Check again shortly.":"Your key is saved, but free models are unavailable right now. Check again shortly.");
   else setOpen(false);
  } catch {setError(hosted?"BOS Free is unavailable right now. Try again shortly, or use your own OpenRouter key.":"Could not connect. Check your OpenRouter key and connection, then try again.");}
  finally {pending.current=false;setBusy(false);}
 };
 return <section className={compact?"rounded-lg border border-hairline p-2":"mt-4 rounded-xl border border-accent/40 bg-accent/5 p-4"} aria-label="Free models">
  {!compact && <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><PresetProviderMark preset="deepseek" size={18}/>Start free</h3><span className="text-xs text-ink-secondary">{ready?"Connected":"100 messages a day"}</span></div>}
  {(!compact || open) && <p className="mt-2 text-sm text-ink-secondary">Start with BOS Free, powered by DeepSeek V4 Flash. No account or key needed, and it can use tools just like paid engines. Includes up to 100 messages a day.</p>}
  {!open?<div className={compact?"space-y-2":"mt-3 flex flex-wrap items-center gap-3"}>
   <button className={compact?"ui-button inline-flex w-full items-center justify-center gap-2":"ui-button inline-flex items-center gap-2"} disabled={busy} onClick={()=>void connect(true)}>{compact&&<PresetProviderMark preset="deepseek" size={14}/>}{busy?"Connecting…":ready?"Reconnect BOS Free":"Start free"}</button>
   <button className="text-sm text-accent underline" disabled={busy} onClick={()=>setOpen(true)}>Use my own OpenRouter key</button>
  </div>:<form className="mt-3 space-y-3" onSubmit={event=>{event.preventDefault();void connect(false);}}>
   <a className="text-sm text-accent underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Create an OpenRouter API key</a>
   <label className="block text-sm">OpenRouter API key<input type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key} disabled={busy} onChange={event=>setKey(event.target.value)} className={`${inputClass} mt-2`} placeholder="Paste your key here, never in chat"/></label>
   <p className="text-xs text-ink-secondary">Saved privately on this BOS server. Connecting checks your key without generating a response. Your tasks are sent to OpenRouter when you start them.</p>
   <button className="ui-button" disabled={busy||!key.trim()} type="submit">{busy?"Connecting…":"Connect and continue free"}</button>
   <button className="ui-button ml-2" disabled={busy} type="button" onClick={()=>{setKey("");setOpen(false);}}>Cancel</button>
  </form>}
  {error&&<p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
 </section>;
}
