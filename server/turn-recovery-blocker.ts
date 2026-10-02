import { overlaps, workspaceResource } from "./turn-resources.ts";
type Receipt = { state: string; threadId: string; workspace?: string; cwd?: string; reviewedAt?: number; reviewedBy?: string };
/** Uncertain provider work from a dead host. It never blocks sending; it only
 * suppresses automatic incident follow-up and file restores until reviewed.
 * A manual review clears it; nothing is ever dispatched again. */
export function turnRecoveryBlocker(records: Receipt[], target: { threadId?: string; workspace?: string }): Receipt | undefined {
  return records.find(record => {
    if (record.state !== "outcome-unknown" || (Number.isFinite(record.reviewedAt) && (record.reviewedAt ?? 0) > 0 && record.reviewedBy?.trim())) return false;
    if (target.threadId && record.threadId === target.threadId) return true;
    if (!target.workspace) return false;
    let resource = record.workspace;
    if (!resource && record.cwd) {
      try { resource = workspaceResource(record.cwd); }
      catch { resource = `workspace:${record.cwd}`; }
    }
    return Boolean(resource && overlaps(resource, target.workspace));
  });
}
