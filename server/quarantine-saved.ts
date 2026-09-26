import { copyFileSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic.ts";

/** Preserve the exact old bytes before publishing a validated snapshot. */
export function quarantineSaved(file: string, validSnapshot: unknown): string {
  const backup = `${file}.quarantine-${randomUUID()}`;
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
  writeFileAtomic(file, JSON.stringify(validSnapshot), { mode: 0o600 });
  console.warn(`invalid multiplayer entries preserved in ${backup}`);
  return backup;
}
