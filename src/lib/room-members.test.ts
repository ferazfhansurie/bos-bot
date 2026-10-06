import { describe, expect, it } from "vitest";

import { nextMemberIds } from "./room-members";

const pick = (...ids: string[]) => new Set(ids);

describe("nextMemberIds", () => {
  it("keeps the existing roster in place so the room's lead does not move", () => {
    expect(nextMemberIds(["lead", "second"], pick("lead", "second"), ["second", "lead"])).toEqual(["lead", "second"]);
  });

  it("appends newly ticked bots after the members already in the room", () => {
    expect(nextMemberIds(["lead"], pick("lead", "scout", "archivist"), ["archivist", "lead", "scout"])).toEqual([
      "lead",
      "archivist",
      "scout",
    ]);
  });

  it("drops members that were unticked", () => {
    expect(nextMemberIds(["lead", "second"], pick("second"), ["lead", "second"])).toEqual(["second"]);
  });

  it("ignores ticked ids that are not offered in the list", () => {
    expect(nextMemberIds(["lead"], pick("lead", "ghost"), ["lead"])).toEqual(["lead"]);
  });

  it("returns nothing when every member is unticked", () => {
    expect(nextMemberIds(["lead"], pick(), ["lead"])).toEqual([]);
  });
});

import { localRoomMembers, roomMemberBots, roomMentionPool, isRoomGuestBot } from "./room-members";
import { mentionChoicesForQuery } from "./mentions";
import type { Bot } from "@/state/store";

const localBot = (id: string, name: string) => ({
  id, name, threadId: `t-${id}`, title: "", description: "", notifications: true, color: "blue",
  unread: false, modelSelection: { instanceId: "claude", model: "opus" }, messages: [],
}) as Bot;

const partner = { id: "home-partner", name: "Partner" };
const remoteBots = [
  { id: "partner-codex", name: "Codex", color: "green", title: "Engineer", mascotBody: "robot" },
  { id: "partner-claude", name: "Claude", color: "orange", avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" },
];

describe("roomMemberBots", () => {
  it("resolves a local room against this home's bots, in roster order", () => {
    const bots = [localBot("a", "Alpha"), localBot("b", "Beta")];
    expect(roomMemberBots({ memberIds: ["b", "a", "gone"] }, bots).map((bot) => bot.id)).toEqual(["b", "a"]);
  });

  it("maps another home's room from remoteBots, ordered by memberIds", () => {
    const members = roomMemberBots({ memberIds: ["partner-claude", "partner-codex", "partner-hidden"], home: partner, remoteBots }, [localBot("a", "Alpha")]);
    expect(members.map((bot) => bot.name)).toEqual(["Claude", "Codex"]);
    expect(members[0]).toMatchObject({ id: "partner-claude", color: "orange", avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", roomHome: { id: "home-partner", name: "Partner" }, threadId: "" });
    expect(members[1]).toMatchObject({ title: "Engineer", mascotBody: "robot" });
    expect(members.every(isRoomGuestBot)).toBe(true);
  });

  it("never resolves a remote room's ids against a local bot that shares one", () => {
    const clash = localBot("partner-codex", "Local Codex");
    const members = roomMemberBots({ memberIds: ["partner-codex"], home: partner, remoteBots }, [clash]);
    expect(members[0]?.name).toBe("Codex");
    expect(members[0]).not.toBe(clash);
    expect(localRoomMembers(members)).toEqual([]);
  });

  it("lists every remote bot when the room's roster isn't known yet", () => {
    expect(roomMemberBots({ memberIds: [], home: partner, remoteBots }, []).map((bot) => bot.id)).toEqual(["partner-codex", "partner-claude"]);
  });

  it("sanitizes untrusted profile fields", () => {
    const [bot] = roomMemberBots({
      memberIds: ["x"], home: partner,
      remoteBots: [{ id: "x", name: "", color: "#ff0000", mascotBody: "dragon" }, null as never, { name: "no id" } as never],
    }, []);
    expect(bot).toMatchObject({ id: "x", name: "Bot", color: "gray", mascotBody: null });
    expect(bot).not.toHaveProperty("avatarUrl");
  });

  it("falls back to the local lookup when an older server sends no remoteBots", () => {
    expect(roomMemberBots({ memberIds: ["partner-codex"], home: partner }, [])).toEqual([]);
    const legacy = localBot("a", "Alpha");
    expect(roomMemberBots({ memberIds: ["a"], home: partner }, [legacy])).toEqual([legacy]);
  });
});

describe("roomMentionPool", () => {
  const members = roomMemberBots({ memberIds: ["partner-claude", "partner-codex"], home: partner, remoteBots }, []);

  it("offers @everyone then another home's bots in a remote room", () => {
    expect(roomMentionPool({ dm: false }, members).map((choice) => choice.name)).toEqual(["everyone", "Claude", "Codex"]);
    expect(mentionChoicesForQuery(roomMentionPool({}, members), "co").map((choice) => choice.id)).toEqual(["partner-codex"]);
  });

  it("drops @everyone in a bot-to-bot channel", () => {
    expect(roomMentionPool({ dm: true }, members).map((choice) => choice.id)).toEqual(["partner-claude", "partner-codex"]);
  });

  it("is only @everyone when an older server leaves the remote room unresolved", () => {
    const unresolved = roomMemberBots({ memberIds: ["partner-claude"], home: partner }, []);
    expect(roomMentionPool({}, unresolved).map((choice) => choice.id)).toEqual(["__everyone__"]);
  });
});
