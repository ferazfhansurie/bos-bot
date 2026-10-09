import { generateKeyPairSync, sign } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonical } from "../electron/remote-full-protocol.mjs";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { RemoteFullService, remoteFullAuthorityOrigin, type RemoteFullEnrollment } from "./remote-full.ts";
import { approvalModeFor } from "../shared/approval-mode.ts";

const serverKeys = generateKeyPairSync("ed25519");
const enrollment: RemoteFullEnrollment = { environmentId: "00000000-0000-4000-8000-000000000001", installationId: "c67e2828-a514-4a46-9db9-07c28bce104a", audience: "https://fixture.invalid", privateKey: serverKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), credential: "fixture-only-not-a-live-credential" };
const keys = generateKeyPairSync("ed25519");
const signer = keys.publicKey.export({ format: "jwk" }).x!;
function fixture() {
  const store = new Store(() => ({ instanceId: "codex", model: "fixture-sol" }));
  const a = store.createBot({ name: "Sol" }, { seedMessages: false }), b = store.createBot({ name: "Opus" }, { seedMessages: false });
  const sibling = store.createTask(a.id, "Keep Ask", false)!;
  delete sibling.approvalMode; delete sibling.modelSelection;
  let now = 10_000, valid = true, owner = true, enrolled: RemoteFullEnrollment | null = enrollment, busy = false, providerRevision = "initial";
  let challenge: any;
  const authority = vi.fn(async (action, body, _credential: string) => {
    if (!owner) throw new Error("revoked owner");
    if (action === "status") return { enrolled: true, probe: body.probe };
    if (action === "prepare") { challenge = structuredClone(body.challenge); return { prepared: true, state: "verified" }; }
    return { challenge, signer, ownerUserId: "verified-owner" };
  });
  const service = new RemoteFullService({ store, enrollment: () => enrolled, supported: () => true, providerRevision: () => providerRevision, busy: () => busy, sessionValid: id => valid && id === "paired", now: () => now, authority });
  const targets = [a, b].map(bot => ({ botId: bot.id, threadId: bot.threadId, updateBotDefault: true }));
  const prepare = async () => (await service.prepare("paired", targets)).challenge;
  const signed = (c: any) => ({ challenge: c, signature: sign(null, Buffer.from(canonical(c)), keys.privateKey).toString("base64url") });
  return { store, a, b, sibling, service, targets, prepare, signed, authority, set: (p: { now?: number; valid?: boolean; owner?: boolean; busy?: boolean; providerRevision?: string; enrolled?: RemoteFullEnrollment | null }) => {
    providerRevision = p.providerRevision ?? providerRevision; now = p.now ?? now; valid = p.valid ?? valid; owner = p.owner ?? owner; busy = p.busy ?? busy; if ("enrolled" in p) enrolled = p.enrolled!;
  } };
}
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
describe("remote Full owner grants", () => {
  it("atomically applies two defaults and selected tasks; preserves inherited sibling Ask and restart receipts", async () => {
    const f = fixture(), c = await f.prepare();
    expect((await f.service.commit("paired", f.signed(c))).applied).toBe(true);
    for (const b of [f.a, f.b]) { expect(approvalModeFor(b)).toBe("full"); expect(approvalModeFor(f.store.projectBotForTask(b.id, b.threadId)!)).toBe("full"); }
    expect(approvalModeFor(f.store.projectBotForTask(f.a.id, f.sibling.threadId)!)).toBe("ask");
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(disk.filter((b: any) => b.lastRemoteFullReceipt?.nonce === c.nonce)).toHaveLength(2);
    expect(f.service.receipt("paired", { challenge: c }).applied).toBe(true);
    await expect(f.service.commit("paired", f.signed(c))).rejects.toThrow();
    const reload = new Store(() => ({ instanceId: "codex", model: "fixture" }));
    expect(reload.bot(f.a.id)?.lastRemoteFullReceipt?.nonce).toBe(c.nonce);
  });
  it.each(["expiry", "session", "revocation", "busy", "model", "task", "bot", "environment", "signature", "owner", "aba", "provider"])("fails closed for %s", async reason => {
    const f = fixture(), c = await f.prepare(); let input = f.signed(c);
    if (reason === "expiry") f.set({ now: c.expiresAt });
    if (reason === "session") f.set({ valid: false });
    if (reason === "revocation") f.set({ owner: false });
    if (reason === "busy") f.set({ busy: true });
    if (reason === "provider") f.set({ providerRevision: "replacement-home" });
    if (reason === "model") f.store.patchTask(f.a.id, f.a.threadId, { modelSelection: { instanceId: "codex", model: "other" } });
    if (reason === "task") input = f.signed({ ...c, operations: [{ ...c.operations[0], threadId: f.sibling.threadId }, c.operations[1]] });
    if (reason === "bot") input = f.signed({ ...c, operations: [{ ...c.operations[0], botId: "other" }, c.operations[1]] });
    if (reason === "environment") input = f.signed({ ...c, environmentId: "other" });
    if (reason === "signature") input.signature = "A".repeat(86);
    if (reason === "owner") f.authority.mockImplementation(async () => ({ challenge: c, signer: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, ownerUserId: "wrong" }));
    if (reason === "aba") { f.store.patchTask(f.a.id, f.a.threadId, { approvalMode: "auto" }); f.store.patchTask(f.a.id, f.a.threadId, { approvalMode: "ask" }); }
    await expect(f.service.commit("paired", input)).rejects.toThrow();
    expect(approvalModeFor(f.b)).toBe("ask"); expect(approvalModeFor(f.a)).toBe("ask");
  });
  it("missing enrollment, duplicate targets and forged session cannot prepare", async () => {
    const f = fixture();
    await expect(f.service.prepare("loopback", f.targets)).rejects.toThrow();
    await expect(f.service.prepare("paired", [f.targets[0], f.targets[0]])).rejects.toThrow();
    f.set({ enrolled: null }); await expect(f.prepare()).rejects.toThrow();
  });
  it("persistence failure publishes neither target and cannot replay", async () => {
    const f = fixture(), c = await f.prepare();
    vi.spyOn(f.store as any, "saveBots").mockImplementation(() => { throw new Error("disk failure"); });
    await expect(f.service.commit("paired", f.signed(c))).rejects.toThrow("disk failure");
    expect(approvalModeFor(f.a)).toBe("ask"); expect(approvalModeFor(f.b)).toBe("ask");
    expect(f.service.receipt("paired", { challenge: c }).applied).toBe(false);
  });
  it("rechecks state and session after awaiting authority and rejects concurrent commits", async () => {
    const f = fixture(), c = await f.prepare(); let release!: () => void;
    f.authority.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { challenge: c, signer, ownerUserId: "owner" }; });
    const first = f.service.commit("paired", f.signed(c));
    await expect(f.service.commit("paired", f.signed(c))).rejects.toThrow();
    f.set({ valid: false }); release(); await expect(first).rejects.toThrow();
    expect(approvalModeFor(f.a)).toBe("ask");
  });
});

describe("online enrollment readiness", () => {
  it("missing local identity is not ready and makes no authority request", async () => {
    const f = fixture(); f.set({ enrolled: null });
    expect(await f.service.status("paired")).toEqual({ enrolled: false, state: "missing" }); expect(f.authority).not.toHaveBeenCalled();
  });
  it.each(["pending", "rejected", "lost-reply", "revoked", "unavailable", "conflict", "stale-response"])("local credentials alone do not enable status or prepare: %s", async reason => {
    const f = fixture();
    f.authority.mockImplementation(async (action, body) => {
      if (["revoked", "unavailable", "lost-reply"].includes(reason)) throw new Error(reason);
      if (action === "status") return { enrolled: reason === "stale-response", probe: reason === "stale-response" ? { ...body.probe, nonce: "old" } : body.probe };
      return { prepared: false, state: "pending" };
    });
    expect((await f.service.status("paired")).enrolled).toBe(false);
    await expect(f.prepare()).rejects.toThrow(); expect(approvalModeFor(f.a)).toBe("ask");
  });
  it("old authority prepare acknowledgements without verified binding are rejected", async () => {
    const f = fixture(); f.authority.mockResolvedValue({ prepared: true } as any); await expect(f.prepare()).rejects.toThrow();
  });
  it("successful exact retry transitions pending to verified without changing the local credential", async () => {
    const f = fixture(); let registered = false;
    f.authority.mockImplementation(async (action, body, credential) => {
      expect(credential).toBe(enrollment.credential);
      if (action === "status") return { enrolled: registered, probe: body.probe };
      return { prepared: registered, state: registered ? "verified" : "pending" };
    });
    expect(await f.service.status("paired")).toEqual({ enrolled: false, state: "pending" }); await expect(f.prepare()).rejects.toThrow();
    registered = true;
    expect(await f.service.status("paired")).toEqual({ enrolled: true, state: "verified" }); await expect(f.prepare()).resolves.toBeTruthy();
    registered = false; expect((await f.service.status("paired")).enrolled).toBe(false); await expect(f.prepare()).rejects.toThrow();
  });
  it.each(["credential", "session", "expiry"])("late readiness is discarded after %s changes", async reason => {
    const f = fixture(); let release!: () => void;
    f.authority.mockImplementation(async (_action, body) => { await new Promise<void>(r => { release = r; }); return { enrolled: true, probe: body.probe }; });
    const pending = f.service.status("paired");
    if (reason === "credential") f.set({ enrolled: { ...enrollment, credential: "replacement" } });
    if (reason === "session") f.set({ valid: false });
    if (reason === "expiry") f.set({ now: 200_000 });
    release(); expect(await pending).toEqual({ enrolled: false, state: "unavailable" });
  });
  it("a lost enrollment response is resolved only by fresh authority proof, never a local success flag", async () => {
    const f = fixture(); const first = await f.service.status("paired"); expect(first.state).toBe("verified");
    f.authority.mockRejectedValue(new Error("offline")); expect((await f.service.status("paired")).enrolled).toBe(false);
    await expect(f.prepare()).rejects.toThrow();
  });
});

describe("owner authority configuration", () => {
  it("has no hosted default and only uses BOS_CONTROL_PLANE_URL / OMB_CONTROL_PLANE_URL", () => {
    expect(remoteFullAuthorityOrigin({})).toBe("");
    expect(remoteFullAuthorityOrigin({ BOS_CONTROL_PLANE_URL: "https://accounts.example.com/" })).toBe("https://accounts.example.com");
    expect(remoteFullAuthorityOrigin({ OMB_CONTROL_PLANE_URL: "https://legacy.example.com" })).toBe("https://legacy.example.com");
  });
  it("reports not configured and never fetches when no authority is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const store = new Store(() => ({ instanceId: "codex", model: "fixture-sol" }));
      const bot = store.createBot({ name: "Sol" }, { seedMessages: false });
      const service = new RemoteFullService({ store, enrollment: () => enrollment, supported: () => true, providerRevision: () => "r", busy: () => false, sessionValid: id => id === "paired", authorityOrigin: () => "" });
      expect(service.configured()).toBe(false);
      expect(await service.status("paired")).toEqual({ enrolled: false, state: "unavailable", error: "remote sign-in not configured" });
      await expect(service.prepare("paired", [{ botId: bot.id, threadId: bot.threadId, updateBotDefault: true }])).rejects.toThrow(/not configured/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it("sends authority requests to the configured origin", async () => {
    const urls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => { urls.push(String(url)); return Response.json({}, { status: 500 }); });
    try {
      const store = new Store(() => ({ instanceId: "codex", model: "fixture-sol" }));
      const service = new RemoteFullService({ store, enrollment: () => enrollment, supported: () => true, providerRevision: () => "r", busy: () => false, sessionValid: () => true, authorityOrigin: () => "https://authority.example" });
      expect((await service.status("paired")).state).toBe("unavailable");
      expect(urls).toEqual(["https://authority.example/v1/remote-full/status"]);
    } finally { fetchSpy.mockRestore(); }
  });
});
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
