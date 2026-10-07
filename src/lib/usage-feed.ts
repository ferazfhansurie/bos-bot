// Subscription limits and xAI voice usage, fetched once for the whole window
// and shared by the sidebar row and Settings → Usage. Polls at most every
// 5 min while anything is watching; the last good answer is kept in
// localStorage, so offline (or a restart) still shows a value and its time.
import { useSyncExternalStore } from "react";

export const USAGE_POLL_MS = 5 * 60_000;

export interface Feed<T> {
  value: T | null;
  /** when `value` was read, ms since epoch */
  fetchedAt: number | null;
  /** the last refresh failed; `value` is the older answer, if any */
  failed: boolean;
}

export interface UsageFeedDeps {
  load: () => Promise<unknown>;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createUsageFeed<T>(storageKey: string, deps: UsageFeedDeps) {
  const now = deps.now ?? Date.now;
  const storage = deps.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : deps.storage;
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let state: Feed<T> = { value: null, fetchedAt: null, failed: false };
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "null") as { value?: T; fetchedAt?: number } | null;
    if (saved && saved.value !== undefined && typeof saved.fetchedAt === "number") {
      state = { value: saved.value, fetchedAt: saved.fetchedAt, failed: false };
    }
  } catch {
    /* a bad cache is no cache */
  }
  const watchers = new Set<() => void>();
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;

  const set = (next: Feed<T>) => {
    state = next;
    for (const fn of Array.from(watchers)) fn();
  };

  const refresh = (): Promise<void> => {
    inFlight ??= deps
      .load()
      .then((value) => {
        const fetchedAt = now();
        set({ value: value as T, fetchedAt, failed: false });
        try {
          storage?.setItem(storageKey, JSON.stringify({ value, fetchedAt }));
        } catch {
          /* storage full or blocked: the in-memory copy still works */
        }
      })
      .catch(() => set({ ...state, failed: true }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const subscribe = (fn: () => void) => {
    watchers.add(fn);
    if (watchers.size === 1) {
      if (state.fetchedAt === null || now() - state.fetchedAt >= USAGE_POLL_MS) void refresh();
      timer = every(() => void refresh(), USAGE_POLL_MS);
    }
    return () => {
      watchers.delete(fn);
      if (watchers.size === 0 && timer !== null) {
        stop(timer);
        timer = null;
      }
    };
  };

  return {
    subscribe,
    refresh,
    get: () => state,
  };
}

export function useFeed<T>(feed: ReturnType<typeof createUsageFeed<T>>): Feed<T> {
  return useSyncExternalStore(feed.subscribe, feed.get, feed.get);
}
