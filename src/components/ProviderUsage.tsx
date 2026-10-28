import { api } from "@/state/store";
import { createUsageFeed, useFeed } from "@/lib/usage-feed";
import { Card } from "./SettingsPrimitives";
import { XaiVoiceTile } from "./XaiUsage";
import { ago } from "@/lib/usage-chips";
import { accountRings } from "@/lib/account-usage";
import { useProfileUsageVisibility } from "@/lib/profile-usage-visibility";

export type { UsageWindow as Window, UsageAccount as Account } from "@/lib/usage-chips";
import type { UsageWindow as Window, UsageAccount as Account } from "@/lib/usage-chips";

function Meter({ label, window }: { label: string; window: Window }) {
  const percent = window.usedPercent;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString() : null;
  return <div className="space-y-1">
    <div className="flex justify-between text-[12px] text-ink-secondary"><span>{label}</span><span>{percent === null ? "Unavailable" : `${Math.round(percent)}% used`}</span></div>
    {percent !== null && <div className="h-1.5 rounded-full bg-hairline/40 overflow-hidden"><div className={`h-full rounded-full ${percent >= 85 ? "bg-red-500" : percent >= 65 ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>}
    {reset && <div className="text-[11px] text-ink-secondary">Resets {reset}</div>}
  </div>;
}

// Live Claude/Codex account quotas. One fetch for the window, shared by the
// settings card and the sidebar usage row (src/lib/usage-feed.ts).
export const providerUsageFeed = createUsageFeed<Account[]>("bos.usage.providers", {
  load: () => api<{ accounts: Account[] }>("/api/provider-usage").then((result) => result.accounts),
});

export function useProviderUsage() {
  const { value, failed, fetchedAt } = useFeed(providerUsageFeed);
  return { accounts: value, failed: failed && value === null, stale: failed, fetchedAt };
}

export function ProviderUsage() {
  const { accounts, failed, stale, fetchedAt } = useProviderUsage();
  const { hidden, setVisible } = useProfileUsageVisibility();
  return <Card title="Subscription limits" subtitle="Live account quotas. These are separate from bot token usage and spend.">
    <div className="grid gap-4 sm:grid-cols-2">
      {failed ? <div className="text-[13px] text-ink-secondary">Usage unavailable. Retrying automatically.</div> : accounts === null ? <div className="text-[13px] text-ink-secondary">Loading…</div> : accounts.length === 0 ? <div className="text-[13px] text-ink-secondary">No Claude or Codex account configured.</div> :
        accountRings(accounts).map(({ account, key }) => <div key={key} className="rounded-xl border border-hairline/40 p-3 space-y-3">
          <div className="text-[13px] font-medium text-ink">{account.provider === "claude" ? "Claude" : "Codex"} · {account.account}</div>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <input type="checkbox" checked={!hidden.includes(key)} onChange={event => setVisible(key, event.target.checked)} />
            Show {account.account} around my profile
          </label>
          {account.fiveHour && <Meter label="5h" window={account.fiveHour} />}
          <Meter label="7d" window={account.sevenDay} />
          {account.stale && account.checkedAt && <div className="text-[11px] text-ink-secondary">Last read {ago(account.checkedAt)}</div>}
        </div>)}
      <XaiVoiceTile />
    </div>
    {stale && fetchedAt !== null && <div className="mt-2 text-[11px] text-ink-secondary">Offline · limits last read {ago(fetchedAt)}</div>}
  </Card>;
}
