import { useEffect, useSyncExternalStore } from "react";
import { track } from "@/lib/analytics";
import { api } from "@/state/store";
import type { ModRecord } from "../../shared/mods";
export type ModSummary = Omit<ModRecord, "files">;
let mods: ModSummary[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let loading = false;
let initialized = false;
export function modsDesktop() { return typeof window !== "undefined" && !/iPhone|iPad|Android/i.test(navigator.userAgent) && matchMedia("(min-width: 768px)").matches; }
export async function refreshMods() {
  if (loading || !modsDesktop()) return;
  loading = true;
  try {
    const data = await api<{ mods: ModSummary[] }>("/api/mods");
    if (initialized) for (const mod of data.mods) if (!mods.some(previous => previous.manifest.id === mod.manifest.id)) track("mod_created");
    initialized = true;
    if (JSON.stringify(data.mods) !== JSON.stringify(mods)) { mods = data.mods; listeners.forEach(fn => fn()); }
  } catch { if (mods.length) { mods = []; listeners.forEach(fn => fn()); } }
  finally { loading = false; }
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } }; };
export function useMods() {
  useEffect(() => {
    if (!modsDesktop()) return;
    void refreshMods(); if (!timer) timer = setInterval(() => void refreshMods(), 1500);
    return () => { if (listeners.size === 0 && timer) { clearInterval(timer); timer = undefined; } };
  }, []);
  return useSyncExternalStore(subscribe, () => mods);
}
