import { describe, expect, it } from "vitest";

import { composerPriorityVisible, effectiveSendPriority, withSendPriority } from "./composer-priority";

const live = { busy: true, locked: false, shared: false, approvalPending: false };

describe("composerPriorityVisible", () => {
  it("shows the toggle only while an own, unlocked conversation is busy", () => {
    expect(composerPriorityVisible(live)).toBe(true);
    expect(composerPriorityVisible({ ...live, busy: false })).toBe(false);
    expect(composerPriorityVisible({ ...live, locked: true })).toBe(false);
    expect(composerPriorityVisible({ ...live, shared: true })).toBe(false);
    expect(composerPriorityVisible({ ...live, approvalPending: true })).toBe(false);
  });
});

describe("effectiveSendPriority", () => {
  it("keeps block only while the toggle is on screen", () => {
    expect(effectiveSendPriority("block", true)).toBe("block");
    expect(effectiveSendPriority("block", false)).toBe("queue");
    expect(effectiveSendPriority("queue", true)).toBe("queue");
    expect(effectiveSendPriority("queue", false)).toBe("queue");
  });
});

describe("withSendPriority", () => {
  const base = { text: "hi", threadId: "t1", sendId: "s1" };

  it("adds priority only for block", () => {
    expect(withSendPriority(base, "block")).toEqual({ ...base, priority: "block" });
  });

  it("omits priority for queue and undefined so older servers see the same body", () => {
    expect(withSendPriority(base, "queue")).toEqual(base);
    expect("priority" in withSendPriority(base, "queue")).toBe(false);
    expect(withSendPriority(base, undefined)).toEqual(base);
    expect(JSON.stringify(withSendPriority(base, undefined))).toBe(JSON.stringify(base));
  });
});
