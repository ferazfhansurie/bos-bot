import { describe, expect, it } from "vitest";

import type { ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { freeFallbackSelection, selectDefaultModelSelection, selectionUsable } from "./default-model-selection.ts";

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "codex-default",
    options: [{ id: "codex-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "claude-default", options: [{ id: "claude-default", label: "Claude" }] },
};

describe("new bot default model selection", () => {
  it("preserves an intentional variant for ACP validation, including variants absent from the preview catalog", () => {
    const preferred = { instanceId: "codex", model: "selected-model", variant: "default" };
    expect(selectDefaultModelSelection([{ ...codex, capabilities: { modelVariants: true } }], preferred))
      .toEqual(preferred);
    expect(selectDefaultModelSelection([codex], preferred)).toEqual({ instanceId: "", model: "" });
    expect(preferred.variant).toBe("default");
  });
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of the Claude preference", (effort) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([claude, codex], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...claude, capabilities: { effortLevels: ["high"] } },
      { ...codex, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "codex", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...codex, models: { default: "codex-default", options: [] } }],
      { instanceId: "codex", model: "codex-default" },
    )).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it.each([
    { label: "missing provider", instances: [claude] },
    { label: "unavailable provider", instances: [claude, { ...codex, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [claude, { ...codex, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "removed model", instances: [claude, { ...codex, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("keeps the existing Claude preference when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, claude])).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });
});

describe("free fallback", () => {
  const free = { instanceId: "bos-free", driverKind: "openrouter-free", snapshot: { state: "available" } satisfies ProviderSnapshot,
    models: { default: "openrouter/free", options: [] } };
  const signedOut = { ...codex, snapshot: { state: "available" as const, authenticated: false } };

  it("treats signed-out, unavailable and missing engines as unusable", () => {
    expect(selectionUsable([signedOut, free], { instanceId: "codex", model: "gpt" })).toBe(false);
    expect(selectionUsable([{ ...codex, snapshot: { state: "unavailable" as const } }], { instanceId: "codex", model: "gpt" })).toBe(false);
    expect(selectionUsable([free], { instanceId: "codex", model: "gpt" })).toBe(false);
    expect(selectionUsable([free], { instanceId: "", model: "" })).toBe(false);
    expect(selectionUsable([codex], { instanceId: "codex", model: "codex-default" })).toBe(true);
  });

  it("offers BOS Free only when it can run", () => {
    expect(freeFallbackSelection([signedOut, free], "bos-free")).toEqual({ instanceId: "bos-free", model: "openrouter/free" });
    expect(freeFallbackSelection([{ ...free, snapshot: { state: "unavailable" as const } }], "bos-free")).toBeNull();
    expect(freeFallbackSelection([codex], "bos-free")).toBeNull();
  });
});

describe("unsaved default", () => {
  it("prefers a signed-in engine over a signed-out Claude", () => {
    const free = { instanceId: "bos-free", driverKind: "openrouter-free", snapshot: { state: "available" } satisfies ProviderSnapshot,
      models: { default: "openrouter/free", options: [] } };
    const signedOutClaude = { ...claude, snapshot: { state: "available" as const, authenticated: false } };
    expect(selectDefaultModelSelection([signedOutClaude, free])).toEqual({ instanceId: "bos-free", model: "openrouter/free" });
    expect(selectDefaultModelSelection([signedOutClaude])).toEqual({ instanceId: "claude", model: "claude-default" });
  });
});
