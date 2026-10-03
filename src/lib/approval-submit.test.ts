import { describe, expect, it } from "vitest";

import {
  APPROVAL_REARM_MS,
  APPROVAL_STUCK_MS,
  approvalActionsLocked,
  approvalActionsUnlockIn,
  claimDecision,
  releaseDecision,
} from "./approval-submit";

describe("approval double-submit guard", () => {
  it("is open before any answer", () => {
    expect(approvalActionsLocked(null, "a", 0)).toBe(false);
    expect(approvalActionsUnlockIn(null, "a", 0)).toBeNull();
  });

  it("locks the request being answered while its answer is in flight", () => {
    const last = { requestId: "a", at: 1000 };
    expect(approvalActionsLocked(last, "a", 1001)).toBe(true);
    expect(approvalActionsLocked(last, "a", 1000 + APPROVAL_REARM_MS + 100)).toBe(true);
  });

  it("never strands a request whose answer hangs", () => {
    const last = { requestId: "a", at: 1000 };
    expect(approvalActionsLocked(last, "a", 1000 + APPROVAL_STUCK_MS)).toBe(false);
  });

  it("ignores the second click of a double-click when the next request appears in between", () => {
    const last = { requestId: "a", at: 1000 };
    expect(approvalActionsLocked(last, "b", 1000 + 120)).toBe(true);
    expect(approvalActionsUnlockIn(last, "b", 1000 + 120)).toBe(APPROVAL_REARM_MS - 120);
    expect(approvalActionsLocked(last, "b", 1000 + APPROVAL_REARM_MS)).toBe(false);
  });

  it("sends one answer per request at a time, from any surface", () => {
    expect(claimDecision("t", "r")).toBe(true);
    expect(claimDecision("t", "r")).toBe(false);
    expect(claimDecision("t", "other")).toBe(true);
    releaseDecision("t", "r");
    releaseDecision("t", "other");
    expect(claimDecision("t", "r")).toBe(true);
    releaseDecision("t", "r");
  });
});
