import { useSyncExternalStore } from "react";

// Which bots the "today" board leaves out. Renderer-only, stored on this
// device: hiding a bot here changes nothing about the bot itself, its
// threads or the sidebar.

export const HOME_HIDDEN_BOTS_KEY = "omb-home-hidden-bots";

const EMPTY: readonly string[] = [];
let cached: readonly string[] | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function homeHiddenBots(): readonly string[] {
  if (cached) return cached;
  try {
    const raw = JSON.parse(storage()?.getItem(HOME_HIDDEN_BOTS_KEY) ?? "[]");
    cached = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    cached = [];
  }
  return cached;
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== HOME_HIDDEN_BOTS_KEY && event.key !== null) return;
  cached = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setHomeBotHidden(botId: string, hidden: boolean): void {
  const rest = homeHiddenBots().filter((id) => id !== botId);
  cached = hidden ? [...rest, botId] : rest;
  try {
    storage()?.setItem(HOME_HIDDEN_BOTS_KEY, JSON.stringify(cached));
  } catch {
    // the choice still holds for this session when storage refuses it
  }
  notify();
}

export function useHomeHiddenBots(): readonly string[] {
  return useSyncExternalStore(subscribe, homeHiddenBots, () => EMPTY);
}
