import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { api, useStore } from "@/state/store";
import { useAppConfig } from "@/lib/app-config";
import { cn } from "@/lib/cn";

// BOS AI: the free start every install gets. The server turns it on by itself
// when bosbot.my knows who downloaded the app; otherwise one press opens a
// google sign-in on bosbot.my and the server picks the token up. Credit is
// a $1 free allowance per person, then their bosbot credit.

export type BosAiStatus = {
  phase: "off" | "starting" | "claim" | "ready" | "error";
  claimUrl?: string;
  error?: string;
  credit?: { left: number; cap: number; monthFull: boolean } | null;
  topup: string;
  enabled: boolean;
};

const openLink = (url: string) => {
  if (window.ogb?.openExternal) void window.ogb.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
};

export function creditLine(status: BosAiStatus): string {
  const credit = status.credit;
  if (!credit) return "Free AI credit to start, no account needed.";
  if (credit.monthFull) return "Free AI is at capacity this month. Your own credit still works.";
  if (credit.left <= 0) return "Your free credit is used up. Add credit to keep going.";
  return `$${credit.left.toFixed(2)} of your $${credit.cap.toFixed(0)} free credit left.`;
}

export function BosAiCard({ compact = false, className }: { compact?: boolean; className?: string }) {
  const config = useAppConfig();
  const { dispatch } = useStore();
  const [status, setStatus] = useState<BosAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef("");

  const load = useCallback(async () => {
    try {
      const next = (await api("/api/bos-ai")) as BosAiStatus;
      setStatus((prev) => {
        // the token just landed: the engine list and picker read it next
        if (prev && prev.phase !== "ready" && next.phase === "ready") void api("/api/instances").then((d) => dispatch({ type: "instances", instances: d.instances ?? [] })).catch(() => {});
        return next;
      });
    } catch {
      setStatus((prev) => prev ?? null);
    }
  }, [dispatch]);

  useEffect(() => { void load(); }, [load]);
  // while the server is waiting on bosbot.my, follow it
  useEffect(() => {
    if (status?.phase !== "starting" && status?.phase !== "claim") return;
    const timer = window.setInterval(() => void load(), 2_500);
    return () => window.clearInterval(timer);
  }, [status?.phase, load]);

  const start = async (link: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = (await api("/api/bos-ai/start", { method: "POST", body: JSON.stringify({ link }), timeoutMs: 30_000 })) as BosAiStatus;
      setStatus(next);
      if (next.phase === "claim" && next.claimUrl && opened.current !== next.claimUrl) { opened.current = next.claimUrl; openLink(next.claimUrl); }
      if (next.phase === "ready") void load();
    } catch {
      setStatus((prev) => ({ ...(prev ?? { topup: "https://app.bosbot.my/__bos/offer", enabled: true }), phase: "error", error: "Could not turn on BOS AI. Check your connection and try again." }));
    } finally { setBusy(false); }
  };

  if (!config.flags.freeEngine || (status && !status.enabled)) return null;
  const phase = status?.phase ?? "off";
  const ready = phase === "ready";
  const out = ready && status?.credit && (status.credit.left <= 0 || status.credit.monthFull);

  const primary = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" onClick={onClick} disabled={disabled || busy} className={cn("ui-button inline-flex items-center justify-center gap-2 bg-accent text-white hover:bg-accent/90 disabled:opacity-60", compact && "w-full")}>
      {busy ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
      {label}
    </button>
  );

  return (
    <section
      aria-label="BOS AI"
      data-bos-ai={phase}
      className={cn(compact ? "rounded-lg border border-accent/40 bg-accent/5 p-3" : "mt-4 rounded-xl border border-accent/50 bg-accent/5 p-4", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Sparkles size={compact ? 15 : 18} className="text-accent" />BOS AI</h3>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", ready ? "bg-success/15 text-success" : "bg-accent/15 text-accent")}>
          {ready ? "On" : "Free to start"}
        </span>
      </div>

      {phase === "off" && (
        <>
          <p className="mt-2 text-[13px] text-ink-secondary">Free AI credit to start. No Claude or ChatGPT needed, and you can pick a different model any time.</p>
          {status?.error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{status.error}</p>}
          <div className="mt-3">{primary("Turn on free AI", () => void start(false))}</div>
        </>
      )}
      {phase === "starting" && (
        <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-secondary" aria-live="polite"><RefreshCw size={13} className="animate-spin" />Turning on BOS AI…</p>
      )}
      {phase === "claim" && (
        <>
          <p className="mt-2 text-[13px] text-ink-secondary" aria-live="polite">Finish in your browser: sign in with google on bosbot.my. This page updates by itself.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {status?.claimUrl && primary("Open the sign-in page", () => openLink(status.claimUrl!))}
          </div>
        </>
      )}
      {phase === "error" && (
        <>
          <p role="alert" className="mt-2 text-[13px] text-danger">{status?.error ?? "Could not turn on BOS AI."}</p>
          <div className="mt-3">{primary("Try again", () => void start(false))}</div>
        </>
      )}
      {ready && status && (
        <>
          <p className="mt-2 text-[13px] text-ink-secondary">{creditLine(status)}</p>
          <div className={cn("mt-3 flex flex-wrap items-center gap-3", compact && "gap-2")}>
            {out
              ? primary("Add credit", () => openLink(status.topup))
              : <a className="text-[12.5px] text-accent underline" href={status.topup} target="_blank" rel="noreferrer">Add credit</a>}
            <button type="button" disabled={busy} onClick={() => void start(true)} className="text-[12.5px] text-accent underline disabled:opacity-60">Use my bosbot credit</button>
          </div>
          {!compact && <p className="mt-2 text-[11.5px] text-ink-secondary">Cheaper models go further. You can also connect your own Claude or ChatGPT below.</p>}
        </>
      )}
    </section>
  );
}
