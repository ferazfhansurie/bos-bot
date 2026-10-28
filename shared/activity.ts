/** Metadata only. A snapshot replaces the previous list, including removals. */
export type ActivityState = "idle" | "thinking" | "tool" | "typing" | "waiting" | "failed" | "stopped";
export interface ActivityItem {
  botId: string;
  threadId: string;
  roomId: string | null;
  state: ActivityState;
  /** Epoch milliseconds when this state was first observed. */
  since: number;
  turnId?: string;
  /** Busy threads only: when the whole job began, not this state. */
  jobSince?: number;
  /** What it is doing, in plain words ("reading retry.ts"). */
  step?: string;
  /** The plan's step in progress (1-based) and its size. */
  stepIndex?: number;
  stepCount?: number;
}
export interface ActivityResponse { items: ActivityItem[] }
