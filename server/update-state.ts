import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type UpdateState = "idle" | "checking" | "downloading" | "downloaded" |
  `failed:${"network" | "feed" | "verification" | "install" | "unknown"}`;

/** Read only the small, redacted snapshot written by the Electron parent. */
export function readUpdateState(dataDir: string): UpdateState {
  try {
    const file = join(dataDir, "update-state.json");
    if (statSync(file).size > 1024) return "idle";
    const value: unknown = JSON.parse(readFileSync(file, "utf8")).update_state;
    if (typeof value === "string" && /^(idle|checking|downloading|downloaded|failed:(network|feed|verification|install|unknown))$/.test(value)) {
      return value as UpdateState;
    }
  } catch { /* Standalone servers and first launches have no desktop snapshot. */ }
  return "idle";
}
