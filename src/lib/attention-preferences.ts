import { useSyncExternalStore } from "react";

// How much a bot may interrupt the person, and what a send does while a turn
// is running. Renderer-only preferences: the server still owns each bot's own
// notifications switch; these decide how this desktop shows what it is sent.

export type DoneNotifyMode = "unfocused" | "always" | "off";
export type NotifySound = "none" | "default" | "Glass" | "Ping" | "Tink" | "Pop";
export type FollowUpMode = "queue" | "steer";

export interface AttentionPreferences {
  approval: boolean;
  question: boolean;
  message: boolean;
  done: DoneNotifyMode;
  sound: NotifySound;
  followUps: FollowUpMode;
}

export const ATTENTION_PREFERENCES_KEY = "omb-attention-preferences";

export const DEFAULT_ATTENTION_PREFERENCES: AttentionPreferences = {
  approval: true,
  question: true,
  message: true,
  done: "unfocused",
  sound: "default",
  followUps: "steer",
};

export const NOTIFY_SOUNDS: readonly NotifySound[] = ["none", "default", "Glass", "Ping", "Tink", "Pop"];

let cached: AttentionPreferences | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalize(raw: unknown): AttentionPreferences {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (key: "approval" | "question" | "message") =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_ATTENTION_PREFERENCES[key];
  return {
    approval: flag("approval"),
    question: flag("question"),
    message: flag("message"),
    done: value.done === "always" || value.done === "off" ? value.done : "unfocused",
    sound: NOTIFY_SOUNDS.includes(value.sound as NotifySound) ? (value.sound as NotifySound) : "default",
    followUps: value.followUps === "queue" ? "queue" : "steer",
  };
}

export function attentionPreferences(): AttentionPreferences {
  if (cached) return cached;
  try {
    const raw = storage()?.getItem(ATTENTION_PREFERENCES_KEY);
    cached = normalize(raw ? JSON.parse(raw) : null);
  } catch {
    cached = { ...DEFAULT_ATTENTION_PREFERENCES };
  }
  return cached;
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== ATTENTION_PREFERENCES_KEY && event.key !== null) return;
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

export function setAttentionPreferences(patch: Partial<AttentionPreferences>): void {
  cached = normalize({ ...attentionPreferences(), ...patch });
  try {
    storage()?.setItem(ATTENTION_PREFERENCES_KEY, JSON.stringify(cached));
  } catch {
    // the choice still holds for this session when storage refuses it
  }
  notify();
}

export function useAttentionPreferences(): AttentionPreferences {
  return useSyncExternalStore(subscribe, attentionPreferences, () => DEFAULT_ATTENTION_PREFERENCES);
}
