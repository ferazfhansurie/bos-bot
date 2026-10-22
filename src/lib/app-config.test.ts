import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api: request }));
beforeEach(() => { vi.resetModules(); request.mockReset(); });
it("coalesces simultaneous turn config readers and reuses a validated snapshot", async () => {
  request.mockResolvedValue({ config: { version: 1, flags: { feedback: false } } });
  const { getAppConfig } = await import("./app-config");
  const [first, second] = await Promise.all([getAppConfig(), getAppConfig()]);
  expect(first).toBe(second); expect(first.flags.feedback).toBe(false);
  await getAppConfig(); expect(request).toHaveBeenCalledTimes(1);
});
