/** Isolated fixture only: the real chat view and workspace dock, with APIs
 * proxied to control-omb's disposable server. Never the installed app. */
import {createRoot} from 'react-dom/client';
import {useEffect} from 'react';
import {StoreProvider,useStore} from '../../src/state/store';
import {DesktopCapabilitiesProvider} from '../../src/components/DesktopCapabilities';
import {ThreadRefsProvider} from '../../src/components/ThreadRefs';
import {SplitViewProvider} from '../../src/components/SplitViewContext';
import {SplitWorkspace} from '../../src/components/SplitView';
import {ChatView} from '../../src/components/ChatView';
import {applySkin} from '../../src/lib/skins';
import '../../src/styles.css';
function Fixture(){
 const {state,dispatch}=useStore();const bot=state.bots[0];
 // fixture drivers start a new chat the way the sidebar does
 (window as unknown as {fixtureDispatch:typeof dispatch}).fixtureDispatch=dispatch;
 useEffect(()=>{if(bot&&state.selectedId!==bot.id)dispatch({type:'select',id:bot.id});},[bot?.id,state.selectedId,dispatch]);
 return <div className="flex h-screen bg-app text-ink"><SplitWorkspace>{bot&&<ChatView bot={bot}/>}</SplitWorkspace></div>;
}
applySkin('midnight');createRoot(document.getElementById('root')!).render(<DesktopCapabilitiesProvider><StoreProvider><ThreadRefsProvider><SplitViewProvider><Fixture/></SplitViewProvider></ThreadRefsProvider></StoreProvider></DesktopCapabilitiesProvider>);
