import { describe, expect, it } from "vitest";
import { mapClaudeUsage, mapCodexUsage } from "./provider-usage.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("subscription usage mapping", () => {
  it("keeps Claude 5h and 7d windows and their reset times", () => {
    expect(mapClaudeUsage("work", {
      five_hour: { utilization: 0.42, resets_at: "2026-09-23T04:00:00Z" },
      seven_day: { utilization: 0.8, resets_at: "2026-09-29T04:00:00Z" },
    })).toMatchObject({
      status: "available", fiveHour: { usedPercent: 42, resetsAt: 1790136000 },
      sevenDay: { usedPercent: 80 },
    });
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
