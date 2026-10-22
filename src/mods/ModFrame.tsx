import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import { MOD_REQUEST_TIMEOUT_MS, bridgeRequest, type ModRecord } from "../../shared/mods";
import { modHostDocument } from "./sandbox";
import type { ModSummary } from "./use-mods";
export function ModFrame({ mod, botId, surface }: { mod: ModSummary; botId: string; surface: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState<ModRecord | null>(null);
  const channel = useMemo(() => crypto.randomUUID(), [mod.revision, botId]);
  useEffect(() => {
    let live = true; setFull(null);
    void api<{ mod: ModRecord }>(`/api/mods/${mod.manifest.id}`).then(data => { if (live && data.mod.enabled && data.mod.botId === botId && data.mod.revision === mod.revision) setFull(data.mod); }).catch(() => {});
    return () => { live = false; };
  }, [mod.manifest.id, mod.revision, botId]);
  const document = useMemo(() => full ? modHostDocument(full, channel) : "", [full, channel]);
  useEffect(() => {
    let live = true; let calls = 0; let pending = 0; const started = Date.now();
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const data = event.data;
      if (!data || data.type !== "bos-mod-request" || data.channel !== channel || Object.keys(data).length !== 3) return;
      const parsed = bridgeRequest.safeParse(data.request);
      if (!parsed.success) return;
      const request = parsed.data;
      const respond = (result: unknown, error?: string) => { if (live) frame.current?.contentWindow?.postMessage({ type: "bos-mod-response", channel, id: request.id, result, error }, "*"); };
      if (++calls > 30 && Date.now() - started < 60_000 || pending >= 3) { respond(null, "Too many mod requests"); return; }
      const permission = request.method.startsWith("storage:") ? "storage" : request.method;
      if (!(mod.manifest.permissions as string[]).includes(permission)) { respond(null, "Mod permission was not declared"); return; }
      pending++;
      void api<{ result: unknown }>(`/api/mods/${mod.manifest.id}/bridge`, { method: "POST", body: JSON.stringify({ botId, revision: mod.revision, request }), signal: AbortSignal.timeout(MOD_REQUEST_TIMEOUT_MS + 1000) })
        .then(data => respond(data.result)).catch(() => respond(null, "This mod request could not finish. Check its permissions or try again."))
        .finally(() => { pending--; });
    };
    window.addEventListener("message", receive);
    return () => { live = false; window.removeEventListener("message", receive); };
  }, [mod, botId, channel]);
  if (!full) return null;
  return <iframe ref={frame} title={mod.manifest.name} data-mod-id={mod.manifest.id} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document}
    className={surface === "chip" ? "h-10 w-60 rounded-xl border-0" : surface === "band" ? "h-28 w-full rounded-xl border-0" : "h-80 w-full rounded-xl border-0"}
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'" />;
}
