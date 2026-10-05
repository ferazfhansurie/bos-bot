import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { applyRoomTurnEvent, pruneRoomTurns, roomPresenceMembers, type RoomMemberTurns } from "./room-member-turns";

const at = Date.UTC(2026, 9, 5, 12);
const iso = (seconds: number) => new Date(at + seconds * 1000).toISOString();
const start = (turns: RoomMemberTurns, threadId: string, botId: string, seconds = 0) =>
  applyRoomTurnEvent(turns, { type: "turn.started", threadId, roomBotId: botId, turnId: `${botId}-${seconds}`, createdAt: iso(seconds) });
const base = { threadId: "room-a", messages: [] as Message[] };

describe("room member turns", () => {
  it("keeps each member's own start time", () => {
    const turns = start(start(new Map(), "room-a", "atlas", 0), "room-a", "juniper", 7);
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas", "juniper"], turns }))
      .toEqual([{ botId: "atlas", since: at, tool: null }, { botId: "juniper", since: at + 7000, tool: null }]);
  });

  it("ignores a stale completion from an earlier turn", () => {
    const first = start(new Map(), "room-a", "atlas", 0);
    const second = start(first, "room-a", "atlas", 9);
    const after = applyRoomTurnEvent(second, { type: "turn.completed", threadId: "room-a", roomBotId: "atlas", turnId: "atlas-0" });
    expect(after.get("room-a:room:atlas")?.completed).toBeUndefined();
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns: after })).toHaveLength(1);
    const done = applyRoomTurnEvent(after, { type: "turn.completed", threadId: "room-a", roomBotId: "atlas", turnId: "atlas-9" });
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns: done })).toEqual([]);
  });

  it("prunes members the room frame no longer counts, only in that room", () => {
    const turns = start(start(new Map(), "room-a", "atlas"), "other-room", "juniper");
    const pruned = pruneRoomTurns(turns, ["room-a"], []);
    expect([...pruned.values()].map((turn) => turn.botId)).toEqual(["juniper"]);
    expect(pruneRoomTurns(turns, ["room-a"], undefined)).toBe(turns);
  });

  it("places an untracked member only where the server snapshot says it works", () => {
    const input = { ...base, activeBotIds: ["atlas", "kai"], turns: new Map(), activeMemberTurns: [
      { botId: "atlas", threadId: "room-a", startedAt: at, turnId: "t1" },
      { botId: "kai", threadId: "room-b", startedAt: at, turnId: "t2" },
    ] };
    expect(roomPresenceMembers(input)).toEqual([{ botId: "atlas", since: at, tool: null }]);
    expect(roomPresenceMembers({ ...input, threadId: "room-b" }).map((member) => member.botId)).toEqual(["kai"]);
    // no snapshot: room-wide activeBotIds alone never proves which thread
    expect(roomPresenceMembers({ ...input, activeMemberTurns: undefined })).toEqual([]);
    // a snapshot without a start time shows the member with no timer
    expect(roomPresenceMembers({ ...input, activeMemberTurns: [{ botId: "atlas", threadId: "room-a", startedAt: null }] }))
      .toEqual([{ botId: "atlas", since: null, tool: null }]);
  });

  it("keeps a completed turn settled against snapshots that predate it, but shows a newer one", () => {
    const done = applyRoomTurnEvent(start(new Map(), "room-a", "atlas", 0), { type: "turn.completed", threadId: "room-a", roomBotId: "atlas", turnId: "atlas-0" });
    const frame = (entry: { startedAt: number | null; turnId?: string }) =>
      roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns: done, activeMemberTurns: [{ botId: "atlas", threadId: "room-a", ...entry }] });
    expect(frame({ startedAt: at, turnId: "atlas-0" })).toEqual([]);
    expect(frame({ startedAt: at })).toEqual([]);
    expect(frame({ startedAt: null })).toEqual([]);
    expect(frame({ startedAt: at + 30000, turnId: "atlas-30" })).toEqual([{ botId: "atlas", since: at + 30000, tool: null }]);
    // a fresh start frame replaces the completed record
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns: start(done, "room-a", "atlas", 40) }))
      .toEqual([{ botId: "atlas", since: at + 40000, tool: null }]);
  });

  it("takes only the member's own running step from this turn", () => {
    const turns = start(new Map(), "room-a", "atlas", 10);
    const old: Message = { id: "old", role: "bot", kind: "activity", at: at, from: { botId: "atlas", name: "Atlas", color: "green" }, tool: { name: "Bash" } };
    const other: Message = { id: "other", role: "bot", kind: "activity", at: at + 12000, from: { botId: "kai", name: "Kai", color: "blue" }, tool: { name: "Bash" } };
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns, messages: [old, other] })[0]!.tool).toBeNull();
    const own: Message = { ...old, id: "own", at: at + 11000 };
    expect(roomPresenceMembers({ ...base, activeBotIds: ["atlas"], turns, messages: [old, own, other] })[0]!.tool?.id).toBe("own");
  });
});
