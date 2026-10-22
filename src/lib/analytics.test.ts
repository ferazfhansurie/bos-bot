import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api: request }));
const values = new Map<string, string>();
beforeEach(() => {
  vi.resetModules(); request.mockReset(); values.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
it("follows server optout, never guesses from a legacy browser flag", async () => {
  request.mockResolvedValue({ analyticsEnabled: false });
  const analytics = await import("./analytics");
  await analytics.initAnalytics(); analytics.track("open");
  expect(analytics.analyticsEnabled()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
it("forwards only safe event fields through the local server, never email as event props", async () => {
  request.mockResolvedValue({ analyticsEnabled: true });
  const analytics = await import("./analytics"); await analytics.initAnalytics();
  analytics.track("message_sent", { prompt: "private", count: 1 });
  expect(request.mock.calls.at(-1)).toEqual(["/api/product/events", { method: "POST", body: JSON.stringify({ events: [{ name: "message_sent", props: { count: 1 } }] }) }]);
  analytics.identifyEmail("typed@example.com");
  expect(request).toHaveBeenCalledTimes(2);
  analytics.track("onboarding_completed");
  expect(request.mock.calls.at(-1)).toEqual(["/api/product/claim", { method: "POST", body: JSON.stringify({ email: "typed@example.com" }) }]);
  expect(JSON.stringify(request.mock.calls.filter(call => call[0] === "/api/product/events"))).not.toContain("typed@example.com");
});
it("clears a pending email on optout and preserves email gate behavior", async () => {
  request.mockResolvedValue({ analyticsEnabled: true });
  const analytics = await import("./analytics"); await analytics.initAnalytics();
  analytics.identifyEmail("typed@example.com"); analytics.setAnalyticsEnabled(false); analytics.track("onboarding_completed");
  expect(request).toHaveBeenCalledTimes(1);
  expect(analytics.emailGateDone()).toBe(false); analytics.setEmailGateDone("skipped"); expect(analytics.emailGateDone()).toBe(true);
});
