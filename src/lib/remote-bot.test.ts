import { describe, expect, it } from "vitest";

import { botControlAvailable, mentionableBots, remoteBotHint, remoteBotNotice, type BotControl } from "./remote-bot";

const remote = { homeId: "home-1", homeName: "Studio", ownerName: "Putri" };

describe("remote bot controls", () => {
  it("explains update and reconnect failures without calling a reachable Mac offline", () => {
    const outdated = { remote: { ...remote, online: false, availability: "update-required" as const } };
    expect(remoteBotHint(outdated)).toBe("update required · on Putri's Mac");
    expect(remoteBotNotice(outdated)).toContain("Update BOS on Putri's Mac");
    expect(remoteBotNotice({ remote: { ...remote, availability: "reconnect-required" } })).toContain("Reconnect");
    expect(remoteBotNotice({ remote: { ...remote, online: false } })).toContain("Keep BOS open");
    expect(remoteBotNotice({ remote: { ...remote, online: true, availability: "ready" } })).toBeNull();
    expect(remoteBotNotice({})).toBeNull();
  });
  it("hides this-Mac-only controls for a relayed bot", () => {
    const bot = { remote };
    const hidden: BotControl[] = ["settings", "computer", "inspector", "folders", "steer", "alwaysAllow", "voiceSetup", "mention"];
    for (const control of hidden) expect(botControlAvailable(bot, control), control).toBe(false);
  });

  it("keeps proxied edit and version switching for a relayed bot", () => {
    expect(botControlAvailable({ remote }, "edit")).toBe(true);
    expect(botControlAvailable({ remote }, "versions")).toBe(true);
  });

  it("offers every control for a local or absent bot", () => {
    const all: BotControl[] = ["settings", "computer", "inspector", "folders", "steer", "alwaysAllow", "voiceSetup", "mention", "edit", "versions"];
    for (const control of all) {
      expect(botControlAvailable({}, control)).toBe(true);
      expect(botControlAvailable(undefined, control)).toBe(true);
      expect(botControlAvailable(null, control)).toBe(true);
    }
  });

  it("drops relayed, hidden and current bots from the @mention list", () => {
    const bots = [
      { id: "self", name: "Pepper" },
      { id: "local", name: "Mochi" },
      { id: "hidden", name: "Ghost", hidden: true },
      { id: "rb-abc123-bot", name: "Putri's bot", remote },
    ];
    expect(mentionableBots(bots, "self").map((bot) => bot.id)).toEqual(["local"]);
    expect(mentionableBots(bots).map((bot) => bot.id)).toEqual(["self", "local"]);
  });

  it("names the Mac a relayed bot runs on", () => {
    expect(remoteBotHint({ remote })).toBe("on Putri's Mac");
    expect(remoteBotHint({ remote: { ...remote, ownerName: null } })).toBe("on Studio's Mac");
    expect(remoteBotHint({ remote: { ...remote, online: false } })).toBe("offline · on Putri's Mac");
    expect(remoteBotHint({})).toBeNull();
  });
});
