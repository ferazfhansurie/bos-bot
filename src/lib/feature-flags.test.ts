import { describe, expect, it } from "vitest";

import { autoSkillsEnabled, builtInBrowserEnabled, sharedComputersEnabled, showToolCallsEnabled, skillAuthoringEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps skill authoring on by default, before and after the config arrives", () => {
    expect(skillAuthoringEnabled(null)).toBe(true);
    expect(skillAuthoringEnabled({})).toBe(true);
    expect(skillAuthoringEnabled({ features: {} })).toBe(true);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
  });

  it("switches skill authoring off only on an explicit opt-out", () => {
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
  });

  it("learns skills automatically whenever skill authoring is on, unless switched off", () => {
    expect(autoSkillsEnabled(null)).toBe(true);
    expect(autoSkillsEnabled({ features: {} })).toBe(true);
    expect(autoSkillsEnabled({ features: { autoSkills: false } })).toBe(false);
    expect(autoSkillsEnabled({ features: { skillAuthoring: false } })).toBe(false);
    expect(autoSkillsEnabled({ features: { skillAuthoring: false, autoSkills: true } })).toBe(false);
  });

  it("keeps the built-in browser on unless a saved config switched it off", () => {
    expect(builtInBrowserEnabled(null)).toBe(true);
    expect(builtInBrowserEnabled({})).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
  });

  it("shows tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(true);
    expect(showToolCallsEnabled({})).toBe(true);
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("hides tool-call chips only after an explicit opt-out", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("keeps computer sharing off unless the server says it is on", () => {
    expect(sharedComputersEnabled(null)).toBe(false);
    expect(sharedComputersEnabled({})).toBe(false);
    expect(sharedComputersEnabled({ features: {} })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: false } })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: true } })).toBe(true);
  });
});
