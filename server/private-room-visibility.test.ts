import { expect, it } from "vitest";
import { privateRoomForViewer } from "./private-room-visibility.ts";

it("suppresses notification recipients after a private bot is mentioned in a shared room", () => {
  const base = { viewerId: "other-home:person:owner", ownerId: "this-home:person:owner", peerSession: false,
    memberIds: ["this-home:person:owner", "other-home:person:owner"],
    messages: [{ actorId: "this-home:person:owner", botTargets: ["this-home:bot:private"] }] };
  expect(privateRoomForViewer({ ...base, privateBotIds: new Set() })).toBe(false);
  expect(privateRoomForViewer({ ...base, privateBotIds: new Set(["this-home:bot:private"]) })).toBe(true);
  expect(privateRoomForViewer({ ...base, viewerId: base.ownerId, privateBotIds: new Set(["this-home:bot:private"]) })).toBe(false);
  expect(privateRoomForViewer({ ...base, viewerId: base.ownerId, peerSession: true, privateBotIds: new Set(["this-home:bot:private"]) })).toBe(true);
});
