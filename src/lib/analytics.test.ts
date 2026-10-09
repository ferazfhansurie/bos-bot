// BOS Bot's personal edition never sends product analytics: there is no
// opt-in, so every entry point must stay off and leave storage untouched,
// whatever a previous OpenMaus install left behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyticsEnabled,
  emailGateDone,
  identifyEmail,
  initAnalytics,
  optAction,
  setAnalyticsEnabled,
  setEmailGateDone,
  track,
} from "./analytics";

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => store.clear());
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

describe("analytics in the personal edition", () => {
  it("is off for a fresh install", () => {
    expect(analyticsEnabled()).toBe(false);
  });

  it("stays off when something tries to turn it on", () => {
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(false);
  });

  it("stays off when an old install left an opt-in behind", () => {
    store.set("omb-analytics-opt-out", "0");
    expect(analyticsEnabled()).toBe(false);
  });

  it("never asks for a client in any opt state", () => {
    for (const enabled of [true, false]) {
      for (const running of [true, false]) {
        expect(optAction(enabled, running)).toBe("none");
      }
    }
  });

  it("touches no storage on init, track or identify", () => {
    initAnalytics();
    track("app_opened", { a: 1 });
    identifyEmail("someone@example.com");
    setAnalyticsEnabled(true);
    expect(store.size).toBe(0);
  });
});

describe("the email gate", () => {
  it("is open until submitted or skipped", () => {
    expect(emailGateDone()).toBe(false);
    setEmailGateDone("skipped");
    expect(emailGateDone()).toBe(true);
  });
});
