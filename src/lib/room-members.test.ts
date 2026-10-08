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

import { localRoomMembers, roomCandidateBots, roomMemberBots, roomMentionPool, isRoomGuestBot, roomBotSupportsImages } from "./room-members";
import { mentionableBots } from "./remote-bot";
import { mentionChoicesForQuery } from "./mentions";
import type { Bot } from "@/state/store";

const localBot = (id: string, name: string) => ({
  id, name, threadId: `t-${id}`, title: "", description: "", notifications: true, color: "blue",
  unread: false, modelSelection: { instanceId: "claude", model: "opus" }, messages: [],
}) as Bot;

const partner = { id: "home-partner", name: "Partner" };
const memberBots = [
  { id: "partner-codex", name: "Codex", color: "green", title: "Engineer", mascotBody: "robot" },
  { id: "partner-claude", name: "Claude", color: "orange", avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" },
];

describe("roomMemberBots", () => {
  it("admits a canonical-home member's image without a matching local provider", () => {
    const [guest] = roomMemberBots({ memberIds: ["partner-codex"], home: partner, memberBots }, []);
    expect(roomBotSupportsImages(guest, [])).toBe(true);
    expect(roomBotSupportsImages(localBot("a", "Alpha"), [])).toBe(false);
    expect(roomBotSupportsImages(localBot("a", "Alpha"), [{ instanceId: "claude", capabilities: { images: true } }])).toBe(true);
  });
  it("resolves a local room against this home's bots, in roster order", () => {
    const bots = [localBot("a", "Alpha"), localBot("b", "Beta")];
    expect(roomMemberBots({ memberIds: ["b", "a", "gone"] }, bots).map((bot) => bot.id)).toEqual(["b", "a"]);
  });

  it("maps another home's room from memberBots, ordered by memberIds", () => {
    const members = roomMemberBots({ memberIds: ["partner-claude", "partner-codex", "partner-hidden"], home: partner, memberBots }, [localBot("a", "Alpha")]);
    expect(members.map((bot) => bot.name)).toEqual(["Claude", "Codex"]);
    expect(members[0]).toMatchObject({ id: "partner-claude", color: "orange", avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", roomHome: { id: "home-partner", name: "Partner" }, threadId: "" });
    expect(members[1]).toMatchObject({ title: "Engineer", mascotBody: "robot" });
    expect(members.every(isRoomGuestBot)).toBe(true);
  });

  it("never resolves a remote room's ids against a local bot that shares one", () => {
    const clash = localBot("partner-codex", "Local Codex");
    const members = roomMemberBots({ memberIds: ["partner-codex"], home: partner, memberBots }, [clash]);
    expect(members[0]?.name).toBe("Codex");
    expect(members[0]).not.toBe(clash);
    expect(localRoomMembers(members)).toEqual([]);
  });

  it("lists every remote bot when the room's roster isn't known yet", () => {
    expect(roomMemberBots({ memberIds: [], home: partner, memberBots }, []).map((bot) => bot.id)).toEqual(["partner-codex", "partner-claude"]);
  });

  it("sanitizes untrusted profile fields", () => {
    const [bot] = roomMemberBots({
      memberIds: ["x"], home: partner,
      memberBots: [{ id: "x", name: "", color: "#ff0000", mascotBody: "dragon" }, null as never, { name: "no id" } as never],
    }, []);
    expect(bot).toMatchObject({ id: "x", name: "Bot", color: "gray", mascotBody: null });
    expect(bot).not.toHaveProperty("avatarUrl");
  });

  it("falls back to the local lookup when an older server sends no memberBots", () => {
    expect(roomMemberBots({ memberIds: ["partner-codex"], home: partner }, [])).toEqual([]);
    const legacy = localBot("a", "Alpha");
    expect(roomMemberBots({ memberIds: ["a"], home: partner }, [legacy])).toEqual([legacy]);
  });
});

describe("roomMentionPool", () => {
  const members = roomMemberBots({ memberIds: ["partner-claude", "partner-codex"], home: partner, memberBots }, []);

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

describe("relayed (rb-) members of a room on this home", () => {
  const origin = { homeId: "home-putri", homeName: "Studio", ownerName: "Putri", online: true, availability: "ready" as const };
  const relayed = { ...localBot("rb-0123456789ab-scout", "Scout"), remote: origin } as Bot;
  const archived = { ...localBot("old", "Old"), hidden: true } as Bot;

  it("offers visible local and relayed bots in the room picker, never hidden ones", () => {
    const bots = [localBot("a", "Alpha"), relayed, archived];
    expect(roomCandidateBots(bots).map((bot) => bot.id)).toEqual(["a", relayed.id]);
  });

  it("keeps a hidden bot that is already a member so it can be removed", () => {
    expect(roomCandidateBots([archived, relayed], ["old"]).map((bot) => bot.id)).toEqual(["old", relayed.id]);
  });

  it("resolves an rb- member from the store's bots like any member", () => {
    const members = roomMemberBots({ memberIds: [relayed.id, "a"] }, [localBot("a", "Alpha"), relayed]);
    expect(members.map((bot) => bot.id)).toEqual([relayed.id, "a"]);
    expect(members[0]).toBe(relayed);
    expect(isRoomGuestBot(members[0])).toBe(false);
  });

  it("draws an rb- member from memberBots while the bridge has no bot record for it", () => {
    const members = roomMemberBots({
      memberIds: ["a", relayed.id],
      memberBots: [{ id: relayed.id, name: "Scout", color: "green", remote: { ...origin, online: false } } as never],
    }, [localBot("a", "Alpha")]);
    expect(members.map((bot) => bot.id)).toEqual(["a", relayed.id]);
    expect(members[1]).toMatchObject({ name: "Scout", color: "green", threadId: "", remote: { homeId: "home-putri", ownerName: "Putri", online: false } });
    expect(members[1]).not.toHaveProperty("roomHome");
    // display-only: never driven through this home's bot routes (calls)
    expect(localRoomMembers(members).map((bot) => bot.id)).toEqual(["a"]);
  });

  it("ignores memberBots fallbacks that are not relayed or carry no valid origin", () => {
    expect(roomMemberBots({ memberIds: ["gone"], memberBots: [{ id: "gone", name: "Gone", color: "blue", remote: origin } as never] }, [])).toEqual([]);
    expect(roomMemberBots({ memberIds: ["rb-x-y"], memberBots: [{ id: "rb-x-y", name: "Y", color: "blue" }] }, [])).toEqual([]);
    expect(roomMemberBots({ memberIds: ["rb-x-y"], memberBots: [{ id: "rb-x-y", name: "Y", color: "blue", remote: { homeId: 1 } } as never] }, [])).toEqual([]);
  });

  it("makes a relayed member @mentionable in the room, while the 1:1 picker still leaves it out", () => {
    const alpha = localBot("a", "Alpha");
    const members = roomMemberBots({ memberIds: ["a", relayed.id] }, [alpha, relayed]);
    expect(roomMentionPool({ dm: false }, members).map((choice) => choice.id)).toEqual(["__everyone__", "a", relayed.id]);
    expect(mentionChoicesForQuery(roomMentionPool({}, members), "sc").map((choice) => choice.id)).toEqual([relayed.id]);
    expect(mentionableBots([alpha, relayed], "z").map((bot) => bot.id)).toEqual(["a"]);
  });
});
