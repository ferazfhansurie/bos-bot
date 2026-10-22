import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
export interface ProductHealth { update_state?: string; crash_count?: number }
function read(dataDir: string, name: string): Record<string, unknown> | null {
  try {
    const file = join(dataDir, name); if (statSync(file).size > 4096) return null;
    const value = JSON.parse(readFileSync(file, "utf8")); return value && typeof value === "object" ? value : null;
  } catch { return null; }
}
/** Missing state is unavailable, never a synthetic healthy value or zero. */
export function productHealth(dataDir: string): ProductHealth {
  const health: ProductHealth = {};
  const update = read(dataDir, "update-state.json")?.update_state;
  if (typeof update === "string" && /^(?:idle|checking|downloading|downloaded|failed:(?:network|feed|verification|install|unknown))$/.test(update)) health.update_state = update;
  const count = read(dataDir, "crash-count.json")?.count;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) health.crash_count = count;
  return health;
}
