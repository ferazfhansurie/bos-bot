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
}
export interface ActivityResponse { items: ActivityItem[] }
