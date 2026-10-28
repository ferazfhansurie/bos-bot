// The tab's side of an installed mini app: someone else's code, so it runs
// stricter than a page bos wrote. Two frames, like mods: the inner frame
// holds the app with the no-network policy as its very first element (a page
// bos wrote gets it injected after <head>, which a hostile page could get
// ahead of); the outer frame's own policy stops the inner one navigating
// anywhere, and its relay passes on only this tab's bridge messages.
import { ARTIFACT_CSP } from "@/components/HtmlArtifact";
import { WEBRTC_GLOBALS } from "@/mods/sandbox";
import { APP_BRIDGE, APP_KIT_CSS } from "./app-kit";

const OUTER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; base-uri 'none'; form-action 'none'";

const noRtc = `for(var k of ${JSON.stringify(WEBRTC_GLOBALS)}){try{Object.defineProperty(window,k,{value:undefined,configurable:false,writable:false})}catch(e){}}`;
const script = (code: string) => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The inner document: policy first, then the WebRTC strip, kit and bridge, then the app. */
export function miniAppDocument(html: string, frameId: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + script(noRtc) + `<style>${APP_KIT_CSS}</style>` + script(APP_BRIDGE.replace("__ID__", JSON.stringify(frameId)))
    + html.replace(/^\s*<!doctype[^>]*>/i, "");
}

/** The outer document the tab's iframe loads. */
export function miniAppHostDocument(html: string, frameId: string): string {
  const id = JSON.stringify(frameId);
  const relay = `(function(){var child=document.querySelector("iframe"),ID=${id};addEventListener("message",function(e){var d=e.data;if(!d||typeof d!=="object"||d.bosCanvas!==ID)return;if(e.source===child.contentWindow&&e.origin==="null"){parent.postMessage(d,"*")}else if(e.source===parent){child.contentWindow.postMessage(d,"*")}})})();`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${OUTER_CSP}"><meta name="referrer" content="no-referrer">`
    + `<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>`
    + `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" srcdoc="${attr(miniAppDocument(html, frameId))}"></iframe>${script(relay)}`;
}

/** The phone's copy of the same pieces (ios/Sources/CompanionCore/Resources/mini-app-kit.json).
 * The iphone loads the app as the main frame of a locked WKWebView, so the
 * bridge posts to the native `bos` handler instead of a parent frame; replies
 * come back through window.postMessage, whose source is the page itself, which
 * in the main frame is also `parent`. */
export function miniAppNativeKit(): { csp: string; noRtc: string; kitCss: string; bridge: string } {
  const from = `parent.postMessage(m,"*")`;
  if (!APP_BRIDGE.includes(from)) throw new Error("app bridge changed: update miniAppNativeKit");
  return {
    csp: ARTIFACT_CSP,
    noRtc,
    kitCss: APP_KIT_CSS,
    bridge: APP_BRIDGE.replace(from, `window.webkit.messageHandlers.bos.postMessage(m)`),
  };
}
