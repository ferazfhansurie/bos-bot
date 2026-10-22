/** Optional systems share one boot-time switch; exiting safe mode restarts the desktop. */
export function isSafeMode(): boolean {
  return process.env.BOS_SAFE_MODE === "1";
}
export function safeModeStatus(): { enabled: boolean; reason: string | null } {
  return { enabled: isSafeMode(), reason: isSafeMode() ? (process.env.BOS_SAFE_MODE_REASON || "The server stopped repeatedly").slice(0, 240) : null };
}
export function allowInSafeMode(_feature: "mods" | "plugins" | "routines"): boolean {
  return !isSafeMode();
}
