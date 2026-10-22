import { useEffect, useRef, useState } from "react";
import type { HealthReport } from "../../shared/doctor";
import { api, useStore } from "@/state/store";

type RecoveryStatus = Pick<HealthReport, "notices" | "safeMode">;
export function RecoveryBannerView({ status, onOpen, onExit, busy }: { status: RecoveryStatus; onOpen(): void; onExit?(): void; busy?: boolean }) {
  if (!status.safeMode.enabled && !status.notices.length) return null;
  return <aside role={status.notices.some(notice => notice.status === "read-only") ? "alert" : "status"} aria-label="BOS recovery" className="relative z-[110] flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline bg-panel px-4 py-3 text-sm text-ink shadow-sm">
    <div className="min-w-0 flex-1">
      {status.safeMode.enabled && <p><strong>Safe mode.</strong> {status.safeMode.reason || "BOS could not start normally."} Mods, plugins and routines are paused.</p>}
      {status.notices.map(notice => <p key={notice.id}>{notice.detail}</p>)}
    </div>
    <button className="ui-button" onClick={onOpen}>Open health</button>
    {status.safeMode.enabled && onExit && <button className="ui-button" disabled={busy} onClick={onExit}>Exit safe mode</button>}
  </aside>;
}

/** A cheap boot read: recovery must stay visible even when engine probes hang. */
export function RecoveryBanner() {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const exiting = useRef(false);
  useEffect(() => {
    let active = true;
    void api<RecoveryStatus>("/api/recovery-status").then(value => { if (active) setStatus(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const exit = window.ogb?.health?.exitSafeMode;
  if (!status) return null;
  return <>
    <RecoveryBannerView status={status} busy={busy} onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "health" })} onExit={exit ? () => {
      if (exiting.current) return;
      exiting.current = true; setBusy(true); setError(false);
      void exit().catch(() => setError(true)).finally(() => { exiting.current = false; setBusy(false); });
    } : undefined} />
    {error && <p role="alert" className="relative z-[110] bg-panel px-4 py-2 text-sm text-ink">BOS could not exit safe mode. Open Health to try again.</p>}
  </>;
}
