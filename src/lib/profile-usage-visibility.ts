import { useSyncExternalStore } from "react";

const KEY = "bos.profile.hiddenUsageAccounts";
const EVENT = "bos-profile-usage-visibility";
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", notify); };
};
function snapshot(): string {
  try { return localStorage.getItem(KEY) ?? "[]"; } catch { return "[]"; }
}
export function useProfileUsageVisibility() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "[]");
  let hidden: string[] = [];
  try { const value: unknown = JSON.parse(raw); if (Array.isArray(value)) hidden = value.filter((key): key is string => typeof key === "string"); } catch { /* Damaged preferences leave all accounts visible. */ }
  return {
    hidden,
    setVisible: (key: string, visible: boolean) => {
      const next = visible ? hidden.filter(item => item !== key) : [...new Set([...hidden, key])];
      try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(EVENT)); } catch { /* Storage may be disabled. */ }
    },
  };
}
