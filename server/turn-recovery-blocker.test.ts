import { expect, it } from "vitest";
import { turnRecoveryBlocker } from "./turn-recovery-blocker.ts";
it("holds uncertain thread and overlapping folders until durable explicit review", () => {
  const held = { state: "outcome-unknown", threadId: "old-thread", workspace: "workspace:/fixture/project" };
  expect(turnRecoveryBlocker([held], { threadId: "old-thread" })).toBe(held);
  expect(turnRecoveryBlocker([held], { workspace: "workspace:/fixture/project/nested" })).toBe(held);
  expect(turnRecoveryBlocker([held], { workspace: "workspace:/fixture" })).toBe(held);
  expect(turnRecoveryBlocker([held], { workspace: "workspace:/fixture/project-other" })).toBeUndefined();
  expect(turnRecoveryBlocker([{ ...held, reviewedAt: 1 }], { threadId: "old-thread" })).toBeDefined();
  expect(turnRecoveryBlocker([{ ...held, reviewedAt: 1, reviewedBy: "person" }], { workspace: "workspace:/fixture/project" })).toBeUndefined();
  expect(turnRecoveryBlocker([{ ...held, state: "dispatching" }], { workspace: "workspace:/fixture/project" })).toBeUndefined();
});
