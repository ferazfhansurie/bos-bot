import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modManifest, modBundle, bridgeRequest } from "../shared/mods.ts";
import { ModStore, ModBridge } from "./mods.ts";
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "bos-mods-test-")); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const manifest = { id: "today", name: "Today", version: "1.0.0", description: "Today at a glance", surfaces: ["chip"], permissions: ["threads:read"] };
const bundle = { manifest, files: { "index.html": "<p>today</p>" } };
describe("mod validation", () => {
  it("accepts the four surfaces and rejects unknown fields, permissions and traversal", () => {
    expect(modManifest.parse(manifest).id).toBe("today");
    for (const patch of [{ id: "../escape" }, { permissions: ["filesystem"] }, { surfaces: ["hook"] }, { token: "secret" }, { surfaces: [] }, { permissions: ["storage", "storage"] }]) expect(modManifest.safeParse({ ...manifest, ...patch }).success).toBe(false);
    expect(modBundle.safeParse({ ...bundle, files: { "../evil": "x", "index.html": "x" } }).success).toBe(false);
  });
  it("strictly validates bridge operations", () => {
    expect(bridgeRequest.safeParse({ id: "1", method: "threads:read", params: {} }).success).toBe(true);
    for (const request of [{ id: "1", method: "fetch", params: {} }, { id: "1", method: "storage:get", params: { key: "../x" } }, { id: "1", method: "bots:ask", params: { prompt: "hi", botId: "other" } }]) expect(bridgeRequest.safeParse(request).success).toBe(false);
  });
});
describe("mod store and bridge", () => {
  it("defaults off, persists toggles, and safe mode overrides enabled", () => {
    const dir = temp(); let safe = false; const store = new ModStore(dir, () => safe);
    expect(store.save(bundle, "bot").enabled).toBe(false);
    store.enable("today", true); expect(new ModStore(dir).get("today").enabled).toBe(true);
    safe = true; expect(store.list()[0].enabled).toBe(false); expect(() => store.active("today", "bot")).toThrow();
    safe = false; store.enable("today", false); expect(() => store.active("today", "bot")).toThrow();
  });
  it("updates revoke enablement, refuses cross-bot access and keeps storage scoped", async () => {
    const store = new ModStore(temp()); store.save({ ...bundle, manifest: { ...manifest, permissions: ["storage"] } }, "bot"); store.enable("today", true);
    const bridge = new ModBridge(store, { threads: () => [], ask: async () => "ok", app: async () => "ok" });
    await bridge.call("today", "bot", { id: "1", method: "storage:set", params: { key: "count", value: 4 } });
    expect(await bridge.call("today", "bot", { id: "2", method: "storage:get", params: { key: "count" } })).toBe(4);
    await expect(bridge.call("today", "other", { id: "3", method: "storage:get", params: { key: "count" } })).rejects.toThrow();
    await expect(bridge.call("today", "bot", { id: "4", method: "threads:read", params: {} })).rejects.toThrow(/permission/i);
    store.save(bundle, "bot"); expect(store.get("today").enabled).toBe(false);
  });
  it("keeps storage across a save, ignores crash-left temp files and reserves the import id", () => {
    const dir = temp(); const store = new ModStore(dir);
    store.save({ ...bundle, manifest: { ...manifest, permissions: ["storage"] } }, "bot");
    store.storage("today", "count", 4, true);
    store.save({ ...bundle, manifest: { ...manifest, permissions: ["storage"] }, files: { "index.html": "<p>v2</p>" } }, "bot");
    expect(store.storage("today", "count")).toBe(4);
    writeFileSync(join(dir, "mods", "today", ".state-leftover"), "{}");
    writeFileSync(join(dir, "mods", "today", ".storage-leftover"), "{}");
    expect(store.list().map(mod => mod.manifest.id)).toEqual(["today"]);
    expect(modManifest.safeParse({ ...manifest, id: "import" }).success).toBe(false);
  });
  it("rejects symlinks and never reads or writes outside the mods directory", () => {
    const store = new ModStore(temp()); const outside = temp(); store.save(bundle, "bot");
    rmSync(join(store.root, "today", "index.html")); writeFileSync(join(outside, "secret"), "secret");
    symlinkSync(join(outside, "secret"), join(store.root, "today", "index.html"));
    expect(() => store.get("today")).toThrow(); expect(() => store.save(bundle, "other")).toThrow();
  });
  it("limits calls, times out, and withholds results after disable", async () => {
    const store = new ModStore(temp()); store.save(bundle, "bot"); store.enable("today", true);
    const bridge = new ModBridge(store, { threads: () => [], ask: async () => "ok", app: async () => "ok" }, { maxCalls: 1, timeoutMs: 15 });
    await bridge.call("today", "bot", { id: "1", method: "threads:read", params: {} });
    await expect(bridge.call("today", "bot", { id: "2", method: "threads:read", params: {} })).rejects.toThrow(/too many/i);
    store.save({ ...bundle, manifest: { ...manifest, permissions: ["bots:ask"] } }, "bot"); store.enable("today", true);
    const slow = new ModBridge(store, { threads: () => [], ask: async () => new Promise(() => {}), app: async () => "ok" }, { timeoutMs: 15 });
    await expect(slow.call("today", "bot", { id: "3", method: "bots:ask", params: { prompt: "hello" } })).rejects.toThrow(/timed out/i);
    const revoke = new ModBridge(store, { threads: () => { store.enable("today", false); return []; }, ask: async () => "ok", app: async () => "ok" });
    await expect(revoke.call("today", "bot", { id: "4", method: "bots:ask", params: { prompt: "hi" } })).resolves.toBe("ok");
    store.save(bundle, "bot"); store.enable("today", true);
    await expect(revoke.call("today", "bot", { id: "5", method: "threads:read", params: {} })).rejects.toThrow();
  });
});
it.each(["disable", "safe-mode", "session"])("%s revocation aborts in-flight work before it can continue", async mode => {
  let safe = false; let live = true;
  const store = new ModStore(temp(), () => safe); store.save({ ...bundle, manifest: { ...manifest, permissions: ["bots:ask"] } }, "bot"); store.enable("today", true);
  let aborted = false;
  const bridge = new ModBridge(store, { threads: () => [], ask: async (_bot, _prompt, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }); }), app: async () => "ok" });
  const pending = bridge.call("today", "bot", { id: "r1", method: "bots:ask", params: { prompt: "test" } }, () => { if (!live) throw new Error("session ended"); });
  if (mode === "disable") store.enable("today", false);
  if (mode === "safe-mode") safe = true;
  if (mode === "session") live = false;
  await expect(pending).rejects.toThrow(/access ended/); expect(aborted).toBe(true);
});
