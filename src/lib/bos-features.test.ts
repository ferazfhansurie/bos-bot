import { describe, expect, it } from "vitest";
import { BOS_FEATURES, BOS_PROVIDERS } from "./bos-features";

describe("bos ui policy", () => {
  it("exposes only the supported personal features", () => {
    expect(BOS_PROVIDERS).toEqual(["claude", "codex"]);
    expect(BOS_FEATURES.hostedWorkspace).toBe(false);
    expect(BOS_FEATURES.telemetry).toBe(false);
  });
});
