import { describe, expect, it } from "vitest";
import { BOS_PRODUCT, isBosProvider } from "./bos-product";

describe("bos product policy", () => {
  it("keeps the personal desktop local and limited to official subscription CLIs", () => {
    expect(BOS_PRODUCT.localOnly).toBe(true);
    expect(BOS_PRODUCT.supportedProviders).toEqual(["claude", "codex"]);
    expect(isBosProvider("claude")).toBe(true);
    expect(isBosProvider("grok")).toBe(false);
    expect(BOS_PRODUCT.features.localComputerControl).toBe("opt-in");
  });
});
