import { describe, expect, it } from "vitest";

import catalog from "../../shared/marketplace-catalog.json";
import { pickModelSelection, rentRequestEmail, slugify, type MarketplaceEntry, type ModelInstance } from "./marketplace";

const entry = catalog.bots[0] as unknown as MarketplaceEntry;

const instance = (over: Omit<Partial<ModelInstance>, "models"> & { models?: string[] } = {}): ModelInstance => ({
  instanceId: over.instanceId ?? "claude",
  driverKind: over.driverKind ?? "claude",
  displayName: over.displayName ?? "Claude",
  snapshot: over.snapshot ?? { state: "available" },
  models: { options: (over.models ?? ["claude-sonnet-5", "claude-opus-5-5"]).map((id) => ({ id, label: id.toUpperCase() })) },
});

describe("pickModelSelection", () => {
  it("picks an available engine of the right kind that offers the model", () => {
    const picked = pickModelSelection(entry.model, [
      instance({ instanceId: "codex", driverKind: "codex", models: ["claude-opus-5-5"] }),
      instance({ instanceId: "claude-down", snapshot: { state: "unavailable" } }),
      instance({ instanceId: "claude-2" }),
    ]);
    expect(picked).toEqual({ instanceId: "claude-2", model: "claude-opus-5-5", label: "Claude · CLAUDE-OPUS-5-5" });
  });

  it("returns null when no engine has the model, or none is recommended", () => {
    expect(pickModelSelection(entry.model, [instance({ models: ["claude-sonnet-5"] })])).toBeNull();
    expect(pickModelSelection(undefined, [instance()])).toBeNull();
  });

  it("carries a recommended effort", () => {
    expect(pickModelSelection({ ...entry.model!, effort: "high" }, [instance()])?.effort).toBe("high");
  });
});

describe("rentRequestEmail", () => {
  it("addresses the publisher and carries the bot, price and note", () => {
    const mail = rentRequestEmail(entry, "for my agency");
    expect(mail.to).toBe("ferazfhansurie@gmail.com");
    expect(mail.subject).toBe("Rent request: bos");
    expect(mail.body).toContain("Priced per request");
    expect(mail.text).toContain("for my agency");
  });
});

it("slugify makes a catalog slug", () => {
  expect(slugify("  Closer Bot!! ")).toBe("closer-bot");
  expect(slugify("***")).toBe("bot");
});
