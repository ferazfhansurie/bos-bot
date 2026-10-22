export type HealthStatus = "ok" | "warning" | "error" | "unavailable";
export type HealthFix =
  | { kind: "settings"; section: "engines" | "connections" | "updates" | "companion"; label: string }
  | { kind: "action"; action: "reconnect-whatsapp"; label: string };
export interface HealthCheck { id: string; status: HealthStatus; detail: string; fix?: HealthFix }
export interface HealthNotice {
  id: string; collection: "bots.json" | "groups.json" | "messages.db";
  status: "restored" | "read-only" | "fresh"; detail: string; at: number;
}
export interface HealthReport {
  selfHealEnabled?: boolean;
  checkedAt: number;
  checks: HealthCheck[];
  notices: HealthNotice[];
  safeMode: { enabled: boolean; reason: string | null };
}
