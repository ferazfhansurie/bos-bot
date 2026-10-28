import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { lastSteeredId, noteSteer, steerAckFresh } from "./steer-ack";

const msg = (id: string, role: "user" | "bot", extra: Partial<Message> = {}) =>
  ({ id, role, text: id, ...extra }) as Message;

describe("lastSteeredId", () => {
  it("finds words the running turn took in", () => {
    expect(lastSteeredId([msg("a", "user"), msg("b", "bot"), msg("c", "user", { steered: true }), msg("d", "bot")])).toBe("c");
  });
  it("ignores a steer older than the newest user message", () => {
    expect(lastSteeredId([msg("a", "user", { steered: true }), msg("b", "bot"), msg("c", "user")])).toBeUndefined();
  });
  it("ignores an unknown outcome and an empty thread", () => {
    expect(lastSteeredId([msg("a", "user", { steered: false, steerDelivery: "outcome_unknown" })])).toBeUndefined();
    expect(lastSteeredId([])).toBeUndefined();
  });
});

describe("steerAckFresh", () => {
  const seen = { scope: "bot:t1", ids: new Set(["old"]) };
  it("acks a new steer on the same thread while the island is up", () => {
    expect(steerAckFresh(seen, "bot:t1", true, "new")).toBe(true);
  });
  it("stays quiet on a seen id, a thread switch, the island down or no steer", () => {
    expect(steerAckFresh(seen, "bot:t1", true, "old")).toBe(false);
    expect(steerAckFresh(seen, "bot:t2", true, "new")).toBe(false);
    expect(steerAckFresh(seen, "bot:t1", false, "new")).toBe(false);
    expect(steerAckFresh(seen, "bot:t1", true, undefined)).toBe(false);
  });
  it("stays quiet when a steer drops out behind a queued send and comes back", () => {
    let s = noteSteer({ scope: "bot:t1", ids: new Set() }, "bot:t1", "c");
    s = noteSteer(s, "bot:t1", undefined); // the queued send, for a moment
    expect(steerAckFresh(s, "bot:t1", true, "c")).toBe(false);
  });
  it("starts over on a new thread", () => {
    const s = noteSteer({ scope: "bot:t1", ids: new Set(["c"]) }, "bot:t2", undefined);
    expect(s.ids.size).toBe(0);
    expect(steerAckFresh(s, "bot:t2", true, "c")).toBe(true);
  });
});
