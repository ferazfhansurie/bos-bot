import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MausAvatar } from "@/components/Avatar";
import { engineReady } from "@/components/EngineLibrary";
import { api, openThread, useStore, type Bot } from "@/state/store";
import { startFirstAssignment } from "@/lib/first-assignment";
import { completionPatch } from "@/lib/onboarding";
import { FIRST_OUTCOMES, firstAssignment, type BusinessBrief } from "../../../shared/bos-onboarding";
import { EnginesBeat } from "./beats/EnginesBeat";
import { inputClass, PrimaryButton, QuietButton } from "./beats/shared";

/** First-run work brief. A send has a stable ID so a transport retry never starts a second assignment. */
export function RecruitmentWelcome({ bot, onDone }: { bot: Bot | null; onDone: () => void }) {
  const { state, dispatch }=useStore();
  const [brief,setBrief]=useState<BusinessBrief>(state.config?.onboarding?.businessBrief ?? {business:"",customers:"",outcome:"website",approach:"specialist"});
  const [step,setStep]=useState<"business"|"engine"|"assignment">(state.config?.onboarding?.firstAssignment ? "assignment" : "business");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const pending=useRef(false);
  const card=useRef<HTMLDivElement>(null);
  const [started,setStarted]=useState(Boolean(state.config?.onboarding?.firstAssignment));
  const ready=state.instances.filter(engineReady);
  const [instanceId,setInstanceId]=useState(bot?.modelSelection.instanceId ?? "");
  const selected=ready.find(item=>item.instanceId===instanceId) ?? ready[0];
  const saveBrief=async()=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError("");
    try {
      firstAssignment(brief);
      const config=await api("/api/config",{method:"PUT",body:JSON.stringify({onboarding:{businessBrief:brief}}),timeoutMs:10000});
      dispatch({type:"configStatus",config});setStep("engine");
    } catch(cause){setError(cause instanceof Error?cause.message:"Could not save your brief. Try again.");}
    finally{pending.current=false;setBusy(false);}
  };
  const start=async()=>{
    if(!bot || (!selected && !started) || pending.current)return;
    pending.current=true;setBusy(true);setError("");
    try {
      setStarted(true);
      if(!state.config?.onboarding?.firstAssignment){
        const config=await api("/api/config",{method:"PUT",body:JSON.stringify({onboarding:{businessBrief:brief}}),timeoutMs:10000});
        dispatch({type:"configStatus",config});
      }
      const {config,assignment}=await startFirstAssignment(api,selected ? {botId:bot.id,threadId:bot.threadId,sendId:`onboarding_${bot.threadId}`,text:firstAssignment(brief),selection:{instanceId:selected.instanceId,model:selected.models.default}} : undefined);
      dispatch({type:"configStatus",config});openThread(dispatch,{botId:assignment.botId,threadId:assignment.threadId},state);onDone();
    } catch(cause){setError(`${cause instanceof Error?cause.message:"Connection interrupted"}. Retry resumes the saved assignment without starting a second request.`);}
    finally{pending.current=false;setBusy(false);}
  };
  const later=async()=>{
    if(pending.current)return;
    pending.current=true;setBusy(true);
    try{const config=await api("/api/config",{method:"PUT",body:JSON.stringify(completionPatch()),timeoutMs:10000});dispatch({type:"configStatus",config});onDone();}
    catch{setError("Could not save. Please try again.");}
    finally{pending.current=false;setBusy(false);}
  };
  useEffect(()=>{card.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus({preventScroll:true});},[step]);
  const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==="Escape"){event.preventDefault();void later();return;}
    if(event.key!=="Tab" || !card.current)return;
    const elements=Array.from(card.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')).filter(item=>item.getClientRects().length);
    const first=elements[0],last=elements.at(-1);
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-5" ref={card} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Build your AI team">
    <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-hairline bg-panel p-7">
      <div className="flex items-center gap-4"><MausAvatar color="green" size={60} state="happy" label="BOS"/><div><p className="text-xs text-ink-secondary">BOS · your first AI teammate</p><h1 className="text-xl font-semibold">{step==="business"?"Let's build your AI team":step==="engine"?"Connect your team's intelligence":"Your first assignment"}</h1></div></div>
      {step==="business" && <div className="mt-6 space-y-4">
        <p className="text-sm text-ink-secondary">Tell me about your business. We'll choose one useful result and meet the teammate who can help you make it.</p>
        <label className="block text-sm">What does your business do?<textarea autoFocus maxLength={1000} value={brief.business} onChange={event=>setBrief({...brief,business:event.target.value})} placeholder="We build websites and software for local businesses" className={`${inputClass} mt-2`}/></label>
        <label className="block text-sm">Who do you help?<input maxLength={500} value={brief.customers} onChange={event=>setBrief({...brief,customers:event.target.value})} placeholder="Small business owners who need more leads" className={`${inputClass} mt-2`}/></label>
        <fieldset><legend className="mb-2 text-sm">What would help you first?</legend><div className="grid grid-cols-2 gap-2">{FIRST_OUTCOMES.map(item=><button key={item.id} aria-pressed={brief.outcome===item.id} onClick={()=>setBrief({...brief,outcome:item.id})} className={`rounded-xl border p-3 text-left text-sm ${brief.outcome===item.id?"border-accent bg-accent/10":"border-hairline"}`}>{item.title}</button>)}</div></fieldset>
        <PrimaryButton disabled={busy || !brief.business.trim() || !brief.customers.trim()} onClick={()=>void saveBrief()}>Find my first teammate</PrimaryButton>
      </div>}
      {step==="engine" && <div className="mt-5"><p className="mb-4 text-sm text-ink-secondary">Your brief is saved. Connect a model you can use, then we'll start. Your provider's normal usage terms apply.</p><EnginesBeat onNext={()=>setStep("assignment")} onSkip={()=>setStep("assignment")} setMascot={()=>{}} bump={()=>{}}/></div>}
      {step==="assignment" && <div className="mt-5 space-y-4">
        <p className="text-sm">For {brief.business}, we'll make {FIRST_OUTCOMES.find(item=>item.id===brief.outcome)?.deliverable}.</p>
        <label className="block text-sm">Who should lead?<select disabled={busy || started} value={brief.approach} onChange={event=>setBrief({...brief,approach:event.target.value as BusinessBrief["approach"]})} className={`${inputClass} mt-2`}><option value="specialist">BOS helps me recruit a specialist</option><option value="bos">Work directly with BOS</option></select></label>
        {ready.length>0 ? <label className="block text-sm">Model provider<select disabled={busy || started} className={`${inputClass} mt-2`} value={selected?.instanceId} onChange={event=>setInstanceId(event.target.value)}>{ready.map(item=><option key={item.instanceId} value={item.instanceId}>{item.displayName}{item.snapshot.billing==="metered"?" · metered":""}</option>)}</select></label>:<p role="status">{started ? "Your assignment is saved. Resume to check its original request, or go back to reconnect its provider." : "Connect a model before starting this assignment."}</p>}
        <p className="text-sm text-ink-secondary">BOS will carry your brief into the conversation, show what's actually built, and help you make the first revision.</p>
        <PrimaryButton disabled={busy || (!selected && !started) || !bot} onClick={()=>void start()}>{busy?"Starting…":started?"Resume my first assignment":"Start my first assignment"}</PrimaryButton>
      </div>}
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-between">{step!=="business"?<QuietButton disabled={busy || (started && step==="engine")} onClick={()=>setStep(step==="assignment"?"engine":"business")}>Back</QuietButton>:<span/>}<QuietButton disabled={busy} onClick={()=>void later()}>Set up later</QuietButton></div>
    </div>
  </div>;
}
