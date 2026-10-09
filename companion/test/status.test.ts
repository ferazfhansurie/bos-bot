import { describe, expect, it } from "vitest";

import { companionStatusSnapshot, isReportedCompanionStatus } from "../src/status.ts";

describe("companionStatusSnapshot", () => {
  it("is off with keep-awake false before the desktop reports anything", () => {
    expect(companionStatusSnapshot(null)).toEqual({ hosted: { status: "off" }, keepAwake: false });
  });

  it("is ready with the url exactly when a hosted url is advertised", () => {
    expect(
      companionStatusSnapshot("https://c-1.openmausbot.test", { hosted: "ready", keepAwake: true }),
    ).toEqual({ hosted: { status: "ready", url: "https://c-1.openmausbot.test" }, keepAwake: true });
    // the advertised URL wins over a stale report
    expect(
      companionStatusSnapshot("https://c-1.openmausbot.test", { hosted: "provisioning", keepAwake: false }),
    ).toEqual({ hosted: { status: "ready", url: "https://c-1.openmausbot.test" }, keepAwake: false });
  });

  it("never claims ready, or carries a url, without an advertised route", () => {
    expect(companionStatusSnapshot(null, { hosted: "ready", keepAwake: true })).toEqual({
      hosted: { status: "provisioning" },
      keepAwake: true,
    });
    for (const hosted of ["off", "provisioning", "error"] as const) {
      expect(companionStatusSnapshot(null, { hosted, keepAwake: false })).toEqual({
        hosted: { status: hosted },
        keepAwake: false,
      });
    }
  });
});

describe("isReportedCompanionStatus", () => {
  it("accepts exactly {hosted, keepAwake} with known values", () => {
    expect(isReportedCompanionStatus({ hosted: "error", keepAwake: true })).toBe(true);
    expect(isReportedCompanionStatus({ keepAwake: false, hosted: "off" })).toBe(true);
    for (const value of [
      null,
      [],
      "off",
      {},
      { hosted: "off" },
      { keepAwake: true },
      { hosted: "on", keepAwake: true },
      { hosted: "ready", keepAwake: "yes" },
      { hosted: "ready", keepAwake: true, url: "https://c-1.openmausbot.test" },
    ]) {
      expect(isReportedCompanionStatus(value), JSON.stringify(value)).toBe(false);
    }
  });
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data
