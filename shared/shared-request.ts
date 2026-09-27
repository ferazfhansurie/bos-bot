/** Public request metadata. Provider transcripts and approval details stay private. */
export const sharedRequestStates = ["accepted", "queued", "working", "waiting-approval", "completed", "failed", "offline", "cancelled", "outcome-unknown"] as const;
export type SharedRequestState = typeof sharedRequestStates[number];
export interface SharedRequest {
  id: string;
  roomId: string;
  roomRevision: number;
  sourceId: string;
  requesterId: string;
  botId: string;
  botName: string;
  ownerId: string;
  ownerName: string;
  state: SharedRequestState;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  resultId?: string;
  /** Fixed, room-safe explanation; never a raw provider error. */
  explanation?: string;
  cancelledBy?: string;
}
export function sharedRequestIsActive(state: SharedRequestState): boolean {
  return state === "accepted" || state === "queued" || state === "working" || state === "waiting-approval";
}
export function canCancelSharedRequest(request: SharedRequest, actorId: string): boolean {
  return sharedRequestIsActive(request.state) && (request.requesterId === actorId || request.ownerId === actorId);
}

export type SharedRequestSummary = SharedRequest & { sourceSequence: number; resultSequence?: number };
export interface SharedRequestsPage { requests: SharedRequestSummary[]; hasMore: boolean; before?: number }
export const sharedRequestLabels: Record<SharedRequestState, string> = {
  accepted: "Accepted", queued: "Queued", working: "Working", "waiting-approval": "Waiting for owner",
  completed: "Completed", failed: "Failed", offline: "Unavailable", cancelled: "Stopped", "outcome-unknown": "Outcome unknown",
};
