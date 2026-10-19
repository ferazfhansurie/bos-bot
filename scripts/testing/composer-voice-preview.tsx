/** Synthetic speech bridge and tone only: never opens the user's microphone. */
import {createRoot} from 'react-dom/client';
import {useEffect} from 'react';
const transcripts = new Set<(line: {text:string})=>void>();
const ends = new Set<(info:{code:number})=>void>();
let finalText = '';
let stopped = 0;
(window as any).__dictationFixture={emit(text:string){finalText=text;transcripts.forEach(cb=>cb({text}));},stopped:()=>stopped};
(window as any).ogb={platform:'darwin',speechStart:async()=>{},speechStop:async()=>{stopped++;},speechFinish:async()=>{setTimeout(()=>{transcripts.forEach(cb=>cb({text:finalText+' final'}));ends.forEach(cb=>cb({code:0}));},20);},onSpeechTranscript(cb:any){transcripts.add(cb);return()=>transcripts.delete(cb);},onSpeechEnd(cb:any){ends.add(cb);return()=>ends.delete(cb);}};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const context=new AudioContext();void context.resume();const oscillator=context.createOscillator();const destination=context.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();destination.stream.getTracks().forEach(track=>{const stop=track.stop.bind(track);track.stop=()=>{stop();oscillator.stop();void context.close();};});return destination.stream;}},configurable:true});
const {initialDesktopCapabilities}=await import('../../src/lib/desktop');
(window as any).ogb.getCapabilities=async()=>initialDesktopCapabilities();
const {StoreProvider,useStore}=await import('../../src/state/store');
const {DesktopCapabilitiesProvider}=await import('../../src/components/DesktopCapabilities');
const {WorkspaceProvider}=await import('../../src/components/workspace/WorkspaceContext');
const {ChatView}=await import('../../src/components/ChatView');
const {applySkin}=await import('../../src/lib/skins');
await import('../../src/styles.css');
function Fixture(){const {state,dispatch}=useStore();const bot=state.bots[0];useEffect(()=>{if(bot&&state.selectedId!==bot.id)dispatch({type:'select',id:bot.id});},[bot?.id,state.selectedId,dispatch]);return <div className="flex h-screen flex-col bg-app text-ink">{bot&&<ChatView bot={bot}/>}</div>;}
applySkin('midnight');createRoot(document.getElementById('root')!).render(<DesktopCapabilitiesProvider><StoreProvider><WorkspaceProvider><Fixture/></WorkspaceProvider></StoreProvider></DesktopCapabilitiesProvider>);
