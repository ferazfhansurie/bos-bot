// Lane 2's isSafeMode() contract is BOS_SAFE_MODE=1. Read lane 3's durable
// flags cache here without coupling a detached lane to its unlanded module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
export function modsSuspended(dataDir: string): boolean {
  if (process.env.BOS_SAFE_MODE === "1") return true;
  try { return JSON.parse(readFileSync(join(dataDir, "app-config.json"), "utf8"))?.flags?.mods !== true; }
  catch { return true; }
}
