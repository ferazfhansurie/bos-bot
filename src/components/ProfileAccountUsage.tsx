import { useStore } from "@/state/store";
import { accountBotNames, accountRings, USAGE_DANGER } from "@/lib/account-usage";
import { useProviderUsage } from "./ProviderUsage";
import { useProfileUsageVisibility } from "@/lib/profile-usage-visibility";

export function ProfileAccountUsage({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore();
  const { accounts, stale } = useProviderUsage();
  const { hidden } = useProfileUsageVisibility();
  const rings = accountRings(accounts ?? []).filter(ring => !hidden.includes(ring.key));
  if (!rings.length) return null;
  return <div className="max-h-[45vh] overflow-y-auto border-b border-hairline/50 px-3.5 pb-2.5" data-testid="profile-account-usage">
    <div className="py-2 text-[11px] text-ink-secondary">Accounts{stale ? " · offline, last known usage" : ""}</div>
    {rings.map(ring => {
      const names = accountBotNames(ring.account.instanceId, state.bots);
      const windows = [
        ...(ring.account.fiveHour ? [{ ...ring.account.fiveHour, label: "5h" }] : []),
        { ...ring.account.sevenDay, label: "7d" },
      ];
      return <button key={ring.key} type="button" role="menuitem"
        aria-label={`Manage ${ring.label}`}
        onClick={() => { dispatch({ type: "toggleAppSettings", open: true, section: "engines" }); onDone(); }}
        className="mb-1 block w-full rounded-lg p-2 text-left hover:bg-raised/70 focus-visible:outline focus-visible:outline-hairline">
        <span className="flex items-center gap-2 text-[13px] text-ink">
          <span className="size-2 shrink-0 rounded-full" style={{ background: ring.color }} />
          <span className="min-w-0 flex-1 truncate">{ring.label}</span>
          <span className="text-[11px] text-ink-secondary">Manage</span>
        </span>
        <span className="mt-1 block text-[11.5px] text-ink-secondary">{names.length ? names.join(" + ") : "No bot defaults assigned"}</span>
        {windows.map(window => <span key={window.label} className="mt-1 block text-[11px] text-ink-secondary">
          <span className={window.usedPercent !== null && window.usedPercent >= USAGE_DANGER ? "font-medium text-danger" : undefined}>{window.label} {window.usedPercent === null ? "usage unavailable" : `${Math.round(window.usedPercent)}% used`}</span>
          {window.resetsAt ? ` · resets ${new Date(window.resetsAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
          {window.usedPercent !== null && <span className="mt-1 block h-1 overflow-hidden rounded-full bg-hairline/40">
            <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%`, background: ring.color }} />
          </span>}
        </span>)}
      </button>;
    })}
    <div className="px-2 text-[10.5px] text-ink-secondary">Bot defaults shown. Individual threads can use another account.</div>
  </div>;
}
