import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SharedRoomTrust, sharedRoomTargets } from "./shared-room-trust.ts";

const bots = [{ name: "Ultron" }, { name: "Pixie" }, { name: "Jarvis" }];

describe("sharedRoomTargets", () => {
  it("routes a person's message without a mention to the lead bot", () => {
    expect(sharedRoomTargets(bots, "what's on today", false)).toEqual([{ name: "Ultron" }]);
  });
  it("routes to every mentioned bot, case-insensitively", () => {
    expect(sharedRoomTargets(bots, "@pixie and @JARVIS, thoughts?", false)).toEqual([{ name: "Pixie" }, { name: "Jarvis" }]);
  });
  it("routes @everyone to all bots", () => {
    expect(sharedRoomTargets(bots, "@everyone hi", false)).toHaveLength(3);
  });
  it("ignores partial names and emails", () => {
    expect(sharedRoomTargets(bots, "mail pixie@example.com or @pixies", true)).toEqual([]);
  });
  it("a bot's reply only reaches bots it mentions", () => {
    expect(sharedRoomTargets(bots, "done, nothing else needed", true)).toEqual([]);
    expect(sharedRoomTargets(bots, "@ultron can you check firaz's calendar?", true)).toEqual([{ name: "Ultron" }]);
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
