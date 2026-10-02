import { describe, expect, it } from "vitest";
import { channelControlPatch, roomCompletionNotifies } from "./channel-controls.ts";

describe("room control admission", () => {
  const image = "/api/attachments/abc-123.png";
  const exists = (url: string) => url === image;
  it("admits saved images, exact member policies and mute", () => {
    expect(channelControlPatch({ avatarUrl: image, memberReplyModes: { a: "always", b: "mentions" }, notifications: "muted" }, ["a", "b"], exists))
      .toEqual({ avatarUrl: image, memberReplyModes: { a: "always", b: "mentions" }, notifications: "muted" });
  });
  it("clears images and restores legacy routing through an empty map", () => {
    expect(channelControlPatch({ avatarUrl: null, memberReplyModes: {} }, ["a"], exists)).toEqual({ avatarUrl: null, memberReplyModes: {} });
  });
  it.each([
    { avatarUrl: "https://tracker.test/pixel.png" }, { avatarUrl: "/api/attachments/missing.png" },
    { avatarUrl: "/api/attachments/abc-123.svg" }, { memberReplyModes: { other: "always" } },
    { memberReplyModes: { a: "sometimes" } }, { memberReplyModes: [] }, { notifications: "quiet" },
  ])("rejects an invalid or unauthorized control %j", body => {
    expect(() => channelControlPatch(body, ["a"], exists)).toThrow();
  });
  it("honors mute and mentions for completion without changing ordinary defaults", () => {
    expect(roomCompletionNotifies("muted", "@firaz done", "firaz")).toBe(false);
    expect(roomCompletionNotifies("mentions", "@firaz done", "firaz")).toBe(true);
    expect(roomCompletionNotifies("mentions", "@firazx done", "firaz")).toBe(false);
    expect(roomCompletionNotifies("mentions", "done", "firaz")).toBe(false);
    expect(roomCompletionNotifies(undefined, "done", "firaz")).toBe(true);
  });
});
