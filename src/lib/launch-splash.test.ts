import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM electron module
import { cleanSplashSquad } from "../../electron/launch-splash.mjs";
import { splashSquad } from "./launch-splash";

describe("launch splash squad", () => {
  const bots = [
    { id: "a", color: "blue" as const },
    { id: "chief", color: "white" as const, chiefOfStaff: true },
    { id: "gone", color: "pink" as const, hidden: true },
    { id: "far", color: "orange" as const, homeLink: {} },
    { id: "b", color: "coral" as const, mascotBody: "sun" as const },
  ];

  it("puts the chief first and skips hidden and other homes' bots", () => {
    const squad = splashSquad(bots);
    expect(squad).toHaveLength(3);
    expect(squad[0].idle).toContain('fill="#FFFFFF"');
    expect(squad[0].happy).not.toBe(squad[0].idle);
  });

  it("caps the squad at five and survives the main process's check", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i), color: "blue" as const }));
    const raw = JSON.stringify(splashSquad(many));
    expect(JSON.parse(raw)).toHaveLength(5);
    expect(cleanSplashSquad(raw)).toBe(raw);
  });

  it("rejects anything that is not our mascot svg", () => {
    const bad = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 140 140"><image href="x"/></svg>';
    expect(cleanSplashSquad(JSON.stringify([{ idle: bad, happy: bad }]))).toBeNull();
    expect(cleanSplashSquad("[]")).toBeNull();
    expect(cleanSplashSquad("nope")).toBeNull();
  });
});
