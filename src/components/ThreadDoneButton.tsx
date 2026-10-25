import {useEffect,useRef,useState} from 'react';
import {Check,LoaderCircle,RotateCcw,X} from 'lucide-react';
import {api,useStore,type Bot} from '@/state/store';
import {cn} from '@/lib/cn';
import {COMPACT_BUBBLE} from '@/lib/compact-chip';

/** Exact-thread completion; keeps the selected conversation open for review. */
export function ThreadDoneButton({bot}:{bot:Bot}) {
 const {dispatch}=useStore();
 const task=bot.tasks?.find(t=>t.threadId===bot.threadId);
 const done=task?.archivedAt!==undefined;
 const working=Boolean(bot.busy||task?.busy||task?.activity==='working');
 const [pending,setPending]=useState(false),[undo,setUndo]=useState(false),[error,setError]=useState('');
 const live=useRef(true),saving=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{if(!undo)return;const timer=setTimeout(()=>setUndo(false),8000);return()=>clearTimeout(timer);},[undo]);
 const save=async(markDone:boolean)=>{
  if(saving.current||working)return;saving.current=true;setPending(true);setError('');
  try{
   const result=await api<{bot:Bot}>(`/api/bots/${encodeURIComponent(bot.id)}/tasks/${encodeURIComponent(bot.threadId)}`,{method:'PATCH',body:JSON.stringify({archivedAt:markDone?Date.now():null})});
   dispatch({type:'botPatched',bot:result.bot});
   if(live.current)setUndo(markDone);
  }catch{if(live.current)setError(markDone?'Could not mark this thread done. Try again.':'Could not reopen this thread. Try again.');}
  finally{saving.current=false;if(live.current)setPending(false);}
 };
 return <>
  <button type="button" aria-label={done?'Reopen thread':'Mark thread done'} aria-pressed={done} disabled={pending||working} title={working?'Finish or stop this turn first':done?'Reopen this conversation':'Mark this conversation done'} onClick={()=>void save(!done)} className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40',COMPACT_BUBBLE,done?'bg-raised text-ink-secondary':'text-ink-secondary hover:bg-raised hover:text-ink')}>
   {pending?<LoaderCircle size={14} className="animate-spin"/>:done?<RotateCcw size={14}/>:<Check size={14}/>}<span className="@max-4xl/chathead:sr-only">Done</span>
  </button>
  {(undo||error)&&<div role={error?'alert':'status'} className="fixed bottom-6 right-6 z-50 flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-xl border border-hairline bg-card px-4 py-3 text-[13px] text-ink shadow-xl"><span>{error||'Thread marked done.'}</span>{undo&&<button type="button" className="font-medium text-accent hover:underline disabled:opacity-40" disabled={pending||working} onClick={()=>void save(false)}>Undo</button>}<button type="button" aria-label="Dismiss thread notice" className="text-ink-secondary hover:text-ink" onClick={()=>{setUndo(false);setError('');}}><X size={14}/></button></div>}
 </>;
}
