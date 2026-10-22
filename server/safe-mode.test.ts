import { afterEach, expect, test, vi } from "vitest";
import { allowInSafeMode, isSafeMode, safeModeStatus } from "./safe-mode.ts";
afterEach(() => vi.unstubAllEnvs());
test("safe mode disables optional systems and exposes the failure", () => {
  vi.stubEnv("BOS_SAFE_MODE", "1");
  vi.stubEnv("BOS_SAFE_MODE_REASON", "The server stopped repeatedly");
  expect(isSafeMode()).toBe(true);
  expect(safeModeStatus()).toEqual({ enabled: true, reason: "The server stopped repeatedly" });
  for (const feature of ["mods", "plugins", "routines"] as const) expect(allowInSafeMode(feature)).toBe(false);
});
test("normal startup allows optional systems and does not expose an old reason", () => {
  vi.stubEnv("BOS_SAFE_MODE", "0");
  expect(safeModeStatus()).toEqual({ enabled: false, reason: null });
  expect(allowInSafeMode("mods")).toBe(true);
});
