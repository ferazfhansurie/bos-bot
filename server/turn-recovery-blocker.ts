import { overlaps, workspaceResource } from "./turn-resources.ts";
type Receipt = { state: string; threadId: string; workspace?: string; cwd?: string; reviewedAt?: number; reviewedBy?: string };
/** Uncertain provider work is held independently of transient resource leases.
 * A verified manual review releases the hold; it does not dispatch anything. */
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
