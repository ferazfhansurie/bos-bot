import { describe, expect, it } from "vitest";
import { shouldSurfaceRoutineRun } from "./routine-notifications.ts";
describe("routine notification policy", () => {
  it.each(["all", "important", "failures"] as const)("preserves failures and missed runs under %s", notificationPolicy => {
    for (const status of ["failed", "missed"]) expect(shouldSurfaceRoutineRun({ notificationPolicy, status })).toBe(true);
    expect(shouldSurfaceRoutineRun({ notificationPolicy, status: "completed", quiet: true, important: true })).toBe(false);
  });
  it("surfaces attention under important, but failures only stays quiet", () => {
    expect(shouldSurfaceRoutineRun({ notificationPolicy: "important", status: "waiting" })).toBe(true);
    expect(shouldSurfaceRoutineRun({ notificationPolicy: "failures", status: "waiting" })).toBe(false);
    expect(shouldSurfaceRoutineRun({ notificationPolicy: "failures", status: "completed", important: true })).toBe(false);
    expect(shouldSurfaceRoutineRun({ status: "completed" })).toBe(true);
  });
});
