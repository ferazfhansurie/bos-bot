import { describe, expect, it, vi } from "vitest";
import { createDoctor, type DoctorDependencies } from "./doctor.ts";

const healthy = (): DoctorDependencies => ({
  engines: async () => [{ snapshot: { state: "available", authenticated: true }, access: "subscription", cliDefault: "claude", cliCandidates: ["/fixture/claude"] }],
  server: () => ({ listening: true, port: 12345 }),
  whatsapp: () => ({ enabled: true, state: "linked", sessionExists: true }),
  freeBytes: async () => 10 * 1024 ** 3,
  update: async () => ({ state: "idle" }),
  pushConfigured: () => true,
  reconnectWhatsApp: async () => {},
});
const check = async (deps: DoctorDependencies, id: string) => (await createDoctor(deps).check()).checks.find(row => row.id === id);

describe("workspace doctor", () => {
  it("keeps checks available but refuses repairs while c1 self-heal rollout is off", async () => {
    const deps = healthy(); deps.selfHealEnabled = () => false;
    deps.whatsapp = () => ({ enabled: true, state: "disconnected", sessionExists: true });
    deps.reconnectWhatsApp = vi.fn();
    const doctor = createDoctor(deps);
    expect(await doctor.check()).toMatchObject({ selfHealEnabled: false });
    await expect(doctor.fix("reconnect-whatsapp")).rejects.toThrow("not enabled");
    expect(deps.reconnectWhatsApp).not.toHaveBeenCalled();
  });
  it("checks all seven services without exposing CLI paths or account data", async () => {
    const result = await createDoctor(healthy()).check();
    expect(result.checks.map(row => row.id)).toEqual(["engine", "cli", "server", "whatsapp", "disk", "update", "push"]);
    expect(result.checks.every(row => row.status === "ok")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/fixture");
  });
  it("does not report an unknown authentication state as signed in", async () => {
    const deps = healthy(); deps.engines = async () => [{ snapshot: { state: "available" }, access: "subscription" }];
    expect(await check(deps, "engine")).toMatchObject({ status: "warning", fix: { kind: "settings", section: "engines" } });
  });
  it("accepts a ready custom API engine without requiring a local CLI", async () => {
    const deps = healthy(); deps.engines = async () => [{ snapshot: { state: "available" }, access: "custom" }];
    expect(await check(deps, "engine")).toMatchObject({ status: "ok" });
    expect(await check(deps, "cli")).toMatchObject({ status: "ok", detail: "No local CLI is required for your configured engines." });
  });
  it("reports missing CLI, unbound port, low disk and missing push honestly", async () => {
    const deps = healthy(); deps.engines = async () => [{ snapshot: { state: "unavailable" }, cliDefault: "claude", cliCandidates: [] }];
    deps.server = () => ({ listening: false, port: 12345 }); deps.freeBytes = async () => 100; deps.pushConfigured = () => false;
    const { checks } = await createDoctor(deps).check();
    for (const id of ["cli", "server", "disk", "push"]) expect(checks.find(row => row.id === id)?.status).not.toBe("ok");
    expect(checks.find(row => row.id === "push")?.detail).toContain("Push is not set up");
  });
  it("isolates failed probes and never leaks raw errors", async () => {
    const deps = healthy(); deps.engines = async () => { throw new Error("token=private"); }; deps.freeBytes = async () => { throw new Error("/private/path"); };
    const result = await createDoctor(deps).check();
    expect(result.checks.find(row => row.id === "engine")?.status).toBe("unavailable");
    expect(result.checks.find(row => row.id === "disk")?.status).toBe("unavailable");
    expect(result.checks.find(row => row.id === "push")?.status).toBe("ok");
    expect(JSON.stringify(result)).not.toMatch(/private|token=/);
  });
  it("offers reconnect only for a saved disconnected WhatsApp session and rechecks after fixing", async () => {
    const deps = healthy(); let state = "disconnected";
    deps.whatsapp = () => ({ enabled: true, state, sessionExists: true });
    deps.reconnectWhatsApp = vi.fn(async () => { state = "linked"; });
    const doctor = createDoctor(deps);
    expect((await doctor.check()).checks.find(row => row.id === "whatsapp")).toMatchObject({ fix: { kind: "action", action: "reconnect-whatsapp" } });
    expect((await doctor.fix("reconnect-whatsapp")).checks.find(row => row.id === "whatsapp")?.status).toBe("ok");
    expect(deps.reconnectWhatsApp).toHaveBeenCalledOnce();
    await expect(doctor.fix("delete-data")).rejects.toThrow("Unknown health action");
  });
  it("does not reconnect a missing or rescan-required WhatsApp session", async () => {
    const deps = healthy(); deps.whatsapp = () => ({ enabled: true, state: "needs_rescan", sessionExists: true }); deps.reconnectWhatsApp = vi.fn();
    const doctor = createDoctor(deps);
    expect(await check(deps, "whatsapp")).toMatchObject({ fix: { kind: "settings", section: "connections" } });
    await expect(doctor.fix("reconnect-whatsapp")).rejects.toThrow("Link WhatsApp");
    expect(deps.reconnectWhatsApp).not.toHaveBeenCalled();
  });
  it("shows update failures and distinguishes unavailable desktop state", async () => {
    const deps = healthy(); deps.update = async () => ({ state: "failed:network" });
    expect(await check(deps, "update")).toMatchObject({ status: "warning", fix: { section: "updates" } });
    deps.update = async () => null;
    expect(await check(deps, "update")).toMatchObject({ status: "unavailable" });
  });
  it("bounds a stalled engine probe and still reports the other checks", async () => {
    vi.useFakeTimers();
    try {
      const deps = healthy(); deps.engines = () => new Promise(() => {});
      const pending = createDoctor(deps).check();
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;
      expect(result.checks.find(row => row.id === "engine")?.status).toBe("unavailable");
      expect(result.checks.find(row => row.id === "push")?.status).toBe("ok");
    } finally { vi.useRealTimers(); }
  });
  it("includes recovery and safe-mode notices without running any repairs", async () => {
    const deps = healthy(); deps.notices = () => [{ id: "n1", collection: "bots.json", status: "read-only", detail: "Bots are read-only.", at: 1 }]; deps.safeMode = () => ({ enabled: true, reason: "Server could not start normally." });
    expect(await createDoctor(deps).check()).toMatchObject({ notices: [{ id: "n1" }], safeMode: { enabled: true } });
  });
});
