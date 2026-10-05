import { describe, expect, it } from "vitest";
import { applyRoomTurnEvent, roomPresenceMembers } from "./room-member-turns";

describe("lead review: uncertain and completed room turns", () => {
  it("does not show a completed member while the preceding active frame is still present", () => {
    const started = applyRoomTurnEvent(new Map(), { type: "turn.started", threadId: "room-a", roomBotId: "a", turnId: "t", createdAt: "2026-10-05T12:00:00Z" });
    const completed = applyRoomTurnEvent(started, { type: "turn.completed", threadId: "room-a", roomBotId: "a", turnId: "t" });
    expect(roomPresenceMembers({ threadId: "room-a", activeBotIds: ["a"], turns: completed, messages: [] })).toEqual([]);
  });
  it("does not attribute an untracked room-wide member to a thread without a snapshot proving ownership", () => {
    expect(roomPresenceMembers({ threadId: "room-a", activeBotIds: ["a", "b"], turns: new Map(), messages: [] })).toEqual([]);
  });
});
