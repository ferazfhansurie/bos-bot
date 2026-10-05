import type { JobInboxItem, JobState } from "../shared/job-inbox.ts";
import type { WorkPlan } from "./work-continuity.ts";
/** Runtime facts must come from the server's current scoped task/gate state.
 * Reading this projection never dispatches a provider or resumes a Stop hold. */
export function jobInboxItem(plan: WorkPlan, runtime: { running: boolean; held: boolean; needsHuman: boolean }): JobInboxItem {
  let state: JobState;
  let reason = plan.reason;
  if (runtime.held || plan.status === "paused") state = "paused";
  else if (runtime.needsHuman) state = "needs-you";
  else if (plan.status === "blocked") state = "blocked";
  else if (plan.status === "completed") {
    const evidenced = plan.steps.length > 0 && plan.steps.every(step => step.status === "done" && Boolean(step.evidence?.trim()));
    state = evidenced ? "completed" : "blocked";
    if (!evidenced) reason = "Completion evidence is missing";
  } else if (runtime.running) state = "moving";
  else if (plan.steps.some(step => step.status === "ready" && step.dependsOn.every(id => plan.steps.some(parent => parent.id === id && parent.status === "done")))) state = "ready";
  else if (plan.steps.some(step => step.status === "blocked")) state = "blocked";
  else state = "waiting";
  return { botId: plan.botId, threadId: plan.threadId, revision: plan.revision, outcome: plan.outcome, state,
    ...(reason ? { reason } : {}), steps: structuredClone(plan.steps),
    results: plan.steps.filter(step => step.status === "done" && Boolean(step.evidence?.trim()))
      .map(step => ({ stepId: step.id, ownerBotId: step.ownerBotId, evidence: step.evidence!, source: "owner-reported" })) };
}
