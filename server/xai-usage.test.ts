import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createXaiCreditsReader,
  fetchXaiCredits,
  flushVoiceUsage,
  recordVoiceCallEnd,
  recordVoiceCallStart,
  summarizeVoiceUsage,
  voiceUsageFileFor,
} from "./xai-usage.ts";

const TEAM = "fa284172-703e-4613-870f-22ac5017ab20";

// The shapes xAI's management API returned on 2026-10-08.
function fakeXai(overrides: { status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({ authorization: "Bearer mgmt-key" });
    if (overrides.status) return new Response("{}", { status: overrides.status });
    const path = new URL(String(url)).pathname;
    if (path === "/auth/management-keys/validation") return Response.json({ teamId: TEAM, scope: "SCOPE_TEAM" });
    if (path === `/v1/billing/teams/${TEAM}/prepaid/balance`) return Response.json({ changes: [], total: { val: "-500" } });
    if (path === `/v1/billing/teams/${TEAM}/postpaid/invoice/preview`) {
      return Response.json({
        coreInvoice: {
          lines: [{ description: "API grok-voice-3.0", unitType: "Duration (seconds)", numUnits: "167", amount: "22" }],
          prepaidCredits: { val: "-500" },
          prepaidCreditsUsed: { val: "-22" },
        },
        billingCycle: { year: 2026, month: 10 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("voice call tally", () => {
  it("counts a call once across reconnects, with its reported length, by start day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-usage-"));
    const day = new Date("2026-10-08T03:00:00Z");
    await recordVoiceCallStart(dir, "call-aaaaaaaa", "bot-1", day);
    await recordVoiceCallStart(dir, "call-aaaaaaaa", "bot-1", new Date("2026-10-08T03:01:00Z"));
    await recordVoiceCallEnd(dir, "call-aaaaaaaa", 95.4, new Date("2026-10-08T03:02:00Z"));
    await recordVoiceCallStart(dir, "call-bbbbbbbb", null, new Date("2026-10-07T10:00:00Z"));
    await flushVoiceUsage(dir);
    const tally = summarizeVoiceUsage(dir, day);
    expect(tally).toMatchObject({ period: "2026-10", calls: 2, seconds: 95, unmeasured: 1, today: { calls: 1, seconds: 95 } });
    expect(tally.days).toEqual([
      { date: "2026-10-07", calls: 1, seconds: 0 },
      { date: "2026-10-08", calls: 1, seconds: 95 },
    ]);
    const file = voiceUsageFileFor(dir, day);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // ids and seconds only
    expect(readFileSync(file, "utf8")).not.toMatch(/transcript|audio|text/);
  });

  it("clamps nonsense lengths and reads an empty month as zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-usage-"));
    const at = new Date("2026-10-08T03:00:00Z");
    expect(summarizeVoiceUsage(dir, at)).toMatchObject({ calls: 0, seconds: 0, days: [] });
    await recordVoiceCallStart(dir, "call-cccccccc", null, at);
    await recordVoiceCallEnd(dir, "call-cccccccc", 10 ** 9, at);
    await flushVoiceUsage(dir);
    expect(summarizeVoiceUsage(dir, at).seconds).toBe(4 * 60 * 60);
  });
});

describe("xAI credits", () => {
  it("reads credits left and voice seconds from the management api", async () => {
    const { impl } = fakeXai();
    await expect(fetchXaiCredits("mgmt-key", impl)).resolves.toEqual({
      purchasedCents: 500,
      usedCents: 22,
      remainingCents: 478,
      voiceSeconds: 167,
      voiceCents: 22,
      cycle: "2026-10",
    });
  });

  it("without a management key reports unconfigured and never calls xAI", async () => {
    const { impl, calls } = fakeXai();
    const read = createXaiCreditsReader(impl);
    await expect(read(undefined)).resolves.toEqual({ configured: false });
    await expect(read("  ")).resolves.toEqual({ configured: false });
    expect(calls).toEqual([]);
  });

  it("caches for 5 minutes and keeps the last value when xAI goes away", async () => {
    let now = 1_000_000;
    let down = false;
    const ok = fakeXai().impl;
    const broken = fakeXai({ status: 503 }).impl;
    let hits = 0;
    const impl = ((url: string | URL, init?: RequestInit) => {
      hits += 1;
      return (down ? broken : ok)(url, init);
    }) as typeof fetch;
    const read = createXaiCreditsReader(impl, () => now);
    const first = await read("mgmt-key");
    expect(first).toMatchObject({ configured: true, fetchedAt: 1_000_000, error: null });
    await read("mgmt-key");
    expect(hits).toBe(3);
    down = true;
    now += 5 * 60_000;
    const offline = await read("mgmt-key");
    expect(offline).toMatchObject({ configured: true, fetchedAt: 1_000_000, error: "xAI billing is unavailable (503)" });
    expect(offline.configured && offline.credits?.remainingCents).toBe(478);
  });

  it("names a rejected key without echoing xAI's body", async () => {
    await expect(fetchXaiCredits("mgmt-key", fakeXai({ status: 403 }).impl)).rejects.toThrow("xAI rejected the management key");
  });
});
