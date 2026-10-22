import { useEffect, useRef, useState } from "react";
import { useAppConfig } from "@/lib/app-config";
import { confirmUsefulResult, shareReferral } from "@/lib/product-feedback";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export function PlansCard() {
  const config = useAppConfig();
  const [open, setOpen] = useState(false);
  const [referralUrl, setReferralUrl] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!config.flags.invite) return;
    const controller = new AbortController();
    void api<{ referralUrl: string | null }>("/api/product", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReferralUrl(result.referralUrl);
    }).catch(() => {});
    return () => controller.abort();
  }, [config.flags.invite]);
  const confirm = async () => {
    if (!confirmed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try { await confirmUsefulResult(confirmed, api); setDone(true); }
    catch { setError(true); }
    finally { pending.current = false; setBusy(false); }
  };
  if (!config.flags.plans && !config.flags.invite && !config.flags.activationTelemetry) return null;
  return <Card title="Your BOS" subtitle="Choose how you use BOS and invite a friend.">
    {config.flags.plans && <>
      <button type="button" className="ui-button" aria-expanded={open} onClick={() => setOpen(!open)}>View plans</button>
      {open && <div className="mt-3 grid gap-3 sm:grid-cols-2">{config.pricing.map(plan => <article key={plan.id} className="rounded-xl border border-hairline/50 p-4">
        <h3 className="text-sm font-semibold text-ink">{plan.title}</h3>
        <p className="mt-2 text-xl font-semibold text-ink">RM{plan.priceMYR.toLocaleString("en-MY")}<span className="ml-1 text-xs font-normal text-ink-secondary">{plan.unit}</span></p>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{plan.description}</p>
        {plan.status === "available" ? <a href={plan.url} target="_blank" rel="noreferrer" className="ui-button mt-3 inline-flex">View {plan.title}</a> : <span className="mt-3 inline-block text-xs text-ink-secondary">Coming soon</span>}
      </article>)}</div>}
    </>}
    {config.flags.invite && <div className="mt-4">
      <h3 className="text-sm font-medium text-ink">Invite a friend</h3>
      <p className="mt-1 text-xs text-ink-secondary">Share your BOS download link.</p>
      {referralUrl ? <>
        <input readOnly aria-label="Your BOS invitation link" value={referralUrl} className="mt-2 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-xs text-ink" onFocus={event => event.target.select()} />
        <button type="button" className="ui-button mt-2" onClick={() => { void shareReferral(referralUrl, navigator).then(result => setShareStatus(result === "copied" ? "Invite link copied" : "Invite link shared")).catch(() => setShareStatus("Sharing did not finish. You can copy the link above.")); }}>Share invite</button>
      </> : <p className="mt-2 text-xs text-ink-secondary">Your invite link is unavailable right now.</p>}
      {shareStatus && <p role="status" className="mt-2 text-xs text-ink-secondary">{shareStatus}</p>}
    </div>}
    {config.flags.activationTelemetry && <div className="mt-4 border-t border-hairline/40 pt-4">
      {done ? <p role="status" className="text-sm text-success">Thanks — your useful result is recorded.</p> : <>
        <label className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5" /><span>BOS completed a useful task for me</span></label>
        <p className="mt-1 text-xs text-ink-secondary">Optional. Shares completion with BOS using your installation ID, without your conversation.</p>
        <button type="button" disabled={!confirmed || busy} className="ui-button mt-2" onClick={() => void confirm()}>{busy ? "Confirming…" : "Confirm useful result"}</button>
        {error && <p role="alert" className="mt-2 text-xs text-danger">Could not record this result. Finish a task and sign in with your email, then try again.</p>}
      </>}
    </div>}
  </Card>;
}
