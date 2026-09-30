import { generateKeyPairSync, sign } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonical } from "../electron/remote-full-protocol.mjs";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { RemoteFullService, type RemoteFullEnrollment } from "./remote-full.ts";
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
  const authority = vi.fn(async (action, body) => {
    if (!owner) throw new Error("revoked owner");
    if (action === "prepare") { challenge = structuredClone(body.challenge); return {}; }
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
