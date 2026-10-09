import { describe, expect, it } from "vitest";
import type { InboxItem } from "./inbox";
import type { JobInboxItem } from "./job-inbox";
import { isYourMoveAsk, jobNextLine, jobShortTitle, jobStatus, plainLine, splitJobs, yourMoveCount } from "./jobs-page";

const job = (overrides: Partial<JobInboxItem> = {}): JobInboxItem => ({
  botId: "bos", threadId: "t", revision: 1, outcome: "x", state: "moving", steps: [], results: [], ...overrides,
});
const row = (overrides: Partial<InboxItem>): InboxItem => ({
  id: "i", kind: "unread", botId: "bos", threadId: "t", title: "", preview: "", at: 0, ...overrides,
});

describe("jobs page helpers", () => {
  it("keeps only the person's live asks: no failed runs, unread replies or lead reports", () => {
    expect(isYourMoveAsk(row({ kind: "waiting-on-you", approval: true }))).toBe(true);
    expect(isYourMoveAsk(row({ kind: "question" }))).toBe(true);
    expect(isYourMoveAsk(row({ kind: "failed" }))).toBe(false);
    expect(isYourMoveAsk(row({ kind: "unread" }))).toBe(false);
    expect(isYourMoveAsk(row({ kind: "waiting-on-you",
      leadAction: { id: "a", leadBotId: "bos", kind: "completion", status: "pending", requiredAction: "check", updatedAt: 0 } }))).toBe(false);
  });

  it("counts the badge from asks and jobs on the person", () => {
    const asks = [row({ kind: "waiting-on-you" }), row({ kind: "failed" }), row({ kind: "unread" })];
    expect(yourMoveCount(asks, [job({ state: "needs-you" }), job({ state: "blocked" }), job({ state: "waiting" })])).toBe(3);
  });

  it("splits jobs into your move, moving, paused and done", () => {
    const split = splitJobs(["needs-you", "blocked", "moving", "ready", "waiting", "paused", "completed"].map((state, index) =>
      job({ threadId: String(index), state: state as JobInboxItem["state"] })));
    expect(split.yours.map((item) => item.state)).toEqual(["needs-you", "blocked"]);
    expect(split.moving.map((item) => item.state)).toEqual(["moving", "ready", "waiting"]);
    expect(split.paused).toHaveLength(1);
    expect(split.done).toHaveLength(1);
  });

  it("strips shas, paths and branches from a line", () => {
    expect(plainLine("prod package of 84f685aa2 is at the code-signing step")).toBe("prod package of is at the code-signing step");
    expect(plainLine("spec in /Users/f/aios/outputs/plan.md, then build")).toBe("spec in, then build");
    expect(plainLine("done 0a8ca146f on bos/needsme-no-lead-actions-20261009 from 83a7f16c1")).toBe("done from");
    expect(plainLine("closes at 10pm, decade facade")).toBe("closes at 10pm, decade facade");
    expect(plainLine("run.sh applies via :8799 once")).toBe("run.sh applies via :8799 once");
  });

  it("titles a job by its first clause, about 60 characters", () => {
    expect(jobShortTitle("launch prep: api renames, ship batches 1.9.3")).toBe("launch prep");
    expect(jobShortTitle("acme booking site fixed: closes at 10pm")).toBe("acme booking site fixed");
    expect(jobShortTitle("reconcile acme sales and estimated collection cards")).toBe("reconcile acme sales and estimated collection cards");
    const long = jobShortTitle("cad luna ai replies testable on cad's whatsapp and email by mon 12 oct; mascot icon installed");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("cad luna ai replies testable")).toBe(true);
  });

  it("gives one status word and a plain next line", () => {
    const steps: JobInboxItem["steps"] = [
      { id: "a", ownerBotId: "bos", action: "spec", status: "done", dependsOn: [] },
      { id: "b", ownerBotId: "ui", action: "build the page", status: "waiting", dependsOn: ["a"] },
      { id: "c", ownerBotId: "ship", action: "install", status: "blocked", dependsOn: ["b"], reason: "needs the cert" },
    ];
    expect(jobStatus(job({ state: "moving" }))).toEqual({ kind: "running" });
    expect(jobStatus(job({ state: "blocked" }))).toEqual({ kind: "blocked" });
    expect(jobStatus(job({ state: "paused" }))).toEqual({ kind: "paused" });
    expect(jobStatus(job({ state: "completed" }))).toEqual({ kind: "done" });
    expect(jobStatus(job({ state: "waiting", steps: steps.slice(0, 2) }))).toEqual({ kind: "waiting", botId: "ui" });
    expect(jobNextLine(job({ state: "waiting", steps: steps.slice(0, 2) }))).toBe("build the page");
    expect(jobNextLine(job({ state: "blocked", steps }))).toBe("needs the cert");
    expect(jobNextLine(job({ state: "needs-you", reason: "approve the install", steps }))).toBe("approve the install");
  });
});
