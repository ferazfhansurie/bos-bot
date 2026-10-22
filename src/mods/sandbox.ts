import { MOD_CSP, MOD_REQUEST_TIMEOUT_MS, type ModBundle } from "../../shared/mods";
export const WEBRTC_GLOBALS = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCSessionDescription", "RTCEncodedAudioFrame", "RTCEncodedVideoFrame"];
// HTML is only ever assigned to an opaque-origin sandboxed iframe, never the app DOM.
export function modDocument(bundle: ModBundle, channel: string): string {
  const sdk = `(()=>{const channel=${JSON.stringify(channel)};let n=0;const pending=new Map();window.bos=Object.freeze({call(method,params={}){if(pending.size>=3)return Promise.reject(Error('Too many requests'));const id='r'+(++n);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Mod request timed out'))},${MOD_REQUEST_TIMEOUT_MS + 2000});pending.set(id,{resolve,reject,timer});parent.postMessage({type:'bos-mod-request',channel,request:{id,method,params}},'*')})}});addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='bos-mod-response'||e.data.channel!==channel)return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result)});})();`;
  // CSP connect-src does not cover WebRTC: Chromium still sends STUN/TURN
  // packets from this frame (and ignores `webrtc 'block'`), which would let a
  // mod leak bridge data. Strip the constructors before mod code runs; child
  // frames are cross-origin error pages under frame-src 'none', so a mod
  // cannot fetch a clean realm to get them back.
  const noRtc = `for(const k of ${JSON.stringify(WEBRTC_GLOBALS)}){try{Object.defineProperty(window,k,{value:undefined,configurable:false,writable:false})}catch{}}`;
  const script = (code: string) => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
  let html = bundle.files["index.html"];
  // Only bundled, flat JS/CSS references are expanded. Everything else is denied by CSP.
  html = html.replace(/<script\b[^>]*\bsrc=["']([\w-]+\.js)["'][^>]*>\s*<\/script\s*>/gi, (_, file: string) => script(bundle.files[file] ?? ""));
  html = html.replace(/<link\b[^>]*\bhref=["']([\w-]+\.css)["'][^>]*>/gi, (_, file: string) => `<style>${(bundle.files[file] ?? "").replace(/<\/style/gi, "<\\/style")}</style>`);
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${MOD_CSP}"><meta name="referrer" content="no-referrer"><style>body{margin:8px;font:13px system-ui;color:#ddd;background:#202126}button{font:inherit;cursor:pointer}*{box-sizing:border-box}</style>${script(noRtc)}${script(sdk)}${html}`;
}

// The trusted outer frame has its own frame-src policy: CSP connect-src does
// not cover a document navigating itself. Keeping mod code in the inner frame
// lets the OUTER policy deny those navigations before any network request.
export function modHostDocument(bundle: ModBundle, channel: string): string {
  const inner = modDocument(bundle, channel).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const relay = `(()=>{const child=document.querySelector('iframe');const channel=${JSON.stringify(channel)};addEventListener('message',e=>{const d=e.data;if(!d||d.channel!==channel)return;if(e.source===child.contentWindow&&e.origin==='null'&&d.type==='bos-mod-request'){parent.postMessage(d,'*')}else if(e.source===parent&&d.type==='bos-mod-response'){child.contentWindow.postMessage(d,'*')}})})();`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${inner}"></iframe><script>${relay}</script>`;
}
