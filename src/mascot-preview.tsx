// Review only. Firaz's supplied full-body keyframes, retained CursorAvatar engine.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CursorAvatar, FACE_BOX, type CursorState } from "./components/CursorAvatar";
import { flatMascotBody, FLAT_MASCOT_BODIES } from "../shared/flat-mascot-bodies";
import { GESTURE_FACE_STATE, resolveGesture, type MascotGesture, type GestureReceipt, type GestureActivity } from "../shared/mascot-choreography";
import { GlyphPreview } from "./mascot-preview-glyphs";
import { glyphFaceParts } from "./lib/glyph-face";
import "./mascot-preview.css";
const gestures: MascotGesture[] = ["thinking","searching","reading","browsing","writing","working","waiting","finished"];
const descriptions = {
  idle:"original outline. quiet rest.",
  thinking:"stretch up → thoughtful tilt → little ball → unfold. 1.6s gesture, 3s rest.",
  searching:"stretch sideways → peek left → peek right → soft return. 1.2s gesture, 2.5s rest.",
  working:"curl → split into three blobs → staggered bounce → regroup. 1.8s gesture, 2.8s rest.",
  reading:"eyes run along three lines, left to right. a page flips beside it. 2.4s, 0.9s rest.",
  browsing:"eyes dart while the page loads, then settle. 1.5s, 2.2s rest.",
  writing:"looks down while a scribble draws underneath and fades. 2.2s, 1.2s rest.",
  waiting:"melt into a puddle. eyes peek out. one knock every 8s.",
  finished:"crouch → one happy hop → squishy landing → original idle. 0.9s, once.",
};
const faces: Record<MascotGesture,CursorState> = {idle:"idle",thinking:"thinking",searching:"searching",reading:"searching",browsing:"searching",writing:"working",working:"working",waiting:"curious",finished:"happy"};
const presets=[{name:"bos",body:"star",color:"#ffffff"},{name:"oracle",body:"sun",color:"#e5634e"},{name:"build",body:"squircle",color:"#8057c8"},{name:"life",body:"bean",color:"#009957"}];
type Props={gesture:MascotGesture;bodyId:string;color:string;size:number;replay:number;still:boolean};
function Mascot({gesture,bodyId,color,size,replay,still}:Props){
  const host=useRef<HTMLSpanElement>(null);
  const [visible,setVisible]=useState(true),[active,setActive]=useState(!document.hidden);
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));
    if(host.current)observer.observe(host.current);
    const change=()=>setActive(!document.hidden);document.addEventListener("visibilitychange",change);
    return()=>{observer.disconnect();document.removeEventListener("visibilitychange",change);};
  },[]);
  const body=flatMascotBody(bodyId),scale=FACE_BOX/100;
  const silhouette=useMemo(()=>({name:body.name,fit:"scale("+scale+")",body:'<path d="'+body.path+'" fill="{{GRADIENT}}"/>',clip:'<path d="'+body.path+'"/>',anchor:{x:(50+body.faceX*.5)*scale,y:(46+body.faceY)*scale,scale:.55}}),[body,scale]);
  const choreography=useMemo(()=>({gesture,key:replay,path:body.path,faceX:body.faceX,faceY:body.faceY,reduced:still}),[gesture,replay,body,still]);
  const glyphFace=glyphFaceParts({state:GESTURE_FACE_STATE[gesture],color,centre:[50+body.faceX*.5,50+body.faceY],diameter:80,pixels:size*.8*FACE_BOX/(FACE_BOX+30)});
  return <span ref={host} className="mascot-frame" data-motion={still?"still":visible&&active?"active":"suspended"}>
    <CursorAvatar state={faces[gesture]} size={size} title={body.name+" "+gesture+" mascot"} silhouette={silhouette} gradient={[color,color,color]} eyeColor="#151515"
      showMouth={false} effects={false} glyphs={false} motion={0} lookAround={0} autoBlink={!still&&visible&&active} autoExpression={false}
      paused={still||!visible||!active} choreography={choreography} glyphFace={glyphFace}/>
  </span>;
}
function Preview(){
  const [gesture,setGesture]=useState<MascotGesture>("thinking"),[bodyId,setBody]=useState("star"),[color,setColor]=useState("#ffffff"),[replay,setReplay]=useState(0);
  const [manualStill,setStill]=useState(false),[osStill,setOsStill]=useState(false),[scenario,setScenario]=useState("manual preview — production wiring awaits review");
  const [receipt,setReceipt]=useState<GestureReceipt>({gesture:"idle",terminalTurnId:null});
  const turn=useRef(0),terminal=useRef<string|null>(null);
  useEffect(()=>{const media=matchMedia("(prefers-reduced-motion: reduce)"),change=()=>setOsStill(media.matches);change();media.addEventListener("change",change);return()=>media.removeEventListener("change",change);},[]);
  const select=(next:MascotGesture)=>{setGesture(next);setReplay(v=>v+1);setScenario("manual interruption — transition starts at displayed pose");};
  const simulate=(activity:GestureActivity,label:string)=>{const next=resolveGesture(activity,receipt);setReceipt(next);setGesture(next.gesture);setReplay(v=>v+1);setScenario(label);};
  const props={gesture,bodyId,color,replay,still:manualStill||osStill};
  return <main>
    <GlyphPreview/>
    <p className="eyebrow">bos / full-body motion review</p><h1>now the whole bot moves.</h1>
    <p className="intro">the supplied motion study, with the retained face engine. no props, scenes or production changes.</p>
    <section className="hero"><div className="stage"><Mascot {...props} size={210}/></div><div className="controls">
      <h2>{gesture==="waiting"?"waiting for you":gesture}</h2><p className="description">{descriptions[gesture]}</p>
      <div className="pickers">{presets.map(p=><button key={p.name} aria-pressed={bodyId===p.body} onClick={()=>{setBody(p.body);setColor(p.color);setReplay(v=>v+1);}}>{p.name}</button>)}</div>
      <div className="field-row"><label>shape <select value={bodyId} onChange={e=>{setBody(e.target.value);setReplay(v=>v+1);}}>{FLAT_MASCOT_BODIES.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label>color <input aria-label="mascot color" type="color" value={color} onChange={e=>setColor(e.target.value)}/></label></div>
      <div className="actions"><button onClick={()=>setReplay(v=>v+1)}>replay gesture</button><label><input type="checkbox" checked={manualStill} onChange={e=>setStill(e.target.checked)}/> reduced motion poses</label></div>
      {osStill&&<p className="note">system reduced motion is on</p>}
    </div></section>
    <section className="grid" aria-label="full-body behaviors">{gestures.map(g=><button className="card" key={g} aria-label={"show "+g} aria-pressed={gesture===g} onClick={()=>select(g)}><Mascot {...props} gesture={g} size={84}/><span>{g}</span></button>)}</section>
    <section className="chat"><div className="chat-header"><span>conversation sizes</span><span>32px / 44px / source 48px</span></div><div className="user">show me what the little guy can do</div>
      {[32,44,48].map(size=><div className="presence" key={size}><Mascot {...props} size={size}/><span>{size}px · {gesture==="waiting"?"waiting for you":gesture}</span></div>)}
      <div className="composer">message bos</div></section>
    <section className="simulator"><h2>interrupt and reconnect</h2><p className="description">{scenario}</p><div className="pickers">
      <button onClick={()=>simulate({working:true},"turn is working")}>start working</button>
      <button onClick={()=>simulate({working:true,waiting:true},"waiting dominates the ongoing turn")}>request input</button>
      <button onClick={()=>{terminal.current="turn-"+(++turn.current);simulate({terminalTurnId:terminal.current},"new terminal turn — finish once");}}>complete new turn</button>
      <button onClick={()=>simulate({terminalTurnId:terminal.current,reconnect:true},"reconnected snapshot — no completion replay")}>reconnect same result</button>
      <button onClick={()=>simulate({terminalTurnId:terminal.current},"same terminal receipt — no completion replay")}>repeat completion</button>
      <button onClick={()=>select("idle")}>original idle</button>
    </div><p className="note">completion ledger: {receipt.terminalTurnId??"none"}. finish settles after one hop.</p></section>
    <p className="foot">preview only · source: firaz’s full-body study in bos-mascot-polish · retained CursorAvatar face/frame machinery · offscreen and inactive-page loops suspend · physical-phone smoothness is unverified</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
