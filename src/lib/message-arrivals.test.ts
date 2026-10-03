import { describe, expect, it } from "vitest";
import { ARRIVAL_WINDOW_MS, isArriving, trackArrivals } from "./message-arrivals";

const msg = (id: string, at: number) => ({ id, at });

describe("trackArrivals", () => {
  it("leaves what was on screen when the room opened still", () => {
    const state = trackArrivals(null, "t1", [msg("a", 1), msg("b", 2)], 1000);
    expect(isArriving(state, "a")).toBe(false);
    expect(isArriving(state, "b")).toBe(false);
  });

  it("marks a new message as arriving until the window passes", () => {
    let state = trackArrivals(null, "t1", [msg("a", 1)], 1000);
    state = trackArrivals(state, "t1", [msg("a", 1), msg("b", 2)], 1010);
    expect(isArriving(state, "b")).toBe(true);
    state = trackArrivals(state, "t1", [msg("a", 1), msg("b", 2)], 1010 + ARRIVAL_WINDOW_MS - 1);
    expect(isArriving(state, "b")).toBe(true);
    state = trackArrivals(state, "t1", [msg("a", 1), msg("b", 2)], 1010 + ARRIVAL_WINDOW_MS);
    expect(isArriving(state, "b")).toBe(false);
  });

  it("keeps older pages loaded above still", () => {
    let state = trackArrivals(null, "t1", [msg("c", 10)], 1000);
    state = trackArrivals(state, "t1", [msg("a", 1), msg("b", 2), msg("c", 10)], 1010);
    expect(isArriving(state, "a")).toBe(false);
    expect(isArriving(state, "b")).toBe(false);
  });

  it("starts fresh when the room changes", () => {
    let state = trackArrivals(null, "t1", [msg("a", 1)], 1000);
    state = trackArrivals(state, "t2", [msg("x", 5)], 1010);
    expect(isArriving(state, "x")).toBe(false);
  });
});
