import { useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { DEFAULT_APP_CONFIG, parseAppConfig, type AppConfig } from "../../shared/app-config";
export type { AppConfig, AppPricing, StarterJob } from "../../shared/app-config";

let config = DEFAULT_APP_CONFIG;
let pending: Promise<AppConfig> | undefined;
let lastRead = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
export function getAppConfig(): Promise<AppConfig> {
  if (pending) return pending;
  if (Date.now() - lastRead < 15 * 60_000) return Promise.resolve(config);
  pending = (async () => {
    try {
      const product = await api<{ config: unknown }>("/api/product");
      config = parseAppConfig(product.config); lastRead = Date.now();
      for (const listener of listeners) listener();
    } catch { /* Keep the last valid snapshot through an outage. */ }
    return config;
  })().finally(() => { pending = undefined; });
  return pending;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener); void getAppConfig();
  if (!timer) timer = setInterval(() => { void getAppConfig(); }, 15 * 60_000);
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } };
}
export function useAppConfig(): AppConfig { return useSyncExternalStore(subscribe, () => config, () => DEFAULT_APP_CONFIG); }
