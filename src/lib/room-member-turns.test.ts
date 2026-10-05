import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { applyRoomTurnEvent, pruneRoomTurns, roomPresenceMembers, type RoomMemberTurns } from "./room-member-turns";

const at = Date.UTC(2026, 9, 5, 12);
const iso = (seconds: number) => new Date(at + seconds * 1000).toISOString();
const start = (turns: RoomMemberTurns, threadId: string, botId: string, seconds = 0) =>
  applyRoomTurnEvent(turns, { type: "turn.started", threadId, roomBotId: botId, turnId: `${botId}-${seconds}`, createdAt: iso(seconds) });
const base = { threadId: "room-a", otherThreadRunning: false, messages: [] as Message[] };

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
    expect(after.size).toBe(1);
    expect(applyRoomTurnEvent(after, { type: "turn.completed", threadId: "room-a", roomBotId: "atlas", turnId: "atlas-9" }).size).toBe(0);
  });

  it("prunes members the room frame no longer counts, only in that room", () => {
    const turns = start(start(new Map(), "room-a", "atlas"), "other-room", "juniper");
    const pruned = pruneRoomTurns(turns, ["room-a"], []);
    expect([...pruned.values()].map((turn) => turn.botId)).toEqual(["juniper"]);
    expect(pruneRoomTurns(turns, ["room-a"], undefined)).toBe(turns);
  });

  it("shows an untracked member opened mid-turn only when no other thread could own it", () => {
    const input = { ...base, activeBotIds: ["atlas"], busyBotId: "atlas", turnStartedAt: at, turns: new Map() };
    expect(roomPresenceMembers(input)).toEqual([{ botId: "atlas", since: at, tool: null }]);
    expect(roomPresenceMembers({ ...input, otherThreadRunning: true })).toEqual([]);
    expect(roomPresenceMembers({ ...input, turns: start(new Map(), "room-b", "atlas") })).toEqual([]);
    // a second untracked member has no reliable start time
    expect(roomPresenceMembers({ ...input, activeBotIds: ["atlas", "kai"] })[1]).toEqual({ botId: "kai", since: null, tool: null });
  });

  it("falls back to the single busy speaker on servers without activeBotIds", () => {
    expect(roomPresenceMembers({ ...base, busyBotId: "atlas", turnStartedAt: at, turns: new Map() }).map((member) => member.botId)).toEqual(["atlas"]);
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
