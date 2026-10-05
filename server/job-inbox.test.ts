import { describe, expect, it } from "vitest";
import { jobInboxItem } from "./job-inbox.ts";
import type { WorkPlan } from "./work-continuity.ts";
const plan = (over: Partial<WorkPlan> = {}): WorkPlan => ({ botId: "bos", threadId: "thread", revision: 1, attempts: 0, terminalIds: [], outcome: "Ship the app", status: "active", steps: [{ id: "build", ownerBotId: "bos", action: "Build", status: "ready", dependsOn: [] }], ...over });
describe("job inbox truthfulness", () => {
  it("does not present ready work as running", () => expect(jobInboxItem(plan(), { running: false, held: false, needsHuman: false }).state).toBe("ready"));
  it("shows actual running work", () => expect(jobInboxItem(plan(), { running: true, held: false, needsHuman: false }).state).toBe("moving"));
  it("keeps Stop visible even while a provider drains", () => expect(jobInboxItem(plan(), { running: true, held: true, needsHuman: false }).state).toBe("paused"));
  it("surfaces a human gate ahead of running state", () => expect(jobInboxItem(plan(), { running: true, held: false, needsHuman: true }).state).toBe("needs-you"));
  it("does not accept completed status without every step's evidence", () => expect(jobInboxItem(plan({ status: "completed" }), { running: false, held: false, needsHuman: false }).state).toBe("blocked"));
  it("returns each owner's completion evidence without upgrading its authority", () => {
    const item = jobInboxItem(plan({ status: "completed", steps: [{ id: "build", ownerBotId: "bos", action: "Build", status: "done", dependsOn: [], evidence: "Release build passed" }] }), { running: false, held: false, needsHuman: false });
    expect(item.state).toBe("completed");
    expect(item.results).toEqual([{ stepId: "build", ownerBotId: "bos", evidence: "Release build passed", source: "owner-reported" }]);
  });
});
