/** Policies are snapshotted on each run; the central log always retains results. */
export type RoutineNotificationPolicy = "all" | "important" | "failures";
export interface RoutineNotificationState {
  notificationPolicy?: RoutineNotificationPolicy;
  status: string;
  quiet?: boolean;
  important?: boolean;
}
export function shouldSurfaceRoutineRun(run: RoutineNotificationState): boolean {
  if (run.quiet) return false;
  if (["failed", "missed"].includes(run.status)) return true;
  if (run.notificationPolicy === "failures") return false;
  if (run.status === "waiting") return true;
  return run.notificationPolicy !== "important" || run.important === true;
}
export const ROUTINE_IMPORTANT_MARKER = "IMPORTANT_UPDATE:";
