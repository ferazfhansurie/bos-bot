// Approval double-submit guard (PIX-05). The composer always shows the
// oldest open approval, and the reducer leaves the card in place until the
// server confirms. Without a guard, a fast double-click answers the shown
// request twice, or — once the server confirms between the two clicks —
// answers the NEXT queued request before the person has even seen it.

/** After an answer, a newly shown request ignores clicks for this long. */
export const APPROVAL_REARM_MS = 600;
/** Never leave a request locked forever if its answer hangs; let them retry. */
export const APPROVAL_STUCK_MS = 15_000;

export interface LastDecision {
  requestId: string;
  at: number;
}

/** Whether the decision buttons for `requestId` should ignore input now. */
export function approvalActionsLocked(last: LastDecision | null, requestId: string, now: number): boolean {
  if (!last) return false;
  const elapsed = now - last.at;
  if (last.requestId === requestId) return elapsed < APPROVAL_STUCK_MS;
  return elapsed < APPROVAL_REARM_MS;
}

/** When the lock computed above next changes, or null if it never will. */
export function approvalActionsUnlockIn(last: LastDecision | null, requestId: string, now: number): number | null {
  if (!approvalActionsLocked(last, requestId, now) || !last) return null;
  const window = last.requestId === requestId ? APPROVAL_STUCK_MS : APPROVAL_REARM_MS;
  return Math.max(0, last.at + window - now);
}

// Store-level: one answer per request in flight, whichever surface sent it
// (composer, voice call, question card).
const inFlight = new Set<string>();

export function claimDecision(threadId: string, requestId: string): boolean {
  const key = `${threadId}\u0000${requestId}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseDecision(threadId: string, requestId: string): void {
  inFlight.delete(`${threadId}\u0000${requestId}`);
}
