import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export interface RecoveryNotice {
  id: string;
  collection: "bots.json" | "groups.json" | "messages.db";
  status: "restored" | "read-only" | "fresh";
  detail: string;
  at: number;
}

export function recoveryNotices(dataDir: string): RecoveryNotice[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(join(dataDir, "recovery-notices.json"), "utf8"));
    return Array.isArray(rows) ? rows.filter((row): row is RecoveryNotice => row && typeof row.id === "string" &&
      ["bots.json", "groups.json", "messages.db"].includes(row.collection) &&
      ["restored", "read-only", "fresh"].includes(row.status) && typeof row.detail === "string" && Number.isFinite(row.at)) : [];
  } catch { return []; }
}

export function recordRecoveryNotice(dataDir: string, notice: Omit<RecoveryNotice, "id" | "at">): void {
  console.warn(`[recovery] ${notice.detail}`);
  try {
    const rows = recoveryNotices(dataDir).filter(row => row.collection !== notice.collection);
    rows.push({ ...notice, id: notice.collection, at: Date.now() });
    writeFileAtomic(join(dataDir, "recovery-notices.json"), JSON.stringify(rows), { mode: 0o600 });
  } catch { /* A full or read-only disk must not stop the independent collections. */ }
}

/** Drops a notice only while it still says exactly `detail`, so a transient
 * read-only hold disappears once the file opens again, but a restore or
 * reset notice the person has not seen yet is kept. */
export function clearRecoveryNotice(dataDir: string, collection: RecoveryNotice["collection"], detail: string): void {
  const rows = recoveryNotices(dataDir);
  if (!rows.some(row => row.collection === collection && row.detail === detail)) return;
  try {
    writeFileAtomic(join(dataDir, "recovery-notices.json"), JSON.stringify(rows.filter(row => !(row.collection === collection && row.detail === detail))), { mode: 0o600 });
  } catch { /* Stale notice is cosmetic. */ }
}
