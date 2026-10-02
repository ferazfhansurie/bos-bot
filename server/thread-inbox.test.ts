import { describe, expect, it } from "vitest";
import { inboxCanClose, inboxShouldSettle, type InboxCandidate } from "./thread-inbox.ts";
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
