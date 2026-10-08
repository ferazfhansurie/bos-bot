// What the sidebar usage row says, as data: one chip per provider. Pure so
// the wording and the "which account wins" rule are testable without React.

export type UsageWindow = { usedPercent: number | null; resetsAt: number | null };
export type UsageAccount = {
  provider: "claude" | "codex";
  account: string;
  fiveHour?: UsageWindow;
  sevenDay: UsageWindow;
  status: string;
};

export interface XaiUsage {
  voice: {
    period: string;
    calls: number;
    seconds: number;
    unmeasured: number;
    today: { calls: number; seconds: number };
    days: Array<{ date: string; calls: number; seconds: number }>;
  };
  credits:
    | { configured: false }
    | {
        configured: true;
        credits: {
          purchasedCents: number;
          usedCents: number;
          remainingCents: number;
          voiceSeconds: number;
          voiceCents: number;
          cycle: string | null;
        } | null;
        fetchedAt: number | null;
        error: string | null;
      };
}

export interface UsageChip {
  key: "claude" | "codex" | "xai";
  label: string;
  value: string;
  /** 0-100, how close to the cap (for xAI: how much of the credit is spent) */
  peak: number | null;
  title: string;
}

const pct = (value: number | null) => (value === null ? "–" : `${Math.round(value)}%`);

export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function formatSeconds(seconds: number): string {
  if (seconds < 1) return "0 min";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  return minutes < 10 ? `${minutes.toFixed(1)} min` : `${Math.round(minutes)} min`;
}

function windows(account: UsageAccount) {
  return [
    account.fiveHour ? { label: "5h", ...account.fiveHour } : null,
    { label: "7d", ...account.sevenDay },
  ].filter((w): w is NonNullable<typeof w> => w !== null);
}

function peakOf(account: UsageAccount): number | null {
  const known = windows(account).map((w) => w.usedPercent).filter((p): p is number => p !== null);
  return known.length ? Math.max(...known) : null;
}

function providerChip(provider: "claude" | "codex", accounts: UsageAccount[]): UsageChip | null {
  const mine = accounts.filter((a) => a.provider === provider);
  if (mine.length === 0) return null;
  // with two accounts on one provider, the row shows the one nearest its cap
  const worst = mine.reduce((a, b) => ((peakOf(b) ?? -1) > (peakOf(a) ?? -1) ? b : a));
  const list = windows(worst);
  const title = mine
    .map((account) => `${account.account}\n` + windows(account)
      .map((w) => `  ${w.label}: ${w.usedPercent === null ? "unavailable" : `${Math.round(w.usedPercent)}% used`}${w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ""}`)
      .join("\n"))
    .join("\n");
  return {
    key: provider,
    label: provider,
    value: list.length > 1 ? `${list.map((w) => (w.usedPercent === null ? "–" : Math.round(w.usedPercent))).join("·")}%` : pct(list[0]?.usedPercent ?? null),
    peak: peakOf(worst),
    title: `${provider === "claude" ? "Claude" : "Codex"} (${list.map((w) => w.label).join(" · ")})\n${title}`,
  };
}

function xaiChip(xai: XaiUsage | null): UsageChip | null {
  if (!xai) return null;
  const voice = `voice this month: ${xai.voice.calls} call${xai.voice.calls === 1 ? "" : "s"}, ${formatSeconds(xai.voice.seconds)}`;
  const credits = xai.credits.configured ? xai.credits.credits : null;
  if (credits) {
    return {
      key: "xai",
      label: "xai",
      value: formatCents(credits.remainingCents),
      peak: credits.purchasedCents > 0 ? Math.min(100, (credits.usedCents / credits.purchasedCents) * 100) : null,
      title: `xAI credits: ${formatCents(credits.remainingCents)} left of ${formatCents(credits.purchasedCents)}\n${voice}`,
    };
  }
  // no management key (or xAI unreachable with nothing cached): minutes instead
  const hint = xai.credits.configured ? "" : "\nadd a management key in Settings → Usage to see credits left";
  return { key: "xai", label: "xai", value: formatSeconds(xai.voice.seconds), peak: null, title: `xAI ${voice}${hint}` };
}

export function usageChips(accounts: UsageAccount[] | null, xai: XaiUsage | null): UsageChip[] {
  return [providerChip("claude", accounts ?? []), providerChip("codex", accounts ?? []), xaiChip(xai)].filter(
    (chip): chip is UsageChip => chip !== null,
  );
}

export function barTone(percent: number) {
  return percent >= 85 ? "bg-red-500" : percent >= 65 ? "bg-amber-500" : "bg-accent";
}

export function ago(fetchedAt: number | null, now = Date.now()): string {
  if (fetchedAt === null) return "never";
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(fetchedAt).toLocaleString();
}
