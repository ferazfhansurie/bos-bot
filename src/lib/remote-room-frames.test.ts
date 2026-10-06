import { describe, expect, it } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import { remoteRoomFrame } from "./remote-room-frames";

const partner = { id: "partner", name: "Partner" };
const groups = [
  { id: "room-local", threadId: "thread-local" },
  { id: "room-partner", threadId: "thread-partner", tasks: [{ threadId: "thread-partner-2" }], home: partner },
  { id: "room-other", threadId: "thread-other", home: { id: "other", name: "Other" } },
];
const frame = (value: unknown) => value as ServerFrame;

describe("remoteRoomFrame", () => {
  it("passes messages for that home's rooms and their tasks", () => {
    for (const threadId of ["thread-partner", "thread-partner-2"]) {
      const message = frame({ kind: "message", threadId, message: { id: "m1", role: "user", text: "hi" } });
      expect(remoteRoomFrame(groups, "partner", message)).toBe(message);
    }
    const delta = frame({ kind: "runtime", event: { type: "content.delta", threadId: "thread-partner", delta: "x" } });
    expect(remoteRoomFrame(groups, "partner", delta)).toBe(delta);
  });

  it("drops frames for local rooms or another home's rooms", () => {
    expect(remoteRoomFrame(groups, "partner", frame({ kind: "message", threadId: "thread-local", message: {} }))).toBeNull();
    expect(remoteRoomFrame(groups, "partner", frame({ kind: "message", threadId: "thread-other", message: {} }))).toBeNull();
    expect(remoteRoomFrame(groups, "partner", frame({ kind: "group.deleted", groupId: "room-local" }))).toBeNull();
  });

  it("drops that home's own bot, inbox, config and notification frames", () => {
    for (const kind of ["bot", "bot.deleted", "inbox", "config", "notify", "sections", "update.state"]) {
      expect(remoteRoomFrame(groups, "partner", frame({ kind, botId: "claude", count: 3 }))).toBeNull();
    }
  });

  it("keeps the home stamp on a room update", () => {
    const update = remoteRoomFrame(groups, "partner", frame({ kind: "group", group: { id: "room-partner", name: "Launch" } }));
    expect(update).toMatchObject({ group: { id: "room-partner", name: "Launch", home: partner } });
    expect(remoteRoomFrame(groups, "partner", frame({ kind: "group", group: { id: "room-local", name: "x" } }))).toBeNull();
  });
});
