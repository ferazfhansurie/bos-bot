import { describe, expect, it } from "vitest";
import { roomMemberReplyMode, roomMemberStatus, shouldCollapseRoomReply } from "./room-view";

describe("room view compatibility", () => {
  it("keeps legacy lead routing until a member gets an explicit override", () => {
    const room = { defaultResponder: { kind: "member" as const, botId: "lead" } };
    expect(roomMemberReplyMode(room, "lead")).toBe("always");
    expect(roomMemberReplyMode(room, "other")).toBe("mentions");
    expect(roomMemberReplyMode({ ...room, memberReplyModes: { other: "always" } }, "other")).toBe("always");
    expect(roomMemberReplyMode({ defaultResponder: { kind: "everyone" } }, "other")).toBe("always");
  });
  it("shows every active room speaker and never mistakes another thread for room work", () => {
    const room = { activeBotIds: ["a", "b"], busyBotId: "a" };
    expect(roomMemberStatus(room, { id: "a" })).toBe("working");
    expect(roomMemberStatus(room, { id: "b" })).toBe("working");
    expect(roomMemberStatus(room, { id: "c" })).toBe("idle");
    expect(roomMemberStatus({}, { id: "a", remote: { online: false } })).toBe("offline");
    expect(roomMemberStatus({}, { id: "a", remote: { availability: "reconnect-required" } })).toBe("offline");
  });
  it("only offers previews for long text replies", () => {
    expect(shouldCollapseRoomReply({ role: "bot", kind: "text", text: "line\n".repeat(8) })).toBe(true);
    expect(shouldCollapseRoomReply({ role: "bot", kind: "text", text: "x".repeat(700) })).toBe(true);
    expect(shouldCollapseRoomReply({ role: "bot", kind: "options", text: "x".repeat(700) })).toBe(false);
    expect(shouldCollapseRoomReply({ role: "user", kind: "text", text: "x".repeat(700) })).toBe(false);
    expect(shouldCollapseRoomReply({ role: "bot", kind: "text", text: "done" })).toBe(false);
  });
});
