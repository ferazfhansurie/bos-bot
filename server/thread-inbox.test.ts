import { describe, expect, it } from "vitest";
import { inboxCanClose, inboxShouldSettle, threadState, type InboxCandidate, type ThreadStateSignals } from "./thread-inbox.ts";
const now = 1_800_000_000_000;
const base: InboxCandidate = { lastActivityAt: now - 3 * 86_400_000, closed: false, archived: false, unread: false, busy: false, queued: false, needsInput: false, pendingWork: false };
describe("inbox settlement", () => {
  it("closes at the exact configured age, and never when switched off", () => {
    expect(inboxShouldSettle(base, 3, now)).toBe(true);
    expect(inboxShouldSettle({ ...base, lastActivityAt: base.lastActivityAt + 1 }, 3, now)).toBe(false);
    expect(inboxShouldSettle(base, 0, now)).toBe(false);
  });
  it.each(["closed", "archived", "unread", "busy", "queued", "needsInput", "pendingWork"] as const)("protects %s", field => {
    const candidate = { ...base, [field]: true };
    expect(inboxShouldSettle(candidate, 3, now)).toBe(false);
    expect(inboxCanClose(candidate)).toBe(false);
  });
  it.each([NaN, Infinity, 0, -1])("does not guess unknown activity %s", lastActivityAt => {
    expect(inboxShouldSettle({ ...base, lastActivityAt }, 3, now)).toBe(false);
  });
  it("a picked-up thread waits for a fresh idle window", () => {
    expect(inboxShouldSettle({ ...base, lastActivityAt: now }, 3, now)).toBe(false);
  });
});
describe("thread state", () => {
  const idle: ThreadStateSignals = { waiting: false, running: false, queued: false, closed: false };
  it("is idle with no signal", () => expect(threadState(idle)).toBe("idle"));
  it("waiting-on-you beats running, running beats queued, queued beats closed", () => {
    expect(threadState({ waiting: true, running: true, queued: true, closed: true })).toBe("waiting-on-you");
    expect(threadState({ ...idle, running: true, queued: true, closed: true })).toBe("running");
    expect(threadState({ ...idle, queued: true, closed: true })).toBe("queued");
    expect(threadState({ ...idle, closed: true })).toBe("closed");
  });
});
