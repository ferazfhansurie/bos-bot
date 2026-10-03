import { describe, expect, it, vi } from "vitest";
import { createStreamStore, roomStreamingMembers } from "./stream-store";

describe("stream store", () => {
  it("notifies only when the state actually changes", () => {
    const store = createStreamStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((prev) => prev);
    expect(listener).not.toHaveBeenCalled();
    store.set((prev) => ({ ...prev, streaming: { t: "hi" } }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().streaming.t).toBe("hi");
  });

  it("room member signature ignores token growth and other threads", () => {
    const a = { streaming: { "r:room:pix": "he", "r:room:dev": "x", "other:room:yap": "y", r: "z" }, reasoning: {} };
    const b = { streaming: { "r:room:pix": "hello there", "r:room:dev": "xyz", "other:room:yap": "yy" }, reasoning: {} };
    expect(roomStreamingMembers(a, "r")).toBe("dev,pix");
    expect(roomStreamingMembers(b, "r")).toBe(roomStreamingMembers(a, "r"));
    expect(roomStreamingMembers({ streaming: { "r:room:pix": "" }, reasoning: {} }, "r")).toBe("");
  });
});
