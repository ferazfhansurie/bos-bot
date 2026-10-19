/** Isolated fixture only; APIs are proxied to control-omb's disposable server. */
import {createRoot} from 'react-dom/client';
import {useEffect,useRef} from 'react';
import {StoreProvider,useStore} from '../../src/state/store';
import {WorkspaceProvider} from '../../src/components/workspace/WorkspaceContext';
import {WorkspaceRightPane, WorkspaceBottomPane, WorkspaceOverlays} from '../../src/components/workspace/WorkspaceDock';
import {ConversationActions} from '../../src/components/workbench/ConversationActions';
import {applySkin} from '../../src/lib/skins';
import '../../src/styles.css';
function Fixture(){
 const {state,dispatch}=useStore();const bot=state.bots[0];const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(bot&&state.selectedId!==bot.id)dispatch({type:'select',id:bot.id});},[bot?.id,state.selectedId,dispatch]);
 return <div ref={ref} className="relative flex h-screen bg-app text-ink"><main className="flex min-w-0 flex-1 flex-col"><header className="flex h-[60px] items-center justify-between px-5"><span>panel fixture</span>{bot&&<div className="flex items-center gap-1"><ConversationActions bot={bot} messages={[]} local><span/></ConversationActions></div>}</header><div className="flex-1"/><WorkspaceBottomPane containerRef={ref}/></main><WorkspaceRightPane containerRef={ref}/><WorkspaceOverlays/></div>;
}
applySkin('midnight');createRoot(document.getElementById('root')!).render(<StoreProvider><WorkspaceProvider><Fixture/></WorkspaceProvider></StoreProvider>);
