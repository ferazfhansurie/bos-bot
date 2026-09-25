import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

type Window = { usedPercent: number | null; resetsAt: number | null };
type Account = { provider: "claude" | "codex"; account: string; fiveHour?: Window; sevenDay: Window; status: string };

function Meter({ label, window }: { label: string; window: Window }) {
  const percent = window.usedPercent;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString() : null;
  return <div className="space-y-1">
    <div className="flex justify-between text-[12px] text-ink-secondary"><span>{label}</span><span>{percent === null ? "Unavailable" : `${Math.round(percent)}% used`}</span></div>
    {percent !== null && <div className="h-1.5 rounded-full bg-hairline/40 overflow-hidden"><div className={`h-full rounded-full ${percent >= 85 ? "bg-red-500" : percent >= 65 ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>}
    {reset && <div className="text-[11px] text-ink-secondary">Resets {reset}</div>}
  </div>;
}

export function ProviderUsage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => api<{ accounts: Account[] }>("/api/provider-usage").then((result) => { if (active) { setAccounts(result.accounts); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    void load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <Card title="Subscription limits" subtitle="Live account quotas. These are separate from bot token usage and spend.">
    {failed ? <div className="text-[13px] text-ink-secondary">Usage unavailable. Retrying automatically.</div> : accounts === null ? <div className="text-[13px] text-ink-secondary">Loading…</div> : accounts.length === 0 ? <div className="text-[13px] text-ink-secondary">No Claude or Codex account configured.</div> :
      <div className="grid gap-4 sm:grid-cols-2">{accounts.map((account, index) => <div key={`${account.provider}-${index}`} className="rounded-xl border border-hairline/40 p-3 space-y-3">
        <div className="text-[13px] font-medium text-ink">{account.provider === "claude" ? "Claude" : "Codex"} · {account.account}</div>
        {account.fiveHour && <Meter label="5h" window={account.fiveHour} />}
        <Meter label="7d" window={account.sevenDay} />
      </div>)}</div>}
  </Card>;
}
