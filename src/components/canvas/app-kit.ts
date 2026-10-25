// Apps: a blank-tab page that declares <meta name="bos-app" content="CRM">
// becomes software. The tab injects two things into it: a small design kit
// (so every app bos writes looks designed and works on a phone) and the
// `bos` data api. The page stays sandboxed (no network, no storage, no
// parent dom); the api is postMessage to the tab, which checks every request
// and forwards it to the server under the app id the tab resolved itself.
// The page never names its app, so it can only reach its own data.
import { APP_LIMITS, validCollection, validRecordId, type AppRecordInput } from "../../../shared/apps";
export { appMeta } from "../../../shared/apps";

export type BridgeOp = "list" | "get" | "put" | "patch" | "remove";
export interface BridgeRequest { rid: number; op: BridgeOp; collection: string; id?: string; record?: AppRecordInput; fields?: AppRecordInput }

const OPS = new Set<BridgeOp>(["list", "get", "put", "patch", "remove"]);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A page's bridge message, checked before anything leaves the tab. Returns
 * the request, or an error string to send back to the page. */
export function parseBridgeRequest(raw: unknown): BridgeRequest | { rid?: number; error: string } {
  if (!plain(raw)) return { error: "bad request" };
  const rid = typeof raw.rid === "number" && Number.isInteger(raw.rid) ? raw.rid : undefined;
  if (rid === undefined) return { error: "bad request id" };
  const op = raw.op as BridgeOp;
  if (!OPS.has(op)) return { rid, error: `op must be one of ${[...OPS].join(", ")}` };
  if (typeof raw.collection !== "string" || !validCollection(raw.collection)) return { rid, error: "collection must be a short lowercase name like contacts" };
  const out: BridgeRequest = { rid, op, collection: raw.collection };
  if (op === "get" || op === "patch" || op === "remove" || raw.id !== undefined) {
    if (typeof raw.id !== "string" || !validRecordId(raw.id)) return { rid, error: "id must be 1-64 letters, digits, _ or -" };
    out.id = raw.id;
  }
  if (op === "put") {
    if (!plain(raw.record)) return { rid, error: "put needs a record object" };
    out.record = raw.record as AppRecordInput;
  }
  if (op === "patch") {
    if (!plain(raw.fields)) return { rid, error: "patch needs a fields object" };
    out.fields = raw.fields as AppRecordInput;
  }
  const size = JSON.stringify(out.record ?? out.fields ?? "").length;
  if (size > APP_LIMITS.recordBytes) return { rid, error: `a record can be at most ${Math.round(APP_LIMITS.recordBytes / 1024)} KB` };
  return out;
}

/** Runs inside the sandboxed page, before its own scripts. Plain es5-ish. */
export const APP_BRIDGE = `(function(){
var ID=__ID__, rid=0, wait={}, subs=[], info=null, infoWait=[], timer={};
function post(m){m.bosCanvas=ID;try{parent.postMessage(m,"*")}catch(e){}}
function call(op,collection,extra){
  return new Promise(function(ok,no){
    var r=++rid; wait[r]={ok:ok,no:no};
    var m={rid:r,op:op,collection:collection}; for(var k in extra) if(extra[k]!==undefined) m[k]=extra[k];
    try{ post({app:JSON.parse(JSON.stringify(m))}); }catch(e){ delete wait[r]; no(new Error("records must be plain json")); }
  });
}
function refresh(collection){
  clearTimeout(timer[collection]);
  timer[collection]=setTimeout(function(){
    var mine=subs.filter(function(s){return s.c===collection||s.c==="*"});
    if(!mine.length) return;
    call("list",collection).then(function(rows){ mine.forEach(function(s){ try{s.f(rows,collection)}catch(e){console.error(e)} }); }).catch(function(e){console.error(e)});
  },30);
}
function changed(c){ return function(v){ refresh(c); return v; }; }
var bos={
  list:function(c){return call("list",c)},
  get:function(c,id){return call("get",c,{id:id})},
  put:function(c,record){return call("put",c,{record:record,id:record&&record.id}).then(changed(c))},
  patch:function(c,id,fields){return call("patch",c,{id:id,fields:fields}).then(changed(c))},
  remove:function(c,id){return call("remove",c,{id:id}).then(changed(c))},
  subscribe:function(c,f){ var s={c:c,f:f}; subs.push(s); if(c!=="*") refresh(c); return function(){ subs=subs.filter(function(x){return x!==s}); }; },
  app:function(){ return info ? Promise.resolve(info) : new Promise(function(ok){infoWait.push(ok)}); },
  id:function(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); },
  esc:function(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]}); },
  toast:function(text){
    var t=document.createElement("div"); t.className="toast"; t.textContent=text; document.body.appendChild(t);
    setTimeout(function(){t.classList.add("out")},1800); setTimeout(function(){t.remove()},2300);
  }
};
try{ Object.defineProperty(window,"bos",{value:Object.freeze(bos),configurable:false,writable:false}); }catch(e){ window.bos=bos; }
addEventListener("message",function(e){
  if(e.source!==parent||!e.data||e.data.bosCanvas!==ID) return;
  var d=e.data;
  if(d.appReply){ var w=wait[d.appReply.rid]; if(!w) return; delete wait[d.appReply.rid]; if(d.appReply.ok) w.ok(d.appReply.value); else w.no(new Error(d.appReply.error||"failed")); }
  else if(d.appChanged){
    var changedList=d.appChanged.collections||[], want={};
    subs.forEach(function(s){ if(s.c!=="*"&&(d.appChanged.all||changedList.indexOf(s.c)>=0)) want[s.c]=1; });
    if(subs.some(function(s){return s.c==="*"})) changedList.forEach(function(c){want[c]=1});
    Object.keys(want).forEach(refresh);
  }
  else if(d.appInit){ info=d.appInit.app; if(d.appInit.theme) document.documentElement.setAttribute("data-theme",d.appInit.theme); infoWait.splice(0).forEach(function(f){f(info)}); }
});
post({appHello:true});
})();`;

/** The design kit every app gets. Low specificity (:where) so the page's own
 * css always wins. Tokens: --accent, --bg, --surface, --ink, --muted, --line. */
export const APP_KIT_CSS = `
:where(html){color-scheme:light;--accent:#2f6df6;--accent-ink:#fff;--bg:#f6f7f9;--surface:#fff;--raised:#f1f3f6;--ink:#14171c;--muted:#667085;--line:#e4e7ec;--good:#12a150;--warn:#d98a04;--bad:#d92d20;--radius:12px;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08)}
:where(html[data-theme=dark]){color-scheme:dark;--bg:#111317;--surface:#191c21;--raised:#22262d;--ink:#eef0f3;--muted:#98a2b3;--line:#2c313a;--shadow:0 1px 2px rgba(0,0,0,.4)}
@media (prefers-color-scheme:dark){:where(html:not([data-theme=light])){color-scheme:dark;--bg:#111317;--surface:#191c21;--raised:#22262d;--ink:#eef0f3;--muted:#98a2b3;--line:#2c313a;--shadow:0 1px 2px rgba(0,0,0,.4)}}
:where(*,*::before,*::after){box-sizing:border-box}
[hidden]{display:none!important}
:where(body){margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
:where(h1,h2,h3,h4){margin:0;font-weight:600;letter-spacing:-.01em;line-height:1.2}
:where(h1){font-size:20px}:where(h2){font-size:16px}:where(h3){font-size:14px}
:where(p){margin:0}
:where(a){color:var(--accent)}
:where(.app){min-height:100vh;display:flex;flex-direction:column}
:where(.app-bar){position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
:where(.app-bar) :where(h1){flex:1;min-width:120px;display:flex;align-items:center;gap:8px}
:where(.app-main){flex:1;padding:18px 20px 40px;display:flex;flex-direction:column;gap:16px;max-width:1280px;width:100%;margin:0 auto}
:where(.row){display:flex;align-items:center;gap:8px;flex-wrap:wrap}
:where(.stack){display:flex;flex-direction:column;gap:8px}
:where(.spacer){flex:1}
:where(.muted){color:var(--muted)}:where(.small){font-size:12px}
:where(.grid){display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
:where(.card){background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px}
:where(.stat) :where(.stat-label){font-size:12px;color:var(--muted)}
:where(.stat) :where(.stat-value){font-size:24px;font-weight:600;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
:where(.btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
:where(.btn:hover){background:var(--raised)}
:where(.btn.primary){background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
:where(.btn.primary:hover){filter:brightness(1.07)}
:where(.btn.ghost){background:transparent;border-color:transparent}
:where(.btn.danger){color:var(--bad)}
:where(.btn.sm){height:28px;padding:0 10px;font-size:13px;border-radius:8px}
:where(.btn:disabled){opacity:.45;cursor:default}
:where(.icon-btn){display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:inherit}
:where(.icon-btn:hover){background:var(--raised);color:var(--ink)}
:where(input,select,textarea){font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:7px 10px;min-height:34px;width:100%;outline:none}
:where(input:focus,select:focus,textarea:focus,[contenteditable]:focus){border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
:where(input[type=checkbox],input[type=radio]){width:auto;min-height:0;accent-color:var(--accent)}
:where(textarea){min-height:80px;resize:vertical}
:where(.field){display:flex;flex-direction:column;gap:5px}
:where(.field) > :where(label,span){font-size:12px;font-weight:500;color:var(--muted)}
:where(.form){display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
:where(.search){max-width:260px}
:where(.tabs){display:inline-flex;padding:3px;gap:2px;background:var(--raised);border-radius:10px;overflow-x:auto;max-width:100%}
:where(.tabs) :where(button){border:0;background:transparent;color:var(--muted);font:inherit;font-weight:500;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
:where(.tabs) :where(button[aria-selected=true]){background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
:where(.table-wrap){overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
:where(table.table){width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
:where(.table) :where(th){position:sticky;top:0;background:var(--raised);text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
:where(.table) :where(td){padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
:where(.table) :where(tr:last-child td){border-bottom:0}
:where(.table) :where(tbody tr:hover){background:color-mix(in srgb,var(--raised) 60%,transparent)}
:where(.table) :where(tr[data-click]){cursor:pointer}
:where(.badge){display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;background:var(--raised);color:var(--muted);white-space:nowrap}
:where(.badge[data-tone=blue]){background:color-mix(in srgb,#2f6df6 14%,transparent);color:#2f6df6}
:where(.badge[data-tone=green]){background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good)}
:where(.badge[data-tone=amber]){background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
:where(.badge[data-tone=red]){background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
:where(.badge[data-tone=purple]){background:color-mix(in srgb,#7a5af8 14%,transparent);color:#7a5af8}
:where(.avatar){display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:color-mix(in srgb,var(--accent) 16%,var(--surface));color:var(--accent);font-size:12px;font-weight:600;flex:none}
:where(.board){display:grid;grid-auto-flow:column;grid-auto-columns:minmax(240px,1fr);gap:12px;overflow-x:auto;padding-bottom:6px;align-items:start}
:where(.col){background:var(--raised);border-radius:var(--radius);padding:10px;display:flex;flex-direction:column;gap:8px;min-height:120px}
:where(.col.drop){outline:2px dashed var(--accent);outline-offset:-2px}
:where(.col-head){display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;padding:2px 4px}
:where(.tile){background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:var(--shadow);cursor:grab}
:where(.tile.dragging){opacity:.5}
:where(.list){display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
:where(.list) > :where(*){padding:12px 14px;border-bottom:1px solid var(--line)}
:where(.list) > :where(*:last-child){border-bottom:0}
:where(.empty){padding:40px 20px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:var(--radius)}
:where(dialog.sheet){border:0;padding:0;border-radius:16px;background:var(--surface);color:var(--ink);width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);box-shadow:0 20px 50px rgba(0,0,0,.25)}
:where(dialog.sheet)::backdrop{background:rgba(10,12,16,.45)}
:where(dialog.sheet) > :where(form,div){padding:20px;display:flex;flex-direction:column;gap:14px}
:where(.sheet-actions){display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
:where(.toast){position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:999px;font-size:13px;z-index:50;box-shadow:var(--shadow);transition:opacity .4s}
:where(.toast.out){opacity:0}
@media (max-width:640px){
  :where(.app-bar){padding:12px 14px}
  :where(.app-main){padding:14px 12px 32px}
  :where(.search){max-width:none;flex:1}
  :where(.board){grid-auto-flow:row;grid-auto-columns:auto}
  :where(dialog.sheet){width:100vw;max-width:100vw;margin:auto 0 0;border-radius:16px 16px 0 0;max-height:88vh}
  :where(.hide-sm){display:none}
}
`;
