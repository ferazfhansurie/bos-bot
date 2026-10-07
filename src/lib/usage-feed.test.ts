import { describe, expect, it } from "vitest";
import { createUsageFeed, USAGE_POLL_MS } from "./usage-feed";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("usage feed", () => {
  it("fetches once for every watcher and polls every 5 minutes at most", async () => {
    let loads = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const feed = createUsageFeed<number>("k", {
      load: async () => ++loads,
      storage: memoryStorage(),
      now: () => 0,
      setInterval: (fn, ms) => timers.push({ fn, ms }),
      clearInterval: () => {},
    });
    const offA = feed.subscribe(() => {});
    const offB = feed.subscribe(() => {});
    await feed.refresh();
    expect(loads).toBe(1);
    expect(timers).toEqual([expect.objectContaining({ ms: USAGE_POLL_MS })]);
    offA();
    offB();
  });

  it("starts from the cached value and keeps it, with its time, when offline", async () => {
    const storage = memoryStorage({ k: JSON.stringify({ value: 42, fetchedAt: 1000 }) });
    const feed = createUsageFeed<number>("k", {
      load: async () => {
        throw new Error("offline");
      },
      storage,
      now: () => 1000 + USAGE_POLL_MS,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(feed.get()).toEqual({ value: 42, fetchedAt: 1000, failed: false });
    const off = feed.subscribe(() => {});
    await feed.refresh();
    expect(feed.get()).toEqual({ value: 42, fetchedAt: 1000, failed: true });
    off();
  });

  it("does not refetch on mount while the cache is fresh, and saves new values", async () => {
    let loads = 0;
    const storage = memoryStorage({ k: JSON.stringify({ value: 1, fetchedAt: 1000 }) });
    const feed = createUsageFeed<number>("k", {
      load: async () => ++loads + 1,
      storage,
      now: () => 1000 + 60_000,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    const off = feed.subscribe(() => {});
    expect(loads).toBe(0);
    await feed.refresh();
    expect(JSON.parse(storage.data.get("k")!)).toEqual({ value: 2, fetchedAt: 61_000 });
    off();
  });
});
