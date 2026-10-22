import type { HealthCheck, HealthNotice, HealthReport } from "../shared/doctor.ts";

interface DoctorEngine {
  snapshot: { state: string; authenticated?: boolean };
  access?: string;
  cliDefault?: string;
  cli?: string;
  cliCandidates?: string[];
}
export interface DoctorDependencies {
  selfHealEnabled?(): boolean;
  engines(): Promise<DoctorEngine[]>;
  server(): { listening: boolean; port: number };
  whatsapp(): { enabled: boolean; state: string; sessionExists: boolean };
  freeBytes(): Promise<number>;
  update(): Promise<{ state: string } | null>;
  pushConfigured(): boolean;
  reconnectWhatsApp(): Promise<unknown>;
  notices?(): HealthNotice[];
  safeMode?(): HealthReport["safeMode"];
}

const enginesFix = { kind: "settings", section: "engines", label: "Open engines" } as const;
const whatsappFix = { kind: "settings", section: "connections", label: "Open connections" } as const;
const updateFix = { kind: "settings", section: "updates", label: "Open updates" } as const;
const canReconnect = (state: ReturnType<DoctorDependencies["whatsapp"]>) => state.enabled && state.sessionExists && ["disconnected", "error"].includes(state.state);

/** Observations only. A failed probe never turns another service green or leaks its error. */
export function createDoctor(deps: DoctorDependencies) {
  const check = async (): Promise<HealthReport> => {
    const engines = Promise.resolve().then(() => deps.engines());
    // Install a rejection handler immediately; individual probes await this same scan.
    void engines.catch(() => {});
    const probe = async (id: string, inspect: () => HealthCheck | Promise<HealthCheck>): Promise<HealthCheck> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(inspect),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Health check timed out")), 8_000); timer.unref?.(); }),
        ]);
      } catch { return { id, status: "unavailable", detail: "This check could not run. Try checking again." }; }
      finally { if (timer) clearTimeout(timer); }
    };
    const checks = await Promise.all([
      probe("engine", async () => {
        const rows = await engines;
        const ready = rows.filter(row => row.snapshot.state === "available" && (row.snapshot.authenticated === true || row.access === "custom"));
        return ready.length
          ? { id: "engine", status: "ok", detail: `${ready.length} engine${ready.length === 1 ? " is" : "s are"} ready.` }
          : { id: "engine", status: "warning", detail: "No signed-in engine is ready. Check your provider connection.", fix: enginesFix };
      }),
      probe("cli", async () => {
        const rows = (await engines).filter(row => row.cliDefault);
        if (!rows.length) return { id: "cli", status: "ok", detail: "No local CLI is required for your configured engines." };
        const missing = rows.filter(row => !row.cliCandidates?.length && !(row.cli && row.snapshot.state === "available"));
        return missing.length
          ? { id: "cli", status: "warning", detail: `${missing.length} configured engine CLI${missing.length === 1 ? " is" : "s are"} missing. Install or select a CLI in Engines.`, fix: enginesFix }
          : { id: "cli", status: "ok", detail: "Configured engine CLIs are available." };
      }),
      probe("server", () => {
        const state = deps.server();
        return state.listening ? { id: "server", status: "ok", detail: `BOS is listening on port ${state.port}.` }
          : { id: "server", status: "error", detail: "The BOS server is not listening." };
      }),
      probe("whatsapp", () => {
        const state = deps.whatsapp();
        if (!state.enabled) return { id: "whatsapp", status: "unavailable", detail: "Native WhatsApp is disabled on this BOS." };
        if (state.state === "linked") return { id: "whatsapp", status: "ok", detail: "WhatsApp is connected." };
        return { id: "whatsapp", status: "warning", detail: ["linking", "qr_pending"].includes(state.state) ? "WhatsApp linking is in progress." : "WhatsApp is not connected.",
          fix: canReconnect(state) ? { kind: "action", action: "reconnect-whatsapp", label: "Reconnect WhatsApp" } : whatsappFix };
      }),
      probe("disk", async () => {
        const bytes = await deps.freeBytes();
        if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Disk space unavailable");
        return { id: "disk", status: bytes < 1024 ** 3 ? "warning" : "ok", detail: `${(bytes / 1024 ** 3).toFixed(1)} GB free on the BOS data drive.${bytes < 1024 ** 3 ? " Free some space to keep saves and updates working." : ""}` };
      }),
      probe("update", async () => {
        const state = await deps.update();
        if (!state) return { id: "update", status: "unavailable", detail: "Desktop update state is unavailable on this server.", fix: updateFix };
        const failed = state.state === "error" || state.state.startsWith("failed");
        return { id: "update", status: failed || ["downloaded", "ready"].includes(state.state) ? "warning" : "ok",
          detail: failed ? "The last update failed. Open Updates to retry." : state.state === "downloaded" ? "An update is downloaded and ready to finish." : state.state === "ready" ? "An update is available." : "The update service is running.", ...(state.state === "idle" ? {} : { fix: updateFix }) };
      }),
      probe("push", () => deps.pushConfigured()
        ? { id: "push", status: "ok", detail: "Push delivery is configured. Phone notification permission is checked on your phone." }
        : { id: "push", status: "warning", detail: "Push is not set up on this BOS. Phone notifications cannot be delivered.", fix: { kind: "settings", section: "companion", label: "Open device settings" } }),
    ]);
    return { checkedAt: Date.now(), checks, notices: deps.notices?.() ?? [], safeMode: deps.safeMode?.() ?? { enabled: false, reason: null }, selfHealEnabled: deps.selfHealEnabled?.() ?? true };
  };
  return {
    check,
    async fix(action: string): Promise<HealthReport> {
      if (action !== "reconnect-whatsapp") throw Object.assign(new Error("Unknown health action"), { status: 400 });
      if (deps.selfHealEnabled?.() === false) throw Object.assign(new Error("Automatic repairs are not enabled on this BOS yet. Use Connections to reconnect."), { status: 503 });
      if (!canReconnect(deps.whatsapp())) throw Object.assign(new Error("Link WhatsApp from Connections before reconnecting."), { status: 409 });
      await deps.reconnectWhatsApp();
      return check();
    },
  };
}
