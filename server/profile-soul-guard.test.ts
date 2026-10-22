import { describe, expect, it } from "vitest";
import { profileSoulEnvelope, profileSoulConflict } from "./profile-soul-guard.ts";

describe("mobile standing instructions compare-and-set", () => {
  it("keeps old clients compatible and removes only the revision envelope", () => {
    expect(profileSoulEnvelope({ name: "bos" })).toEqual({ patch: { name: "bos" } });
    expect(profileSoulEnvelope({ soul: "new", expectedSoul: "old" })).toEqual({ patch: { soul: "new" }, expectedSoul: "old" });
  });
  it("refuses invalid revision values and revisions without instructions", () => {
    for (const body of [{ soul: "new", expectedSoul: 5 }, { name: "bos", expectedSoul: "" }, { soul: "", expectedSoul: "界".repeat(8001) }]) {
      expect(profileSoulEnvelope(body).error).toBeTruthy();
    }
  });
  it("refuses stale edits including clear, without normalizing whitespace", () => {
    expect(profileSoulConflict("old", "changed elsewhere")).toBe(true);
    expect(profileSoulConflict("", "new")).toBe(true);
    expect(profileSoulConflict("old\n", "old")).toBe(true);
    expect(profileSoulConflict("", undefined)).toBe(false);
    expect(profileSoulConflict(undefined, "any")).toBe(false);
    expect(profileSoulConflict("old", "old")).toBe(false);
  });
});
