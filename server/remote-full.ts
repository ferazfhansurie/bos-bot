import { compatEnv } from "../electron/branding-env.cjs";
import { createHash, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonical, parseChallenge, REMOTE_FULL_PROTOCOL, type RemoteFullChallenge, type RemoteFullOperation } from "../electron/remote-full-protocol.mjs";
import { approvalModeFor } from "../shared/approval-mode.ts";
import { resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
import type { Store } from "./store.ts";

/** The owner authority is the control plane: accounts.bosbot.my unless
 * BOS_CONTROL_PLANE_URL (or legacy OMB_CONTROL_PLANE_URL) says otherwise. Set
 * empty, Remote Full is "not configured" and no authority request is made. */
export function remoteFullAuthorityOrigin(env: NodeJS.ProcessEnv = compatEnv): string {
  return resolveCompanionControlPlaneURL({ environment: env });
}
export const REMOTE_FULL_NOT_CONFIGURED = "remote sign-in not configured";
const enrollmentSchema = z.object({ environmentId: z.string().uuid(), installationId: z.string().uuid(), audience: z.string().url(), privateKey: z.string().min(32).max(4096), credential: z.string().regex(/^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/) }).strict();
export type RemoteFullEnrollment = z.infer<typeof enrollmentSchema>;
// Reads only a pending identity candidate. Readiness always requires online CP proof.
export function readRemoteFullEnrollment(dataDir: string, environmentId: string): RemoteFullEnrollment | null {
  try {
    const e = enrollmentSchema.parse(JSON.parse(readFileSync(join(dataDir, ".remote-full", "owner.json"), "utf8")));
    if (e.environmentId !== environmentId || new URL(e.audience).origin !== e.audience || !e.audience.startsWith("https://")) return null;
    if (createPublicKey(e.privateKey).asymmetricKeyType !== "ed25519") return null;
    return e;
  } catch { return null; }
}
const targets = z.array(z.object({ botId: z.string().min(1).max(128), threadId: z.string().min(1).max(128), updateBotDefault: z.boolean() }).strict()).min(1).max(8);
const submission = z.object({ challenge: z.unknown(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
type Options = { store: Store; enrollment: () => RemoteFullEnrollment | null;
  supported: (instanceId: string) => boolean; providerRevision: (instanceId: string) => string; busy: (botId: string, threadId: string) => boolean;
  sessionValid: (id: string) => boolean; now?: () => number;
  authority?: (action: string, body: unknown, credential: string) => Promise<any>;
  /** Defaults to remoteFullAuthorityOrigin(); "" disables the authority. */
  authorityOrigin?: () => string };

/** The ordinary session is transport, never elevation authority. Every commit
 * needs a native signature AND a fresh installation-owner decision from CP. */
export class RemoteFullService {
  private pending = new Map<string, { challenge: RemoteFullChallenge; sessionId: string; revisions: number[]; committing: boolean }>();
  private versions = new Map<string, number>();
  private now: () => number;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    options.store.onChange(change => {
      if ("botId" in change) this.versions.set(change.botId, (this.versions.get(change.botId) ?? 0) + 1);
    });
  }
  private async authority(action: string, body: unknown, credential: string) {
    if (this.options.authority) return this.options.authority(action, body, credential);
    const origin = this.authorityOrigin();
    if (!origin) throw new Error(REMOTE_FULL_NOT_CONFIGURED);
    const response = await fetch(`${origin}/v1/remote-full/${action}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("Verified installation owner confirmation required");
    return response.json();
  }
  private authorityOrigin(): string {
    return this.options.authorityOrigin ? this.options.authorityOrigin() : remoteFullAuthorityOrigin();
  }
  /** False when no owner authority is configured, so nothing can be verified. */
  configured(): boolean {
    return Boolean(this.options.authority) || Boolean(this.authorityOrigin());
  }
  async status(sessionId: string): Promise<{ enrolled: boolean; state: "missing" | "pending" | "verified" | "unavailable"; error?: string }> {
    if (!this.options.sessionValid(sessionId)) throw new Error("Paired session required");
    if (!this.configured()) return { enrolled: false, state: "unavailable", error: REMOTE_FULL_NOT_CONFIGURED };
    const enrollment = this.options.enrollment();
    if (!enrollment) return { enrolled: false, state: "missing" };
    try {
      const probe = { protocol: "bos.remote-full.status.v1", installationId: enrollment.installationId,
        environmentId: enrollment.environmentId, audience: enrollment.audience,
        serverKey: createPublicKey(enrollment.privateKey).export({ format: "jwk" }).x!, nonce: randomBytes(32).toString("hex"), expiresAt: this.now() + 120_000 };
      const serverSignature = sign(null, Buffer.from(canonical(probe)), enrollment.privateKey).toString("base64url");
      const proof = await this.authority("status", { probe, serverSignature }, enrollment.credential);
      if (!this.options.sessionValid(sessionId) || this.now() >= probe.expiresAt || canonical(this.options.enrollment()) !== canonical(enrollment) ||
          !proof || canonical(proof.probe) !== canonical(probe) || typeof proof.enrolled !== "boolean") throw new Error("Stale readiness response");
      return proof.enrolled ? { enrolled: true, state: "verified" } : { enrolled: false, state: "pending" };
    } catch { return { enrolled: false, state: "unavailable" }; }
  }
  private operation(target: { botId: string; threadId: string; updateBotDefault: boolean }): RemoteFullOperation {
    const { store, supported, busy } = this.options;
    const bot = store.bot(target.botId), task = store.taskByThread(target.botId, target.threadId);
    const effective = store.projectBotForTask(target.botId, target.threadId);
    if (!bot || !task || !effective || bot.remote || bot.approvalGrant || bot.busy || bot.tasks?.some(t => t.busy) || busy(bot.id, task.threadId)) throw new Error("Approval target missing or busy");
    if (!supported(effective.modelSelection.instanceId) || (target.updateBotDefault && canonical(bot.modelSelection) !== canonical(effective.modelSelection))) throw new Error("Default and selected task must use the same supported model");
    const state = { providerRevision: this.options.providerRevision(effective.modelSelection.instanceId), default: bot.modelSelection, selected: effective.modelSelection, botMode: approvalModeFor(bot), taskMode: approvalModeFor(effective),
      computer: bot.computer ?? null, taskComputer: effective.computer ?? null, allows: bot.alwaysAllow ?? [], taskAllows: effective.alwaysAllow ?? [], name: bot.name, title: task.title };
    return { ...target, mode: "full", name: bot.name, title: task.title || "Untitled task", modelSelection: structuredClone(effective.modelSelection), revision: hash(state) };
  }
  async prepare(sessionId: string, raw: unknown) {
    const enrollment = this.options.enrollment();
    if (!enrollment || !this.options.sessionValid(sessionId)) throw new Error("Owner enrollment and paired session required");
    if (!this.configured()) throw new Error(REMOTE_FULL_NOT_CONFIGURED);
    for (const [id, p] of this.pending) if (p.challenge.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 64 || [...this.pending.values()].filter(p => p.sessionId === sessionId).length >= 8) throw new Error("Too many pending confirmations");
    const operations = targets.parse(raw).map(target => this.operation(target));
    const challenge = parseChallenge({ protocol: REMOTE_FULL_PROTOCOL, nonce: randomBytes(32).toString("hex"), environmentId: enrollment.environmentId,
      installationId: enrollment.installationId, serverKey: createPublicKey(enrollment.privateKey).export({ format: "jwk" }).x!, audience: enrollment.audience, expiresAt: this.now() + 120_000, operations });
    const pending = { challenge, sessionId, revisions: operations.map(op => this.versions.get(op.botId) ?? 0), committing: false };
    // Reserve before awaiting: concurrent prepares remain bounded.
    this.pending.set(challenge.nonce, pending);
    const serverSignature = sign(null, Buffer.from(canonical(challenge)), enrollment.privateKey).toString("base64url");
    try {
      const proof = await this.authority("prepare", { challenge, serverSignature }, enrollment.credential);
      if (proof?.prepared !== true || proof.state !== "verified" || !this.options.sessionValid(sessionId) || this.now() >= challenge.expiresAt || canonical(this.options.enrollment()) !== canonical(enrollment)) throw new Error("Verified owner enrollment required");
    }
    catch (error) { this.pending.delete(challenge.nonce); throw error; }
    return { challenge, serverSignature };
  }
  receipt(sessionId: string, raw: unknown) {
    if (!this.options.sessionValid(sessionId)) throw new Error("Paired session required");
    const challenge = parseChallenge(z.object({ challenge: z.unknown() }).strict().parse(raw).challenge);
    const digest = hash(challenge);
    const enrollment = this.options.enrollment();
    const applied = challenge.environmentId === enrollment?.environmentId && challenge.installationId === enrollment?.installationId && challenge.audience === enrollment?.audience && challenge.serverKey === createPublicKey(enrollment!.privateKey).export({ format: "jwk" }).x && challenge.operations.every(op => {
      const receipt = this.options.store.bot(op.botId)?.lastRemoteFullReceipt;
      return receipt?.nonce === challenge.nonce && receipt.digest === digest;
    });
    return { applied, nonce: challenge.nonce, botIds: challenge.operations.map(op => op.botId) };
  }
  async commit(sessionId: string, raw: unknown) {
    const input = submission.parse(raw), challenge = parseChallenge(input.challenge);
    const enrollment = this.options.enrollment();
    const pending = this.pending.get(challenge.nonce);
    if (!enrollment || !pending || pending.committing || pending.sessionId !== sessionId || canonical(pending.challenge) !== canonical(challenge) ||
        challenge.expiresAt <= this.now() || challenge.environmentId !== enrollment.environmentId || challenge.installationId !== enrollment.installationId || challenge.audience !== enrollment.audience || challenge.serverKey !== createPublicKey(enrollment.privateKey).export({ format: "jwk" }).x) throw new Error("Stale or mismatched confirmation");
    pending.committing = true;
    try {
      const proof = await this.authority("verify", { installationId: challenge.installationId, nonce: challenge.nonce }, enrollment.credential);
      if (!proof || canonical(proof.challenge) !== canonical(challenge) || typeof proof.ownerUserId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof.signer)) throw new Error("Owner authority mismatch");
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: proof.signer }, format: "jwk" });
      if (!verify(null, Buffer.from(canonical(challenge)), key, Buffer.from(input.signature, "base64url"))) throw new Error("Invalid owner signature");
      if (!this.options.sessionValid(sessionId) || challenge.expiresAt <= this.now()) throw new Error("Session or challenge expired");
      for (const [i, op] of challenge.operations.entries()) {
        if ((this.versions.get(op.botId) ?? 0) !== pending.revisions[i] || canonical(this.operation(op)) !== canonical(op)) throw new Error("Target changed; confirm again");
      }
      const receipt = { nonce: challenge.nonce, digest: hash(challenge), ownerUserId: proof.ownerUserId, at: this.now() };
      // No await between last validation and the single durable configuration write.
      this.options.store.applyRemoteFull(challenge.operations, receipt);
      return { applied: true, nonce: receipt.nonce, botIds: challenge.operations.map(op => op.botId) };
    } finally { this.pending.delete(challenge.nonce); }
  }
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
