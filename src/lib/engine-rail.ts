// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

export function isFreeCloud(instance: { driverKind?: string } | undefined): boolean {
  return instance?.driverKind === "openrouter-free";
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"]; driverKind?: string } | undefined): boolean {
  return instance?.access === "custom" && !isFreeCloud(instance);
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    if (isCustomOnly(instance as { access?: InstanceInfo["access"] })) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom };
}
