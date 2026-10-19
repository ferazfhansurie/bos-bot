import { describe, expect, it } from "vitest";
import { signInBeforeSend, type Bot, type InstanceInfo } from "./store";

const engine = (snapshot: Partial<InstanceInfo["snapshot"]>, access?: string) =>
  ({ instanceId: Math.random().toString(36), driverKind: "codex", snapshot: { state: "available", ...snapshot }, ...(access ? { access } : {}) }) as unknown as InstanceInfo;

describe("signInBeforeSend", () => {
  it("locks when every available engine is signed out", () => {
    expect(signInBeforeSend({ instances: [engine({ authenticated: false }), engine({ authenticated: false })], bots: [] })).toBe(true);
  });
  it("unlocks once any engine can run", () => {
    expect(signInBeforeSend({ instances: [engine({ authenticated: false }), engine({ authenticated: true })], bots: [] })).toBe(false);
    expect(signInBeforeSend({ instances: [engine({ authenticated: false }, "custom")], bots: [] })).toBe(false);
  });
  it("never locks on missing or unknown engines, or for a remote bot", () => {
    expect(signInBeforeSend({ instances: [], bots: [] })).toBe(false);
    expect(signInBeforeSend({ instances: [engine({ state: "unavailable" })], bots: [] })).toBe(false);
    expect(signInBeforeSend({ instances: [engine({ authenticated: false })], bots: [{ id: "r", remote: true } as unknown as Bot] }, "r")).toBe(false);
  });
});
