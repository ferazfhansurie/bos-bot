// 3.0: things the bot shows the person once. The first-run teach steps and
// the first-time nod at a card's primary button each have a key; once it is
// seen it stays seen on this computer. Kept in localStorage, not the server
// record: it is about this screen, and a missing store just means the bot
// shows it again, never that it breaks.
import { useSyncExternalStore } from "react";

const KEY = "bos-v3-seen";

let cache: Set<string> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    cache = new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => version;

export function seen(key: string): boolean {
  return load().has(key);
}

export function markSeen(key: string): void {
  const set = load();
  if (set.has(key)) return;
  set.add(key);
  try {
    // the newest 400 keys are plenty; a nod per card kind, not per card
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-400)));
  } catch {
    /* private mode: seen for this session only */
  }
  version += 1;
  for (const listener of listeners) listener();
}

/** Re-renders when anything is marked seen. */
export function useSeen(key: string): boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return seen(key);
}

/** test seam */
export function __resetSeen(): void {
  cache = null;
  version += 1;
}
