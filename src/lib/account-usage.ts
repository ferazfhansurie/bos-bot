import type { UsageAccount } from "./usage-chips";

const COLORS = { claude: ["#D97757", "#E5B567", "#B78BE0"], codex: ["#4C8DF6", "#66C7C0"] };

export function accountPeak(account: UsageAccount): number | null {
  const values = [account.fiveHour?.usedPercent, account.sevenDay.usedPercent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(100, Math.max(0, ...values)) : null;
}

export function accountRings(accounts: UsageAccount[]) {
  const sorted = [...accounts].sort((a, b) => a.provider.localeCompare(b.provider) ||
    (a.instanceId ?? a.account).localeCompare(b.instanceId ?? b.account));
  const size = Math.max(42, 29 + sorted.length * 6.5);
  const index = { claude: 0, codex: 0 };
  return sorted.map((account, position) => ({
    account,
    key: `${account.provider}:${account.instanceId ?? account.account}`,
    label: `${account.account} · ${account.provider === "claude" ? "Claude" : "Codex"}`,
    color: COLORS[account.provider][index[account.provider]++ % COLORS[account.provider].length]!,
    peak: accountPeak(account),
    radius: size / 2 - 1.25 - position * 3.25,
    size,
  }));
}

export function accountBotNames(instanceId: string | undefined, bots: ReadonlyArray<{
  name: string; modelSelection: { instanceId: string }; homeLink?: unknown; remote?: unknown;
}>) {
  return instanceId ? bots.filter(bot => !bot.homeLink && !bot.remote && bot.modelSelection.instanceId === instanceId).map(bot => bot.name) : [];
}
