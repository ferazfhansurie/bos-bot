// A bot's ```html (or ```artifact) block, rendered live. The page runs in
// an iframe sandboxed to scripts only — no allow-same-origin, so it is an
// opaque origin that cannot read the app, its storage, cookies or the API;
// no forms, popups, modals or top navigation. A CSP injected ahead of the
// bot's markup blocks every network fetch (scripts, styles, images, fonts,
// XHR/fetch/WebSocket, nested frames) except inline code and data:/blob:
// media, and WebRTC is removed before the bot's code runs. If the page still
// navigates itself away, the preview is torn down (and Electron refuses the
// navigation outright, electron/main.mjs). The only channel out is a height
// message the parent reads from this exact frame.
import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Code2, Eye, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { MEDIA_BORDER, MEDIA_TEXT_SECONDARY } from "./MediaTokens";
import { CodeBlock } from "./ChatMarkdown";

/** Fence languages that render as a live preview. */
export const ARTIFACT_LANGS = new Set(["html", "artifact"]);
/** Above this the preview is skipped and the source shown instead. */
export const ARTIFACT_MAX_CHARS = 200_000;
/** The frame name Electron's subframe guard recognises. */
export const ARTIFACT_FRAME_NAME = "bos-artifact";
const MIN_HEIGHT = 120, MAX_HEIGHT = 900;

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The full srcdoc: CSP first, a WebRTC/height shim, then the bot's markup. */
export function artifactDocument(code: string, frameId: string): string {
  const body = code.replace(/^\s*<!doctype[^>]*>/i, "");
  const id = JSON.stringify(frameId);
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<script>(function(){for (const k of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"]) { try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {} }`
    + `var post=function(){try{parent.postMessage({bosArtifact:${id},height:Math.ceil(document.documentElement.scrollHeight)},"*")}catch(e){}};`
    + `addEventListener("load",post);new ResizeObserver(post).observe(document.documentElement);})();</script>`
    + `<style>html{color-scheme:light dark}body{margin:12px;font:14px system-ui,sans-serif}</style>`
    + `</head><body>${body}</body></html>`;
}

let frameCounter = 0;

export function HtmlArtifact({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [height, setHeight] = useState(240);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const frameId = useMemo(() => `artifact-${++frameCounter}`, []);
  const tooLarge = code.length > ARTIFACT_MAX_CHARS;
  const srcDoc = useMemo(() => tooLarge ? "" : artifactDocument(code, frameId), [code, frameId, tooLarge]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { bosArtifact?: unknown; height?: unknown } | null;
      if (!data || data.bosArtifact !== frameId || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(data.height))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);
  useEffect(() => { loads.current = 0; setNavigatedAway(false); }, [srcDoc]);

  // While the fence is still arriving, the half-written page would flicker
  // and run partial scripts: show the growing source instead.
  if (streaming || tooLarge) return <CodeBlock code={code} lang={lang === "artifact" ? "html" : lang} streaming={streaming} />;

  const toggle = (
    <button type="button" onClick={() => setView(view === "preview" ? "source" : "preview")} aria-pressed={view === "source"}
      className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[12.5px] px-2 text-[12px] leading-[18px] transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_7.8%,transparent)] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60", MEDIA_TEXT_SECONDARY)}>
      {view === "preview" ? <Code2 size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      {view === "preview" ? "View source" : "View preview"}
    </button>
  );
  return (
    <figure dir="ltr" className={cn("my-3 overflow-hidden rounded-[20px] border bg-raised", MEDIA_BORDER)} aria-label="HTML preview">
      <figcaption className="relative flex items-center gap-3 px-4 py-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[12.5px] bg-inset", MEDIA_TEXT_SECONDARY)} aria-hidden="true">
          <AppWindow size={20} />
        </span>
        <span className="min-w-0 flex-1" title="Runs in a sandbox: no network, no access to BOS or your files">
          <span className="block truncate text-[12px] leading-[18px] font-medium text-ink">HTML preview</span>
          <span className={cn("flex items-center gap-1 truncate text-[11px] leading-4", MEDIA_TEXT_SECONDARY)}>
            <ShieldCheck size={12} aria-hidden="true" className="shrink-0" />
            <span className="truncate">HTML · sandboxed, offline</span>
          </span>
        </span>
        {toggle}
      </figcaption>
      <div className={cn("border-t", MEDIA_BORDER)}>
        {view === "source"
          ? <div className="px-2 pb-1"><CodeBlock code={code} lang="html" streaming={false} /></div>
          : navigatedAway
            ? <div role="status" className={cn("p-4 text-[13px]", MEDIA_TEXT_SECONDARY)}>This preview tried to leave its sandbox and was stopped. View the source instead.</div>
            : <iframe
                ref={frameRef}
                name={ARTIFACT_FRAME_NAME}
                title="HTML preview"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                allow=""
                srcDoc={srcDoc}
                onLoad={() => { loads.current += 1; if (loads.current > 1) setNavigatedAway(true); }}
                className="block w-full border-0 bg-white"
                style={{ height }}
              />}
      </div>
    </figure>
  );
}
