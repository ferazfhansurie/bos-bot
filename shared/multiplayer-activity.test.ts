import { describe, expect, it } from "vitest";
import { SharedRoomLog, contactId } from "./multiplayer";

const owner = { homeId: "home_a", kind: "person" as const, localId: "owner" };
const bot = { homeId: "home_b", kind: "bot" as const, localId: "pixie" };
const room = { id: "room_1", homeId: "home_a", name: "Pixie", memberIds: [contactId(owner), contactId(bot)], createdAt: 1 };

describe("shared bot activity", () => {
  it("keeps ordered bot progress with idempotent retries and rejects forged person activity", () => {
    const log = new SharedRoomLog(room);
    const progress = { actor: bot, text: "", kind: "activity", tool: { name: "search", ok: true }, sendId: "activity_1" };
    expect(log.append(progress, "event_1", 2).created).toBe(true);
    expect(log.append(progress, "ignored", 3).created).toBe(false);
    expect(log.after(0)[0]).toMatchObject({ sequence: 1, kind: "activity", tool: { name: "search", ok: true } });
    expect(() => log.append({ ...progress, actor: owner, sendId: "forged" }, "event_2", 4)).toThrow(/only bots/);
    expect(() => log.append({ ...progress, tool: { name: "different" } }, "event_3", 5)).toThrow(/send id conflict/);
  });
});
