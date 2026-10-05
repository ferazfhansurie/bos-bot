/** Read-only projection of a scoped work plan. Completion evidence belongs to
 * its reporting owner; this response does not independently validate artifacts. */
export type JobState = "ready" | "moving" | "needs-you" | "paused" | "blocked" | "waiting" | "completed";
export interface JobInboxItem {
  botId: string;
  threadId: string;
  revision: number;
  outcome: string;
  state: JobState;
  reason?: string;
  steps: { id: string; ownerBotId: string; action: string; status: "ready" | "waiting" | "blocked" | "done"; dependsOn: string[]; reason?: string; evidence?: string }[];
  results: { stepId: string; ownerBotId: string; evidence: string; source: "owner-reported" }[];
}
export interface JobInboxResponse { items: JobInboxItem[] }
