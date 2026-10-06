import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TrustedPeers } from "./peer-trust.ts";

describe("TrustedPeers", () => {
  it("persists trust and carries it to a rotated session", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trust-")), "trusted-peers.json");
    const peers = new TrustedPeers(file);
    peers.set("old-session", true);
    peers.carry("old-session", "new-session");
    peers.carry("untrusted", "other");
    const reloaded = new TrustedPeers(file);
    expect(reloaded.has("old-session")).toBe(true);
    expect(reloaded.has("new-session")).toBe(true);
    expect(reloaded.has("other")).toBe(false);
    reloaded.set("old-session", false);
    expect(new TrustedPeers(file).list()).toEqual(["new-session"]);
  });
  it("rejects malformed ids", () => {
    const peers = new TrustedPeers(join(mkdtempSync(join(tmpdir(), "trust-")), "t.json"));
    expect(() => peers.set("../x", true)).toThrow();
  });
});
