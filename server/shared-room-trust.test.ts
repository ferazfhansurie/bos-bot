import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SharedRoomTrust, sharedRoomTargets, sharedRoomBotCandidates } from "./shared-room-trust.ts";

const bots = [{ name: "Ultron" }, { name: "Pixie" }, { name: "Jarvis" }];

describe("sharedRoomTargets", () => {
  it("keeps an ordinary human message between people", () => {
    expect(sharedRoomTargets(bots, "what's on today", false)).toEqual([]);
  });
  it("routes to every mentioned bot, case-insensitively", () => {
    expect(sharedRoomTargets(bots, "@pixie and @JARVIS, thoughts?", false)).toEqual([{ name: "Pixie" }, { name: "Jarvis" }]);
  });
  it("does not interpret human broadcast mentions as bot invocations", () => {
    expect(sharedRoomTargets(bots, "@everyone hi", false)).toEqual([]);
    expect(sharedRoomTargets(bots, "@everyone hi", true)).toEqual([]);
  });
  it("ignores code, quoted content, links, escaped mentions and partial names", () => {
    for (const text of ["`@Ultron`", "> @Ultron hello", "```text\n@Ultron\n```", "[@Ultron](https://example.com)", "mail@Ultron", "@UltronPlus", "@Ultron-test"]) {
      expect(sharedRoomTargets(bots, text, false), text).toEqual([]);
    }
  });
  it("requires an owner-qualified mention when bot names collide", () => {
    const twins = [{ name: "Koda", ownerName: "Firaz" }, { name: "Koda", ownerName: "Faeez" }];
    expect(sharedRoomTargets(twins, "@Koda help", false)).toEqual([]);
    expect(sharedRoomTargets(twins, "@Koda · Faeez help", false)).toEqual([twins[1]]);
  });
  it("ignores partial names and emails", () => {
    expect(sharedRoomTargets(bots, "mail pixie@example.com or @pixies", true)).toEqual([]);
  });
  it("never routes a bot reply into another bot", () => {
    expect(sharedRoomTargets(bots, "done, nothing else needed", true)).toEqual([]);
    expect(sharedRoomTargets(bots, "@ultron can you check firaz's calendar?", true)).toEqual([]);
  });
});

describe("SharedRoomTrust", () => {
  it("persists the owner's level per room", () => {
    const file = join(mkdtempSync(join(tmpdir(), "room-trust-")), "trust.json");
    const trust = new SharedRoomTrust(file);
    expect(trust.get("room-1")).toBeUndefined();
    trust.set("room-1", "trusted");
    expect(new SharedRoomTrust(file).get("room-1")).toBe("trusted");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "room-1": "trusted" });
  });
  it("ignores unknown levels on disk", () => {
    const file = join(mkdtempSync(join(tmpdir(), "room-trust-")), "trust.json");
    new SharedRoomTrust(file).set("a", "helper");
    expect(() => new SharedRoomTrust(join(file, "missing"))).not.toThrow();
  });
});

it("offers linked teammates' bots to the owner without granting strangers the owner's links", () => {
  const room = { id: "room", homeId: "firaz", name: "People", createdAt: 1, memberIds: ["firaz:person:owner", "putri:person:owner"], createdBy: "firaz:person:owner" };
  const local = ["firaz:bot:ultron"];
  const linked = ["putri:bot:pixie", "faeez:bot:koda"];
  expect(sharedRoomBotCandidates(room, "firaz:person:owner", "firaz", local, linked)).toEqual([...local, ...linked]);
  expect(sharedRoomBotCandidates(room, "putri:person:owner", "firaz", local, linked)).toEqual(["putri:bot:pixie"]);
  const forged = { ...room, createdBy: "stranger:person:owner", memberIds: ["stranger:person:owner", ...local] };
  expect(sharedRoomBotCandidates(forged, "stranger:person:owner", "firaz", local, linked)).toEqual([]);
});
