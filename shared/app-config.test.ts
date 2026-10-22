import { describe, expect, it } from "vitest";
import { DEFAULT_APP_CONFIG, parseAppConfig } from "./app-config.ts";

describe("remote product config", () => {
  it("uses safe defaults for absent or future schemas", () => {
    expect(parseAppConfig(null)).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig({ version: 2, flags: { plans: false } })).toEqual(DEFAULT_APP_CONFIG);
    expect(DEFAULT_APP_CONFIG.minVersion.desktop).toBe("0.0.0");
  });
  it("accepts bounded known config and refuses executable or insecure links", () => {
    const config = parseAppConfig({ version: 1, flags: { plans: false, arbitrary: true },
      minVersion: { desktop: "2.1.3", ios: "bad" },
      banner: { id: "notice", text: "hello", url: "javascript:alert(1)" },
      pricing: [{ id: "managed", title: "Managed", priceMYR: 1500, unit: "/month", status: "available", url: "https://bosbot.my/#pricing", description: "help" }],
      starterJobs: [{ id: "work-groups", title: "Work groups", prompt: "Summarise my work groups" }], rollout: { desktop: 10 },
    });
    expect(config.flags.plans).toBe(false);
    expect(config.flags).not.toHaveProperty("arbitrary");
    expect(config.minVersion).toEqual({ desktop: "2.1.3", ios: "0.0.0", android: "0.0.0" });
    expect(config.banner).toBeNull();
    expect(config.pricing[0].priceMYR).toBe(1500);
    expect(config.starterJobs[0].id).toBe("work-groups");
    expect(config.rollout.desktop).toBe(10);
  });
});
