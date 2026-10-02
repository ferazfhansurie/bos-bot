/** Inbox settlement is metadata-only: never delete a transcript or event log. */
export interface InboxCandidate {
  lastActivityAt: number;
  closed: boolean;
  archived: boolean;
  unread: boolean;
  busy: boolean;
  queued: boolean;
  needsInput: boolean;
  pendingWork: boolean;
}
export function inboxCanClose(c: InboxCandidate): boolean {
  return !c.closed && !c.archived && !c.unread && !c.busy && !c.queued && !c.needsInput && !c.pendingWork;
}
export function inboxShouldSettle(c: InboxCandidate, days: number, now = Date.now()): boolean {
  return Number.isInteger(days) && days > 0 && Number.isFinite(c.lastActivityAt)
    && c.lastActivityAt > 0 && c.lastActivityAt <= now - days * 86_400_000 && inboxCanClose(c);
}
