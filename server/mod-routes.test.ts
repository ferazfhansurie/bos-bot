import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModStore, ModBridge } from "./mods.ts";
import { handleModRoute } from "./mod-routes.ts";
import { modsSuspended } from "./mod-safe-mode.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const bundle = { manifest: { id: "leads", name: "Leads", version: "1.0.0", description: "Today's leads", surfaces: ["panel"], permissions: [] }, files: { "index.html": "<p>Leads unavailable</p>" } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bos-mod-api-")); dirs.push(dir);
  const store = new ModStore(dir); const bridge = new ModBridge(store, { threads: () => [], ask: async () => "ok", app: async () => "ok" });
  let output: { status: number; body: any };
  const run = async (method: string, path: string, body: unknown = {}, extra: Record<string, unknown> = {}) => {
    await handleModRoute(method, path, { store, bridge, assertAccess: () => {}, readBody: async () => body, json: (status, body) => { output = { status, body }; }, download: (_name, data) => { output = { status: 200, body: JSON.parse(data) }; }, botExists: id => id === "bot", ...extra });
    return output!;
  };
  return { dir, store, run };
}
it("round trips the make-mod format, enable/disable, export/import and delete", async () => {
  const { run } = fixture();
  expect((await run("PUT", "/api/mods/leads", { bundle, botId: "bot" })).body.mod.enabled).toBe(false);
  expect((await run("POST", "/api/mods/leads/enabled", { enabled: true, revision: (await run("GET", "/api/mods/leads")).body.mod.revision })).body.mod.enabled).toBe(true);
  expect((await run("GET", "/api/mods")).body.mods).toHaveLength(1);
  const exported = (await run("GET", "/api/mods/leads/export")).body; expect(exported).toEqual(bundle);
  expect((await run("DELETE", "/api/mods/leads")).status).toBe(200);
  expect((await run("POST", "/api/mods/import", { bundle: exported, botId: "bot" })).body.mod.enabled).toBe(false);
});
it("checks authority again after body read and refuses URL mismatches without a write", async () => {
  const { run, store } = fixture();
  expect((await run("PUT", "/api/mods/wrong", { bundle, botId: "bot" })).status).toBe(400); expect(store.list()).toHaveLength(0);
  let checks = 0;
  expect((await run("PUT", "/api/mods/leads", { bundle, botId: "bot" }, { assertAccess: () => { if (++checks > 1) throw Object.assign(new Error("session ended"), { status: 401 }); } })).status).toBe(401);
  expect(store.list()).toHaveLength(0);
});
it("bot capabilities cannot enable mods or access a different bot's files", async () => {
  const { run, store } = fixture();
  await run("PUT", "/api/internal/mods/leads", { bundle }, { botId: "bot" });
  expect(store.get("leads").botId).toBe("bot");
  expect((await run("POST", "/api/internal/mods/leads/enabled", { enabled: true }, { botId: "bot" })).status).toBe(403);
  expect((await run("GET", "/api/internal/mods/leads", {}, { botId: "other" })).status).toBe(403);
  expect((await run("DELETE", "/api/internal/mods/leads", {}, { botId: "other" })).status).toBe(403);
});
it("safe mode and the remote flag both fail closed", () => {
  const { dir } = fixture(); expect(modsSuspended(dir)).toBe(true);
  writeFileSync(join(dir, "app-config.json"), JSON.stringify({ flags: { mods: true } })); expect(modsSuspended(dir)).toBe(false);
  const old = process.env.BOS_SAFE_MODE; process.env.BOS_SAFE_MODE = "1";
  try { expect(modsSuspended(dir)).toBe(true); } finally { if (old === undefined) delete process.env.BOS_SAFE_MODE; else process.env.BOS_SAFE_MODE = old; }
  writeFileSync(join(dir, "app-config.json"), "{"); expect(modsSuspended(dir)).toBe(true);
});

it("enabling requires the exact permissions revision the owner reviewed", async () => {
  const { run } = fixture();
  const reviewed = (await run("PUT", "/api/mods/leads", { bundle, botId: "bot" })).body.mod;
  await run("PUT", "/api/mods/leads", { bundle: { ...bundle, manifest: { ...bundle.manifest, permissions: ["threads:read"] } }, botId: "bot" });
  expect((await run("POST", "/api/mods/leads/enabled", { enabled: true, revision: reviewed.revision })).status).toBe(409);
  expect((await run("GET", "/api/mods/leads")).body.mod.enabled).toBe(false);
});
