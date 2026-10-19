// The WhatsApp tile in Connected apps, driven by the server's native
// whatsapp-web.js client (server/whatsapp-native.ts) instead of Composio.
// State comes from GET /api/whatsapp/native — real client events plus a
// liveness probe — never a static "ready". Owners can approve scoped bot access.
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Loader2 } from "lucide-react";
import { WhatsAppPermissions } from "./WhatsAppPermissions";
import { api } from "@/state/store";
import { ServiceIcon, type ToolkitCard } from "./PluginsPanel";

export type NativeWhatsAppState = "not_linked" | "qr_pending" | "linking" | "linked" | "disconnected" | "needs_rescan";

export interface NativeWhatsAppSnapshot {
  state: NativeWhatsAppState;
  qr: string | null;
  reason: string | null;
  sessionExists: boolean;
  circuitOpen: boolean;
  failures: number;
  nextRetryAt: number | null;
  messageCount: number;
}

export function nativeWhatsAppLabel(snapshot: NativeWhatsAppSnapshot | null): string {
  if (!snapshot) return "Checking…";
  switch (snapshot.state) {
    case "linked": return `Linked · ${snapshot.messageCount} message${snapshot.messageCount === 1 ? "" : "s"} captured`;
    case "qr_pending": return "Scan with WhatsApp → Settings → Linked devices";
    case "linking": return "Linking…";
    case "needs_rescan": return snapshot.reason ? `Needs a new scan — ${snapshot.reason}` : "Needs a new scan";
    case "disconnected":
      if (snapshot.circuitOpen) return snapshot.reason ? `Stopped retrying — ${snapshot.reason}` : "Stopped retrying";
      if (snapshot.nextRetryAt) return snapshot.reason ? `Disconnected — retrying (${snapshot.reason})` : "Disconnected — retrying";
      return snapshot.reason ? `Disconnected — ${snapshot.reason}` : "Disconnected";
    default: return snapshot.reason ?? "Read your chats on this Mac (read-only)";
  }
}

/** Which button the tile shows, and which route it calls. */
export function nativeWhatsAppAction(snapshot: NativeWhatsAppSnapshot | null):
  { label: string; route: "connect" | "reconnect" | null } {
  if (!snapshot) return { label: "Checking…", route: null };
  if (snapshot.state === "linked") return { label: "Linked", route: null };
  if (snapshot.state === "linking") return { label: "Linking…", route: null };
  if (snapshot.state === "qr_pending") return { label: "Restart", route: "reconnect" };
  if (snapshot.state === "needs_rescan") return { label: "Rescan", route: "reconnect" };
  if (snapshot.state === "disconnected") return { label: "Reconnect", route: "reconnect" };
  return { label: "Connect", route: "connect" };
}

const pollDelay = (snapshot: NativeWhatsAppSnapshot | null) =>
  snapshot && (snapshot.state === "qr_pending" || snapshot.state === "linking") ? 2_000 : 10_000;

export function NativeWhatsAppTile({ card }: { card: ToolkitCard }) {
  const [snapshot, setSnapshot] = useState<NativeWhatsAppSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() =>
    api("/api/whatsapp/native")
      .then((response) => {
        if (alive.current && response?.whatsapp) setSnapshot(response.whatsapp);
      })
      .catch((cause) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      }), []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), pollDelay(snapshot));
    return () => clearTimeout(timer);
  }, [load, snapshot]);

  const action = nativeWhatsAppAction(snapshot);
  const run = async () => {
    if (!action.route) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/api/whatsapp/native/${action.route}`, { method: "POST" });
      if (alive.current && response?.whatsapp) setSnapshot(response.whatsapp);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="min-h-[88px] border-b border-hairline/35 px-1 py-4" data-testid="native-whatsapp-tile" data-state={snapshot?.state ?? "loading"}>
      <div className="flex items-center gap-3">
        <ServiceIcon card={card} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={snapshot?.reason ?? undefined}>
            {nativeWhatsAppLabel(snapshot)}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || !action.route}
          onClick={() => void run()}
          className="flex min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="mx-auto animate-spin" /> : action.label}
        </button>
      </div>
      {snapshot?.state === "qr_pending" && snapshot.qr && (
        <div className="mt-3 flex items-center gap-4">
          <div className="rounded-xl bg-white p-2.5">
            <QRCodeSVG value={snapshot.qr} size={168} />
          </div>
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            On your phone open WhatsApp → Settings → Linked devices → Link a device, and scan this code.
            Linking alone only grants reading. You can approve bot replies in Bot permissions after linking.
          </p>
        </div>
      )}
      {snapshot?.state === "linked" && <WhatsAppPermissions />}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
