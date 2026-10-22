import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthFix, HealthReport } from "../../shared/doctor";
import { api, useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const labels: Record<string, string> = { engine: "Engine", cli: "Engine CLI", server: "Server", whatsapp: "WhatsApp", disk: "Free disk space", update: "Updates", push: "Phone notifications" };
const statuses = { ok: "Ready", warning: "Needs attention", error: "Needs attention", unavailable: "Unavailable" };

export function HealthReportView({ report, busy, onFix }: { report: HealthReport; busy: boolean; onFix(fix: HealthFix): void }) {
  return <>
    {report.safeMode.enabled && <div role="status" className="rounded-xl border border-hairline bg-inset p-4 text-sm text-ink"><strong>Safe mode</strong><p className="mt-1">{report.safeMode.reason || "BOS could not start normally."} Mods, plugins and routines are paused.</p></div>}
    {report.notices.length > 0 && <div aria-label="Recovery notices" className="space-y-2">{report.notices.map(notice => <p key={notice.id} role={notice.status === "read-only" ? "alert" : "status"} className="rounded-lg border border-hairline/40 bg-inset px-4 py-3 text-sm text-ink">{notice.detail}</p>)}</div>}
    <ul className="divide-y divide-hairline/40" aria-label="Health checks">{report.checks.map(check => <li key={check.id} className="flex flex-wrap items-center gap-3 py-4">
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h3 className="text-sm font-medium text-ink">{labels[check.id] ?? check.id}</h3><span className={`text-xs ${check.status === "ok" ? "text-success" : "text-ink-secondary"}`}>{statuses[check.status]}</span></div><p className="mt-1 text-sm text-ink-secondary">{check.detail}</p></div>
      {check.fix && (check.fix.kind === "settings" || report.selfHealEnabled !== false) && <button className="ui-button" disabled={busy} onClick={() => onFix(check.fix!)}>{check.fix.label}</button>}
    </li>)}</ul>
  </>;
}

export function HealthSettings() {
  const { dispatch } = useStore();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch { if (mounted.current) setError("BOS could not finish this health action. Try again."); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const refresh = useCallback(() => run(async () => {
    const value = await api<HealthReport>("/api/doctor");
    if (mounted.current) setReport(value);
  }), [run]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  const fix = (value: HealthFix) => {
    if (value.kind === "settings") { dispatch({ type: "toggleAppSettings", open: true, section: value.section }); return; }
    void run(async () => {
      const next = await api<HealthReport>("/api/doctor/fix", { method: "POST", body: JSON.stringify({ action: value.action }) });
      if (mounted.current) setReport(next);
    });
  };
  const health = window.ogb?.health;
  return <Card title="Health" subtitle="Check this BOS and repair connections safely.">
    <div className="space-y-4" aria-busy={busy}>
      <div className="flex flex-wrap gap-2"><button className="ui-button" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Check again"}</button>
        {health?.sendDiagnostics && report && report.selfHealEnabled !== false && <button className="ui-button" disabled={busy} onClick={() => void run(async () => { const sent = await health.sendDiagnostics(); if (mounted.current) setReportId(sent.id); })}>Send report to BOS team</button>}
        {report?.safeMode.enabled && health?.exitSafeMode && <button className="ui-button" disabled={busy} onClick={() => void run(async () => { await health.exitSafeMode(); })}>Exit safe mode</button>}
      </div>
      {error && <p role="alert" className="text-sm text-ink">{error}</p>}
      {reportId && <p role="status" className="text-sm text-ink">Report sent. Report ID: {reportId}</p>}
      {!report && !error && <p role="status" className="text-sm text-ink-secondary">Checking BOS health…</p>}
      {report && <HealthReportView report={report} busy={busy} onFix={fix} />}
    </div>
  </Card>;
}
