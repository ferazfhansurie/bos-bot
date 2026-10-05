import { describe, expect, it } from "vitest";
import { roomSender, roomSenderName } from "./room-sender";
import { sameBubbleRun } from "./room-view";

const people = [
  { id: "firaz:person:owner", name: "Firaz", homeId: "firaz" },
  { id: "partner:person:owner", name: "Partner", homeId: "partner", homeName: "Partner's home" },
];
const line = (sender?: { id?: string; name: string }) => ({ role: "user" as const, text: "hi", sender });

describe("roomSender", () => {
  it("keeps the owner's own lines, stamped or not, as yours on a room you host", () => {
    const room = { people };
    expect(roomSender(line(), room, "firaz:person:owner")?.mine).toBe(true);
    expect(roomSender(line({ id: "firaz:person:owner", name: "Firaz" }), room, "firaz:person:owner")?.mine).toBe(true);
    expect(roomSenderName(line(), room, "firaz:person:owner")).toBeNull();
  });

  it("names another person instead of calling them you", () => {
    const sender = roomSender(line({ id: "partner:person:owner", name: "partner@example.com" }), { people }, "firaz:person:owner");
    expect(sender).toMatchObject({ mine: false, name: "Partner", id: "partner:person:owner" });
  });

  it("reads an unstamped line in another home's room as that home's owner", () => {
    const room = { people, home: { id: "partner", name: "Partner's home" } };
    expect(roomSenderName(line(), room, "firaz:person:owner")).toBe("Partner");
    expect(roomSender(line({ id: "firaz:person:owner", name: "Firaz" }), room, "firaz:person:owner")?.mine).toBe(true);
  });

  it("falls back to the stamped name for someone not in the roster", () => {
    expect(roomSenderName(line({ id: "x:person:guest", name: "Guest" }), { people }, "firaz:person:owner")).toBe("Guest");
  });

  it("leaves bot lines and bot deliveries alone", () => {
    expect(roomSender({ role: "bot", text: "hi" }, { people }, "firaz:person:owner")).toBeNull();
    expect(roomSender({ role: "user", text: "hi", peerAsk: { botId: "b", name: "Scout" } }, { people }, "firaz:person:owner")).toBeNull();
  });

  it("does not merge two people's lines into one bubble run", () => {
    const at = Date.now();
    const a = { role: "user", kind: "text", at, sender: { id: "firaz:person:owner" } };
    const b = { role: "user", kind: "text", at, sender: { id: "partner:person:owner" } };
    expect(sameBubbleRun(a, b)).toBe(false);
    expect(sameBubbleRun(a, { ...a })).toBe(true);
  });
});
