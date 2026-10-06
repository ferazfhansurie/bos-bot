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

import { remoteRoomListPatches, remoteRoomNeedsListing } from "./remote-room-frames";

describe("remoteRoomNeedsListing", () => {
  const listed = [
    { id: "room-local", threadId: "thread-local" },
    { id: "room-partner", threadId: "thread-partner", home: partner, remoteBots: [{ id: "claude" }] },
    { id: "room-old", threadId: "thread-old", home: partner },
  ];

  it("asks for a listing when a room it was just added to shows up", () => {
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "group", group: { id: "room-new", memberIds: [] } }))).toBe(true);
  });

  it("asks when a known room gains a bot it has no profile for", () => {
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "group", group: { id: "room-partner", memberIds: ["claude", "codex"] } }))).toBe(true);
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "group", group: { id: "room-partner", memberIds: ["claude"] } }))).toBe(false);
  });

  it("stays quiet for other frames, older servers and partial patches", () => {
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "message", threadId: "thread-new", message: {} }))).toBe(false);
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "group", group: { id: "room-old", memberIds: ["x"] } }))).toBe(false);
    expect(remoteRoomNeedsListing(listed, "partner", frame({ kind: "group", group: { id: "room-partner", busyBotId: null } }))).toBe(false);
  });
});

describe("remoteRoomListPatches", () => {
  const known = [
    { id: "room-local", threadId: "thread-local", name: "Local" },
    { id: "room-partner", threadId: "thread-partner", name: "Team Inbox", home: partner, remoteBots: [{ id: "claude" }], messages: [{ id: "m1" }] },
  ];

  it("adds a newly listed remote room whole and skips local rooms", () => {
    const fresh = { id: "room-new", threadId: "thread-new", name: "New", home: partner, messages: [] };
    expect(remoteRoomListPatches(known, [{ id: "room-local", threadId: "thread-local", name: "Renamed" }, fresh])).toEqual([fresh]);
  });

  it("patches only listing fields that changed, never the transcript", () => {
    const listed = [{ id: "room-partner", threadId: "thread-partner", name: "Team Inbox", home: partner, remoteBots: [{ id: "claude" }, { id: "codex" }], messages: [], hasMore: true }];
    expect(remoteRoomListPatches(known, listed)).toEqual([{ id: "room-partner", remoteBots: [{ id: "claude" }, { id: "codex" }] }]);
    expect(remoteRoomListPatches(known, [{ ...known[1]!, messages: [] }])).toEqual([]);
  });

  it("fills in a roster first listed empty while the home was cold", () => {
    const cold = [{ ...known[1]!, memberIds: [] as string[] }];
    expect(remoteRoomListPatches(cold, [{ ...known[1]!, memberIds: ["claude", "codex"] }])).toEqual([{ id: "room-partner", memberIds: ["claude", "codex"] }]);
  });
});
