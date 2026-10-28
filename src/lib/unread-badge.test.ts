import { describe, expect, it } from "vitest";
import { unreadBadgeCount } from "./unread-badge";

describe("unreadBadgeCount", () => {
  it("leaves muted bots and muted rooms off the badge", () => {
    const bots = [
      { unread: true, notifications: true },
      { unread: true, notifications: false },
      // older records predate the switch: not muted
      { unread: true } as { unread: boolean; notifications: boolean },
      { unread: false, notifications: true },
      { unread: true, notifications: true, hidden: true },
    ];
    const groups = [
      { unread: true, notifications: "all" as const },
      { unread: true, notifications: "muted" as const },
      { unread: true },
    ];
    expect(unreadBadgeCount(bots, groups)).toBe(4);
    expect(unreadBadgeCount([{ unread: true, notifications: false }], [])).toBe(0);
  });
});
