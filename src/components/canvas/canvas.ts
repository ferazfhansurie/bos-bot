// The blank tab's pure half: its starter asks, the library, and the
// sandboxed document the tab renders (with the present-mode shim). The page
// is one self-contained html file in the conversation's working folder that
// bos writes with its normal file tools and shows with open_tab (the
// bundled blank-tab skill), so it persists, opens in Files and gets edited
// in place by follow-up asks.
import { ARTIFACT_CSP } from "@/components/HtmlArtifact";
import { APP_BRIDGE, APP_KIT_CSS } from "./app-kit";

export const CANVAS_DIR = "bos-pages";

export type CanvasStarter = { id: "presentation" | "dashboard" | "doc" | "video" | "crm" | "app"; label: string; prompt: string };
export const CANVAS_STARTERS: readonly CanvasStarter[] = [
  { id: "crm", label: "crm", prompt: "make me a crm for " },
  { id: "app", label: "app", prompt: "make this tab an app for " },
  { id: "presentation", label: "presentation", prompt: "make this tab a presentation about " },
  { id: "dashboard", label: "dashboard", prompt: "make this tab a dashboard of " },
  { id: "doc", label: "doc", prompt: "make this tab a doc about " },
  { id: "video", label: "video", prompt: "a short video about " },
];

/** The page's own <title>, once bos has written one. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html);
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t || undefined;
}

/** Typed into the chat composer by the blank tab's starter chips. */
export const COMPOSER_INSERT_EVENT = "bos:composer-insert";
/** ifEmpty: only fill a composer that has no draft (focus it otherwise). */
export type ComposerInsertDetail = { botId: string; threadId?: string; text: string; ifEmpty?: boolean };

/** The document the tab's iframe gets: the chat-preview CSP first, then
 * the present shim, then bos's markup. The shim marks slides, shows one at
 * a time while presenting, and talks to the tab only by postMessage. An app
 * page also gets the design kit and the `bos` data api, before its own css
 * and scripts so both are there when they run. */
export function canvasDocument(html: string, frameId: string, app = false): string {
  const id = JSON.stringify(frameId);
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>html.bos-present,html.bos-present body{height:100%;overflow:hidden!important}`
    + `html.bos-present [data-bos-hide],html.bos-present [data-bos-slide]:not([data-bos-on]){display:none!important}`
    + `html.bos-present [data-bos-on]{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;aspect-ratio:auto!important;box-sizing:border-box;overflow:hidden}`
    + `html.bos-present body{margin:0!important;padding:0!important}html.bos-present.bos-noslides,html.bos-present.bos-noslides body{overflow:auto!important}</style>`
    + `<script>${PRESENT_SHIM.replace("__ID__", id)}</script>`
    + (app ? `<style>${APP_KIT_CSS}</style><script>${APP_BRIDGE.replace("__ID__", id)}</script>` : "");
  const body = html.replace(/^\s*<!doctype[^>]*>/i, "");
  if (/<head[^>]*>/i.test(body)) return `<!doctype html>${body.replace(/<head[^>]*>/i, m => m + head)}`;
  if (/<html[^>]*>/i.test(body)) return `<!doctype html>${body.replace(/<html[^>]*>/i, m => `${m}<head>${head}</head>`)}`;
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

/** Runs inside the sandboxed page. Kept as plain es5-ish text. */
const PRESENT_SHIM = `(function(){
for (const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"]) { try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {} }
var ID=__ID__, on=false, at=0, list=[];
function post(m){m.bosCanvas=ID;try{parent.postMessage(m,"*")}catch(e){}}
function slides(){
  var b=document.body; if(!b) return [];
  var marked=[].slice.call(document.querySelectorAll("[data-slide]")); if(marked.length) return marked;
  var q=[].slice.call(b.children).filter(function(e){return e.tagName==="SECTION"}); if(q.length) return q;
  var m=b.querySelector(":scope > main"); if(m){q=[].slice.call(m.children).filter(function(e){return e.tagName==="SECTION"}); if(q.length) return q;}
  return [];
}
function show(i){
  if(!list.length) return; at=Math.max(0,Math.min(list.length-1,i));
  list.forEach(function(s,n){ if(n===at) s.setAttribute("data-bos-on",""); else s.removeAttribute("data-bos-on"); });
  post({slide:at,count:list.length});
}
function start(i){
  list=slides(); on=true; var root=document.documentElement; root.classList.add("bos-present");
  root.classList.toggle("bos-noslides",!list.length);
  var keep=new Set();
  list.forEach(function(s,n){ s.setAttribute("data-bos-slide",String(n)); for(var e=s.parentElement;e&&e!==document.body;e=e.parentElement) keep.add(e); });
  if(list.length) [].slice.call(document.body.querySelectorAll("*")).forEach(function(e){
    if(keep.has(e)||e.hasAttribute("data-bos-slide")) return;
    var p=e.parentElement; if((p===document.body||keep.has(p))&&e.tagName!=="SCRIPT"&&e.tagName!=="STYLE") e.setAttribute("data-bos-hide","");
  });
  show(i||0); if(!list.length) post({slide:0,count:0});
}
function stop(){
  on=false; var root=document.documentElement; root.classList.remove("bos-present","bos-noslides");
  [].slice.call(document.querySelectorAll("[data-bos-hide],[data-bos-slide],[data-bos-on]")).forEach(function(e){e.removeAttribute("data-bos-hide");e.removeAttribute("data-bos-slide");e.removeAttribute("data-bos-on");});
}
function step(d){ if(list.length) show(at+d); else window.scrollBy({top:d*innerHeight*0.9,behavior:"smooth"}); }
addEventListener("message",function(e){
  if(e.source!==parent||!e.data||e.data.bosCanvas!==ID) return;
  var c=e.data.cmd;
  if(c==="start") start(e.data.slide); else if(c==="stop") stop();
  else if(c==="next") step(1); else if(c==="prev") step(-1);
  else if(c==="count") post({count:slides().length,info:true});
});
addEventListener("keydown",function(e){
  if(!on) return;
  var k=e.key;
  if(k==="ArrowRight"||k==="ArrowDown"||k==="PageDown"||k===" "||k==="Enter"){e.preventDefault();step(1);}
  else if(k==="ArrowLeft"||k==="ArrowUp"||k==="PageUp"||k==="Backspace"){e.preventDefault();step(-1);}
  else if(k==="Home"){e.preventDefault();show(0);} else if(k==="End"){e.preventDefault();show(list.length-1);}
  else if(k==="Escape"){e.preventDefault();post({exit:true});}
},true);
addEventListener("click",function(e){
  if(!on||!list.length) return;
  if(e.target&&e.target.closest&&e.target.closest("a,button,input,select,textarea,label,[onclick]")) return;
  step(e.clientX<innerWidth*0.25?-1:1);
});
addEventListener("load",function(){post({count:slides().length,info:true});});
})();`;

/** One row of the blank tab's library: everything this bot made, in one list. */
export type LibraryKind = "app" | "page" | "doc" | "video";
export interface LibraryItem { kind: LibraryKind; id: string; title: string; at: number; detail?: string; icon?: string }
export type LibraryFilter = "all" | LibraryKind;
export const LIBRARY_FILTERS: readonly { id: LibraryFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "app", label: "Apps" }, { id: "page", label: "Pages" }, { id: "doc", label: "Docs" }, { id: "video", label: "Videos" },
];
export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = { app: "App", page: "Page", doc: "Doc", video: "Video" };

/** "2026-10-24-5-slide-deck-about-bos-bot-k3f9.html" → "5 slide deck about bos bot" */
export function canvasFileTitle(name: string): string {
  return name.replace(/\.html?$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-[a-z0-9]{4}$/, "").replace(/-/g, " ").trim() || name;
}

/** Newest first, narrowed by filter and a case-insensitive title search. */
export function libraryView(items: readonly LibraryItem[], filter: LibraryFilter, query: string): LibraryItem[] {
  const q = query.trim().toLowerCase();
  return items
    .filter(i => (filter === "all" || i.kind === filter) && (!q || i.title.toLowerCase().includes(q)))
    .sort((a, b) => b.at - a.at);
}
