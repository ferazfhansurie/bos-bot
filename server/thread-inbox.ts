import type { ThreadState } from "../shared/wire.ts";

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

/** The live signals a thread's state is read from. */
export interface ThreadStateSignals {
  waiting: boolean;
  running: boolean;
  queued: boolean;
  closed: boolean;
}
/** One precedence for bot and room threads, list_threads and the wire alike:
 * a thread that needs the person says so before it says it is working, and
 * live work always outranks a closed stamp. */
export function threadState(s: ThreadStateSignals): ThreadState {
  if (s.waiting) return "waiting-on-you";
  if (s.running) return "running";
  if (s.queued) return "queued";
  if (s.closed) return "closed";
  return "idle";
}
