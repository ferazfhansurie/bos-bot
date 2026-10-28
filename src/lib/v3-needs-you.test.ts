import { describe, expect, it } from "vitest";
import type { InboxItem } from "./inbox";
import type { JobInboxItem } from "./job-inbox";
import { needsYouOwners, withLinkedWaiting } from "./v3-needs-you";

const ask = (over: Partial<InboxItem>): InboxItem => ({ id: "x", kind: "question", botId: "b1", threadId: "t1", title: "", preview: "", at: 1, ...over });
const job = (over: Partial<JobInboxItem>): JobInboxItem => ({ botId: "b1", threadId: "j1", revision: 1, outcome: "", state: "moving", steps: [], results: [], ...over });

describe("needsYouOwners", () => {
  it("counts approvals, questions, connect cards and stuck jobs, never plain work", () => {
    const result = needsYouOwners([
      ask({ id: "a", kind: "waiting-on-you", botId: "b1" }),
      ask({ id: "c", kind: "question", botId: "b2", connect: { slug: "gmail", label: "Gmail" } }),
      ask({ id: "f", kind: "failed", botId: "b3" }),
      ask({ id: "u", kind: "unread", botId: "b4" }),
      ask({ id: "l", kind: "waiting-on-you", botId: "b5", leadAction: { id: "l", leadBotId: "b5", kind: "blocker", status: "pending", requiredAction: "", updatedAt: 1 } }),
    ], [job({ state: "moving", botId: "b6" }), job({ state: "blocked", botId: "b7" }), job({ state: "needs-you", botId: "b8" })]);
    expect(result.count).toBe(4);
    expect([...result.botIds].sort()).toEqual(["b1", "b2", "b7", "b8"]);
    expect(result.loaded).toBe(true);
  });

  it("room rows and jobs in a room's thread light the room, not the bot", () => {
    const result = needsYouOwners([ask({ groupId: "g1", botId: "b1" })], [job({ state: "needs-you", threadId: "room-thread", botId: "b2" })],
      (threadId) => threadId === "room-thread" ? "g2" : undefined);
    expect([...result.groupIds].sort()).toEqual(["g1", "g2"]);
    expect(result.botIds.size).toBe(0);
  });

  it("nothing on the person is a zero, not a working bot", () => {
    expect(needsYouOwners([], [job({ state: "moving" })]).count).toBe(0);
  });

  it("a linked-server bot waiting on the person counts once; local and working ones do not", () => {
    const local = needsYouOwners([ask({ botId: "b1" })], []);
    const link = { id: "s1", name: "VPS", online: true };
    const result = withLinkedWaiting(local, [
      { id: "b1", activity: "waiting-on-you", homeLink: link },
      { id: "far", activity: "waiting-on-you", homeLink: link },
      { id: "busy", activity: "working", homeLink: link },
      { id: "here", activity: "waiting-on-you" },
    ]);
    expect(result.count).toBe(2);
    expect([...result.botIds].sort()).toEqual(["b1", "far"]);
    expect(withLinkedWaiting(local, [])).toBe(local);
  });
});
