import { describe, expect, it } from "vitest";
import { publicRoomMemberTurns } from "./room-member-turns.ts";

describe("authoritative public room member turns", () => {
  it("projects simultaneous owners in the same and separate public threads without private aliases", () => {
    const a = { botId: "a" }, b = { botId: "b" }, c = { botId: "a" };
    const owners: Array<[string, { botId: string }]> = [["private-a", a], ["private-b", b], ["private-c", c]];
    const facts = new WeakMap<object, { startedAt: number; turnId?: string }>([[a, { startedAt: 10, turnId: "turn-a" }], [b, { startedAt: 20, turnId: "turn-b" }]]);
    const canonical = (id: string) => id === "private-c" ? "public-two" : "public-one";
    const snapshot = () => publicRoomMemberTurns(owners, canonical, facts);
    expect(snapshot()).toEqual([
      { botId: "a", threadId: "public-one", startedAt: 10, turnId: "turn-a" },
      { botId: "b", threadId: "public-one", startedAt: 20, turnId: "turn-b" },
      { botId: "a", threadId: "public-two", startedAt: null },
    ]);
    expect(JSON.stringify(snapshot())).not.toContain("private-");
    owners.splice(0, 1); // targeted Stop of a in public-one
    expect(snapshot().map(t => [t.botId, t.threadId])).toEqual([["b", "public-one"], ["a", "public-two"]]);
    owners.splice(0, 1); // completion of b leaves the other thread intact
    expect(snapshot()).toEqual([{ botId: "a", threadId: "public-two", startedAt: null }]);
    owners.length = 0;
    expect(snapshot()).toEqual([]);
  });

  it("does not inherit retired turn facts when a lane is reused for a new speaker claim", () => {
    const old = { botId: "a" }, current = { botId: "a" };
    const facts = new WeakMap<object, { startedAt: number; turnId?: string }>([[old, { startedAt: 10, turnId: "old" }]]);
    const owners: Array<[string, { botId: string }]> = [["private-reused", current]];
    expect(publicRoomMemberTurns(owners, () => "public", facts)).toEqual([{ botId: "a", threadId: "public", startedAt: null }]);
    facts.set(current, { startedAt: 100, turnId: "new" });
    expect(publicRoomMemberTurns(owners, () => "public", facts)).toEqual([{ botId: "a", threadId: "public", startedAt: 100, turnId: "new" }]);
  });
});
