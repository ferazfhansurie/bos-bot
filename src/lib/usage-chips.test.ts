import { describe, expect, it } from "vitest";
import { ago, formatSeconds, usageChips, type UsageAccount, type XaiUsage } from "./usage-chips";

const claude: UsageAccount = {
  provider: "claude",
  account: "firaz@x",
  fiveHour: { usedPercent: 9.4, resetsAt: null },
  sevenDay: { usedPercent: 27, resetsAt: null },
  status: "ok",
};
const codex: UsageAccount = { provider: "codex", account: "chatgpt", sevenDay: { usedPercent: 59, resetsAt: null }, status: "ok" };
const voice = { period: "2026-10", calls: 2, seconds: 167, unmeasured: 0, today: { calls: 1, seconds: 60 }, days: [] };

describe("sidebar usage chips", () => {
  it("shows claude 5h·7d, codex 7d and xai credits left", () => {
    const xai: XaiUsage = {
      voice,
      credits: {
        configured: true,
        credits: { purchasedCents: 500, usedCents: 22, remainingCents: 478, voiceSeconds: 167, voiceCents: 22, cycle: "2026-10" },
        fetchedAt: 1,
        error: null,
      },
    };
    const chips = usageChips([claude, codex], xai);
    expect(chips.map(({ key, value }) => [key, value])).toEqual([
      ["claude", "9·27%"],
      ["codex", "59%"],
      ["xai", "$4.78"],
    ]);
    expect(chips[0].peak).toBe(27);
    expect(chips[2].peak).toBeCloseTo(4.4);
  });

  it("falls back to voice minutes without a management key", () => {
    expect(usageChips([], { voice, credits: { configured: false } })).toEqual([
      expect.objectContaining({ key: "xai", value: "2.8 min", peak: null }),
    ]);
    // never used, no key: a new install shows nothing for xai
    expect(usageChips(null, { voice: { ...voice, calls: 0, seconds: 0 }, credits: { configured: false } })).toEqual([]);
    expect(usageChips(null, null)).toEqual([]);
  });

  it("hides a provider that reports no numbers (not signed in)", () => {
    const blank: UsageAccount = { provider: "claude", account: "none", fiveHour: { usedPercent: null, resetsAt: null }, sevenDay: { usedPercent: null, resetsAt: null }, status: "ok" };
    expect(usageChips([blank, codex], null).map((chip) => chip.key)).toEqual(["codex"]);
  });

  it("picks the account nearest its cap when a provider has two", () => {
    const hot = { ...claude, account: "second", fiveHour: { usedPercent: 91, resetsAt: null } };
    expect(usageChips([claude, hot], null)[0]).toMatchObject({ value: "91·27%", peak: 91 });
  });

  it("formats short durations and ages", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(167)).toBe("2.8 min");
    expect(formatSeconds(1800)).toBe("30 min");
    expect(ago(null)).toBe("never");
    expect(ago(1000, 1000 + 7 * 60_000)).toBe("7 min ago");
  });
});
