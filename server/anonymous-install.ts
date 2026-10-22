import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AnonymousInstall { install_id: string; last_attempt_at?: number }
/** Shared with the daily ping. A corrupt id fails closed, never mints a new installation. */
export function anonymousInstall(dataDir: string): AnonymousInstall | null {
  const file = join(dataDir, "anonymous-usage.json");
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value.install_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.install_id) ||
        value.last_attempt_at !== undefined && (!Number.isSafeInteger(value.last_attempt_at) || value.last_attempt_at < 0)) return null;
    return { install_id: value.install_id, ...(value.last_attempt_at !== undefined ? { last_attempt_at: value.last_attempt_at } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const handle = openSync(file, "wx", 0o600);
      try { writeFileSync(handle, JSON.stringify({ install_id: randomUUID() })); } finally { closeSync(handle); }
      return anonymousInstall(dataDir);
    } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EEXIST" ? anonymousInstall(dataDir) : null; }
  }
}
