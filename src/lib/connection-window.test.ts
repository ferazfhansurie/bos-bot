import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveConnectionWindow } from "./connection-window";

afterEach(() => vi.unstubAllGlobals());

describe("connection windows", () => {
  it("reserves before authorization settles and removes opener before external navigation", async () => {
    const calls: string[] = [];
    const popup = { closed: false, opener: {} as unknown, location: { replace: vi.fn(() => calls.push(`navigate:${popup.opener}`)) }, close: vi.fn() };
    vi.stubGlobal("window", { open: vi.fn(() => { calls.push("reserve"); return popup; }) });
    const pending = reserveConnectionWindow();
    calls.push("authorize");
    expect(calls).toEqual(["reserve", "authorize"]);
    expect(popup.opener).toBeNull();
    await expect(pending.navigate("https://auth.example/oauth")).resolves.toBe(true);
    expect(calls).toEqual(["reserve", "authorize", "navigate:null"]);
    pending.cancel();
    expect(popup.close).not.toHaveBeenCalled();
  });
  it("never tries another asynchronous popup when the initial reservation was blocked", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const pending = reserveConnectionWindow();
    await expect(pending.navigate("https://auth.example/oauth")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("closes reservations on errors or cancellation and prevents late authorization navigation", async () => {
    const popup = { closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: vi.fn(() => popup) });
    const pending = reserveConnectionWindow();
    pending.cancel();
    await expect(pending.navigate("https://auth.example/oauth")).resolves.toBe(false);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("reports a desktop opener refusal instead of claiming success", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { openExternal }, open });
    await expect(reserveConnectionWindow().navigate("https://auth.example/oauth")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://auth.example/oauth");
  });
});
