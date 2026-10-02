import { describe, expect, it } from "vitest";

import { nativeWhatsAppAction, nativeWhatsAppLabel, type NativeWhatsAppSnapshot } from "./NativeWhatsAppTile";

const snap = (over: Partial<NativeWhatsAppSnapshot>): NativeWhatsAppSnapshot => ({
  state: "not_linked",
  qr: null,
  reason: null,
  sessionExists: false,
  circuitOpen: false,
  failures: 0,
  nextRetryAt: null,
  messageCount: 0,
  ...over,
});

describe("native WhatsApp tile", () => {
  it("shows the server's real state, never a static ready", () => {
    expect(nativeWhatsAppLabel(null)).toBe("Checking…");
    expect(nativeWhatsAppLabel(snap({ state: "linked", messageCount: 3 }))).toMatch(/Linked · read-only · 3 messages/);
    expect(nativeWhatsAppLabel(snap({ state: "qr_pending", qr: "x" }))).toMatch(/Linked devices/);
    expect(nativeWhatsAppLabel(snap({ state: "needs_rescan", reason: "unlinked" }))).toMatch(/new scan — unlinked/);
    expect(nativeWhatsAppLabel(snap({ state: "disconnected", circuitOpen: true }))).toMatch(/Stopped retrying/);
    expect(nativeWhatsAppLabel(snap({ state: "disconnected", nextRetryAt: 5 }))).toMatch(/retrying/);
  });

  it("maps each state to Connect, Reconnect, Rescan or no action", () => {
    expect(nativeWhatsAppAction(snap({}))).toEqual({ label: "Connect", route: "connect" });
    expect(nativeWhatsAppAction(snap({ state: "linked" })).route).toBeNull();
    expect(nativeWhatsAppAction(snap({ state: "linking" })).route).toBeNull();
    expect(nativeWhatsAppAction(snap({ state: "disconnected" }))).toEqual({ label: "Reconnect", route: "reconnect" });
    expect(nativeWhatsAppAction(snap({ state: "needs_rescan" }))).toEqual({ label: "Rescan", route: "reconnect" });
  });
});
