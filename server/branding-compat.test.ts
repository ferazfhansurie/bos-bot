import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { compatEnvironment, expandEnvNames } from "../electron/branding-env.cjs";
import { isHarnessOwnedMcpEnvName } from "./mcp-registry.ts";
const require = createRequire(import.meta.url);
const { prefixAliases } = require("../electron/branding-compat.json") as { prefixAliases: Array<[string, string]> };

describe("branding environment compatibility", () => {
  it("reads existing service variables through both spellings", () => {
    for (const [canonical, legacy] of prefixAliases) {
      const raw = { [legacy + "FIXTURE"]: "saved" };
      const env = compatEnvironment(raw);
      expect(env[canonical + "FIXTURE"]).toBe("saved");
      expect(env[legacy + "FIXTURE"]).toBe("saved");
    }
  });
  it("prefers the new spelling, including an explicit empty value", () => {
    const raw: Record<string, string | undefined> = { BOSBOT_FIXTURE: "", BOS_FIXTURE: "secondary" };
    for (const [, legacy] of prefixAliases) raw[legacy + "FIXTURE"] = "legacy";
    const env = compatEnvironment(raw);
    for (const [canonical, legacy] of prefixAliases) {
      expect(env[canonical + "FIXTURE"]).toBe("");
      expect(env[legacy + "FIXTURE"]).toBe("");
    }
  });
  it("deleting one spelling clears every credential alias", () => {
    const names = expandEnvNames([prefixAliases[0][1] + "FIXTURE_KEY"]);
    const raw = Object.fromEntries(names.map(name => [name, "fixture"]));
    const env = compatEnvironment(raw);
    delete env.BOSBOT_FIXTURE_KEY;
    expect(Object.keys(raw)).toEqual([]);
  });
  it("preserves writes and produces canonical child env values", () => {
    const [canonical, legacy] = prefixAliases[0];
    const raw: Record<string, string | undefined> = { [legacy + "FIXTURE"]: "saved" };
    const env = compatEnvironment(raw);
    env[canonical + "FIXTURE"] = "new";
    const child = { ...env };
    expect(child[canonical + "FIXTURE"]).toBe("new");
    expect(child[legacy + "FIXTURE"]).toBe("new");
    expect(raw[canonical + "FIXTURE"]).toBe("new");
  });
  it("reserves every spelling from custom MCP servers", () => {
    for (const [canonical, legacy] of prefixAliases) {
      expect(isHarnessOwnedMcpEnvName(canonical + "CAPABILITY")).toBe(true);
      expect(isHarnessOwnedMcpEnvName(legacy + "CAPABILITY")).toBe(true);
    }
    expect(isHarnessOwnedMcpEnvName("CUSTOM_KEY")).toBe(false);
  });
});
