import { describe, expect, it } from "vitest";
import { mapClaudeUsage, mapCodexUsage, claudeCredentialService, readClaudeUsageToken, cachedUsage, resetUsageCache, FRESH_MS, type ProviderUsage } from "./provider-usage.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("subscription usage mapping", () => {
  it("keeps Claude 5h and 7d windows and their reset times", () => {
    expect(mapClaudeUsage("work", {
      five_hour: { utilization: 42, resets_at: "2026-09-23T04:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-09-29T04:00:00Z" },
    })).toMatchObject({
      status: "available", fiveHour: { usedPercent: 42, resetsAt: 1790136000 },
      sevenDay: { usedPercent: 80 },
    });
  });

  it("keeps percentages below or equal to one in percentage units", () => {
    for (const utilization of [0, 0.5, 1]) expect(mapClaudeUsage("personal", { seven_day: { utilization } }).sevenDay.usedPercent).toBe(utilization);
  });

  it("shows only Codex 7d and does not invent quota when absent", () => {
    expect(mapCodexUsage("codex", { rate_limit: { primary_window: { used_percent: 74, reset_at: 1790136000, limit_window_seconds: 604800 }, secondary_window: null } }))
      .toMatchObject({ status: "available", sevenDay: { usedPercent: 74, resetsAt: 1790136000 } });
    expect(mapCodexUsage("codex", null)).toMatchObject({ status: "unavailable", sevenDay: { usedPercent: null } });
  });
});

describe("provider usage endpoint", () => {
  it("returns credential-free account status from an isolated home", async () => {
    const fixture = await launchVerificationServer();
    try {
      const response = await fetch(`${fixture.info.url}/api/provider-usage`);
      expect(response.status).toBe(200);
      const payload = await response.json() as { accounts: Array<{ provider: string; status: string }> };
      expect(payload.accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "claude", status: "unavailable" }),
      ]));
      expect(JSON.stringify(payload)).not.toContain("access_token");
    } finally {
      await fixture.close();
    }
  }, 60_000);
});

 describe("selected Claude credential stores", () => {
  const oauth = (token: string, expiresAt = Date.now() + 3600_000) => ({ claudeAiOauth: { accessToken: token, expiresAt } });
  const io = (file: any, keychain: any, home = "/fake-host") => ({ platform: "darwin", home, hostHome: "/fake-host", username: "fixture", file: async () => file, keychain });
  it("uses the named account service and never falls back to the default account", async () => {
    const calls: string[] = [];
    expect(await readClaudeUsageToken("/named", "/named", io(null, async (service: string) => { calls.push(service); return oauth("named-token"); }))).toBe("named-token");
    expect(calls).toEqual([claudeCredentialService("/named")]);
    expect(calls[0]).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
    expect(claudeCredentialService("")).toBe("Claude Code-credentials");
    expect(await readClaudeUsageToken("/named", "/named", io(null, async () => { throw new Error("missing"); }))).toBeNull();
  });
  it("prefers the fresh selected store over a stale file without refreshing credentials", async () => {
    expect(await readClaudeUsageToken("/named", "/named", io(oauth("expired", 1), async () => oauth("fresh")))).toBe("fresh");
    expect(await readClaudeUsageToken("/named", "/named", io(oauth("older", Date.now()+120_000), async () => oauth("newer")))).toBe("newer");
  });
  it("keeps disposable homes away from the host keychain", async () => {
    let called = false;
    expect(await readClaudeUsageToken("/fixture", "/fixture", io(null, async () => { called=true; return oauth("host-secret"); }, "/fixture"))).toBeNull();
    expect(called).toBe(false);
  });
});

describe("usage cache", () => {
  const good = (pct: number, resetsAt: number | null = 2_000_000_000): ProviderUsage => ({ provider: "claude", account: "Work", instanceId: "claude",
    fiveHour: { usedPercent: pct, resetsAt }, sevenDay: { usedPercent: pct, resetsAt: 2_000_000_000 }, status: "available" });
  const down = (): ProviderUsage => ({ provider: "claude", account: "Work", instanceId: "claude", fiveHour: { usedPercent: null, resetsAt: null }, sevenDay: { usedPercent: null, resetsAt: null }, status: "unavailable" });
  const setup = () => { resetUsageCache(); let t = 1_000_000; const clock = { now: () => t, advance: (ms: number) => { t += ms; } }; return clock; };

  it("reads each account at most once per fresh window, even when asked concurrently", async () => {
    const clock = setup(); let calls = 0;
    const read = async () => { calls++; return { row: good(40), retryAfterMs: null }; };
    await Promise.all([cachedUsage("a", read, clock.now), cachedUsage("a", read, clock.now), cachedUsage("a", read, clock.now)]);
    clock.advance(FRESH_MS - 1); await cachedUsage("a", read, clock.now);
    expect(calls).toBe(1);
    clock.advance(2); await cachedUsage("a", read, clock.now);
    expect(calls).toBe(2);
  });

  it("keeps the last good numbers on a 429 and waits out retry-after before asking again", async () => {
    const clock = setup(); let calls = 0; let limited = false;
    const read = async () => { calls++; return limited ? { row: down(), retryAfterMs: 2422_000 } : { row: good(52), retryAfterMs: null }; };
    await cachedUsage("a", read, clock.now);
    limited = true; clock.advance(FRESH_MS);
    const row = await cachedUsage("a", read, clock.now);
    expect(row).toMatchObject({ status: "available", stale: true, checkedAt: 1_000_000, fiveHour: { usedPercent: 52 } });
    clock.advance(2421_000); await cachedUsage("a", read, clock.now);
    expect(calls).toBe(2);
    limited = false; clock.advance(1_000);
    expect(await cachedUsage("a", read, clock.now)).toMatchObject({ stale: false, fiveHour: { usedPercent: 52 } });
    expect(calls).toBe(3);
  });

  it("never asks the provider again during a backoff when it has no numbers yet", async () => {
    const clock = setup(); let calls = 0;
    const read = async () => { calls++; return { row: down(), retryAfterMs: 600_000 }; };
    expect(await cachedUsage("a", read, clock.now)).toMatchObject({ status: "unavailable" });
    clock.advance(599_000);
    expect(await cachedUsage("a", read, clock.now)).toMatchObject({ status: "unavailable" });
    expect(calls).toBe(1);
  });

  it("zeroes a stale window whose reset has passed", async () => {
    const clock = setup(); let ok = true;
    const resetsAt = Math.floor((1_000_000 + FRESH_MS + 60_000) / 1000);
    const read = async () => ok ? { row: good(90, resetsAt), retryAfterMs: null } : { row: down(), retryAfterMs: null };
    await cachedUsage("a", read, clock.now);
    ok = false; clock.advance(FRESH_MS + 120_000);
    expect(await cachedUsage("a", read, clock.now)).toMatchObject({ stale: true, fiveHour: { usedPercent: 0, resetsAt: null }, sevenDay: { usedPercent: 90 } });
  });
});
