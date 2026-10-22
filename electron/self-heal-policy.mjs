import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** c1's local cache is the shared desktop/server rollout contract. Pure data
 * protection and read-only health checks never depend on this optional flag. */
export function selfHealEnabled(dataDir) {
  let descriptor;
  try {
    descriptor = openSync(join(dataDir, "app-config.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 131_072) return false;
    const config = JSON.parse(readFileSync(descriptor, "utf8"));
    return config?.version === 1 && config?.flags?.selfHeal === true;
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
