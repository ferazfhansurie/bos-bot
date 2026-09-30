import { createPublicKey, verify } from "node:crypto";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { requireInstallation } from "./installations";
import { HTTPError, json, readBoundedJSON } from "./http";
import { canonical, parseChallenge } from "../../../electron/remote-full-protocol.mjs";
import { z } from "zod";

const reference = z.object({ installationId: z.string().uuid(), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const approve = reference.extend({ challenge: z.unknown(), signer: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const bindingProbe = z.object({ protocol: z.literal("bos.remote-full.status.v1"), installationId: z.string().uuid(),
  environmentId: z.string().uuid(), serverKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  audience: z.string().url(), nonce: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int() }).strict();
const activeBindingSQL = `SELECT 1 FROM remote_full_bindings b JOIN installations i ON i.id = b.installation_id
  JOIN installation_credentials c ON c.installation_id = i.id
  WHERE b.installation_id = ? AND b.environment_id = ? AND b.server_key = ? AND b.audience = ?
  AND b.explicitly_enrolled = 1 AND b.owner_user_id = i.owner_user_id AND i.revoked_at IS NULL
  AND c.lookup_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?`;
export async function remoteFull(request: Request, env: Env, auth: ControlPlaneAuth, action: string): Promise<Response> {
  const now = Date.now();
  const body = await readBoundedJSON(request);
  if (action === "enroll") {
    // A separate, explicit owner enrollment ceremony, never a side effect of
    // grant authorization. Both the verified human account and the exact
    // server-held installation credential/key must be present.
    const session = await accountSession(request, auth);
    if (!session?.user.emailVerified) throw new HTTPError(401, "unauthorized");
    const p = z.object({ binding: z.object({ protocol: z.literal("bos.remote-full.enroll.v1"),
      installationId: z.string().uuid(), environmentId: z.string().uuid(),
      audience: z.string().url().refine(v => { try { return new URL(v).origin === v && v.startsWith("https://"); } catch { return false; } }),
      serverKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int(),
      ownerUserId: z.string().min(1).max(256), confirmation: z.literal("enroll-this-server") }).strict(),
      serverSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().safeParse(body);
    if (!p.success) throw new HTTPError(400, "invalid_request");
    const b = p.data.binding;
    const credential = request.headers.get("x-installation-credential");
    const installation = await requireInstallation(new Request(request.url, { headers: { authorization: `Bearer ${credential ?? ""}` } }), env);
    if (b.installationId !== installation.installation_id || b.ownerUserId !== session.user.id || b.expiresAt <= now || b.expiresAt > now + 120_000) throw new HTTPError(403, "forbidden");
    try {
      if (!verify(null, Buffer.from(canonical(b)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: b.serverKey } }), Buffer.from(p.data.serverSignature, "base64url"))) throw new Error("signature");
    } catch { throw new HTTPError(403, "forbidden"); }
    // Unique installation AND environment constraints serialize concurrent
    // enrollment. Bindings remain tombstones after revocation; no transfer API.
    await env.DB.prepare(`INSERT INTO remote_full_bindings (installation_id, environment_id, server_key, audience, owner_user_id, confirmed_at, explicitly_enrolled)
      SELECT ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM installations i JOIN installation_credentials c ON c.installation_id = i.id
        WHERE i.id = ? AND i.owner_user_id = ? AND i.revoked_at IS NULL AND c.lookup_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?)
      AND EXISTS (SELECT 1 FROM remote_full_enrollment_permits p WHERE p.environment_id = ? AND p.installation_id = ? AND p.owner_user_id = ? AND p.server_key = ? AND p.audience = ? AND p.expires_at > ?)
      ON CONFLICT DO NOTHING`).bind(b.installationId, b.environmentId, b.serverKey, b.audience, session.user.id, now,
        b.installationId, session.user.id, installation.lookup_id, now, b.environmentId, b.installationId, session.user.id, b.serverKey, b.audience, now).run();
    // Upgrade a legacy binding only for its exact unchanged scope and an
    // operator permit. Old implicit first-confirmation bindings confer no Full.
    await env.DB.prepare(`UPDATE remote_full_bindings SET explicitly_enrolled = 1 WHERE installation_id = ? AND environment_id = ? AND server_key = ? AND audience = ? AND owner_user_id = ?
      AND EXISTS (SELECT 1 FROM remote_full_enrollment_permits p JOIN installations i ON i.id = p.installation_id
        JOIN installation_credentials c ON c.installation_id = i.id
        WHERE p.installation_id = remote_full_bindings.installation_id AND p.environment_id = remote_full_bindings.environment_id
        AND p.server_key = remote_full_bindings.server_key AND p.audience = remote_full_bindings.audience AND p.owner_user_id = remote_full_bindings.owner_user_id AND p.expires_at > ?
        AND i.owner_user_id = p.owner_user_id AND i.revoked_at IS NULL AND c.lookup_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?)`)
      .bind(b.installationId, b.environmentId, b.serverKey, b.audience, session.user.id, now, installation.lookup_id, now).run();
    const bound = await env.DB.prepare(`SELECT 1 FROM remote_full_bindings b JOIN installations i ON i.id = b.installation_id
      JOIN installation_credentials c ON c.installation_id = i.id WHERE b.installation_id = ? AND b.environment_id = ? AND b.server_key = ? AND b.audience = ? AND b.owner_user_id = ?
      AND b.explicitly_enrolled = 1 AND i.owner_user_id = b.owner_user_id AND i.revoked_at IS NULL AND c.lookup_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?`)
      .bind(b.installationId, b.environmentId, b.serverKey, b.audience, session.user.id, installation.lookup_id, now).first();
    if (!bound) throw new HTTPError(409, "owner_binding_conflict");
    return json({ enrolled: true });
  }
  if (action === "status") {
    const installation = await requireInstallation(request, env);
    const p = z.object({ probe: bindingProbe, serverSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().safeParse(body);
    if (!p.success) throw new HTTPError(400, "invalid_request");
    const probe = p.data.probe;
    if (probe.installationId !== installation.installation_id || probe.expiresAt <= now || probe.expiresAt > now + 120_000) throw new HTTPError(403, "forbidden");
    try {
      if (!verify(null, Buffer.from(canonical(probe)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: probe.serverKey } }), Buffer.from(p.data.serverSignature, "base64url"))) throw new Error("signature");
    } catch { throw new HTTPError(403, "forbidden"); }
    const ready = await env.DB.prepare(activeBindingSQL).bind(probe.installationId, probe.environmentId, probe.serverKey, probe.audience, installation.lookup_id, now).first();
    // Echo the fresh signed probe; never expose owner identity or credentials.
    return json({ enrolled: Boolean(ready), probe });
  }
  if (action === "prepare") {
    const installation = await requireInstallation(request, env);
    let challenge;
    try {
      const input = z.object({ challenge: z.unknown(), serverSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().parse(body);
      challenge = parseChallenge(input.challenge);
      if (!verify(null, Buffer.from(canonical(challenge)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: challenge.serverKey } }), Buffer.from(input.serverSignature, "base64url"))) throw new Error("invalid server signature");
    } catch { throw new HTTPError(400, "invalid_request"); }
    if (challenge.installationId !== installation.installation_id || challenge.expiresAt <= now || challenge.expiresAt > now + 120_000) throw new HTTPError(403, "forbidden");
    const bindingArgs = [challenge.installationId, challenge.environmentId, challenge.serverKey, challenge.audience, installation.lookup_id, now];
    if (!await env.DB.prepare(activeBindingSQL).bind(...bindingArgs).first()) throw new HTTPError(403, "owner_enrollment_required");
    // Bound outstanding work per installation, including a compromised paired client.
    await env.DB.prepare("DELETE FROM remote_full_challenges WHERE expires_at < ?").bind(now - 120_000).run();
    const inserted = await env.DB.prepare(`INSERT INTO remote_full_challenges (installation_id, nonce, challenge, expires_at, credential_lookup)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (${activeBindingSQL}) AND (SELECT COUNT(*) FROM remote_full_challenges WHERE installation_id = ? AND expires_at > ?) < 16
      ON CONFLICT(installation_id, nonce) DO NOTHING`).bind(installation.installation_id, challenge.nonce, canonical(challenge), challenge.expiresAt, installation.lookup_id, ...bindingArgs, installation.installation_id, now).run();
    if (inserted.meta.changes !== 1) throw new HTTPError(409, "challenge_conflict");
    return json({ prepared: true, state: "verified" });
  }
  if (action === "authorize") {
    const session = await accountSession(request, auth);
    if (!session || !session.user.emailVerified) throw new HTTPError(401, "unauthorized");
    const p = approve.safeParse(body);
    if (!p.success) throw new HTTPError(400, "invalid_request");
    let challenge;
    try { challenge = parseChallenge(p.data.challenge); } catch { throw new HTTPError(400, "invalid_request"); }
    if (challenge.installationId !== p.data.installationId || challenge.nonce !== p.data.nonce) throw new HTTPError(400, "invalid_request");
    const result = await env.DB.prepare(`UPDATE remote_full_challenges SET signer = ?, owner_user_id = ?
        WHERE installation_id = ? AND nonce = ? AND challenge = ? AND expires_at > ? AND signer IS NULL
        AND EXISTS (SELECT 1 FROM installations i JOIN installation_credentials c ON c.installation_id = i.id
          WHERE i.id = remote_full_challenges.installation_id AND i.owner_user_id = ? AND i.revoked_at IS NULL
          AND c.lookup_id = remote_full_challenges.credential_lookup AND c.revoked_at IS NULL AND c.expires_at > ?)
        AND EXISTS (SELECT 1 FROM remote_full_bindings WHERE installation_id = remote_full_challenges.installation_id AND environment_id = ? AND server_key = ? AND audience = ? AND owner_user_id = ? AND explicitly_enrolled = 1)`)
        .bind(p.data.signer, session.user.id, p.data.installationId, p.data.nonce, canonical(challenge), now, session.user.id, now, challenge.environmentId, challenge.serverKey, challenge.audience, session.user.id).run();
    if (result.meta.changes !== 1) throw new HTTPError(403, "owner_confirmation_required");
    return json({ authorized: true });
  }
  if (action === "verify") {
    const installation = await requireInstallation(request, env);
    const p = reference.safeParse(body);
    if (!p.success || p.data.installationId !== installation.installation_id) throw new HTTPError(403, "forbidden");
    const row = await env.DB.prepare(`SELECT c.challenge, c.signer, c.owner_user_id FROM remote_full_challenges c JOIN installations i ON i.id = c.installation_id
      JOIN installation_credentials proof ON proof.lookup_id = c.credential_lookup AND proof.installation_id = i.id AND proof.revoked_at IS NULL AND proof.expires_at > ?
      JOIN remote_full_bindings b ON b.installation_id = c.installation_id AND b.owner_user_id = c.owner_user_id AND b.explicitly_enrolled = 1
      WHERE c.installation_id = ? AND c.nonce = ? AND c.expires_at > ? AND c.signer IS NOT NULL AND c.credential_lookup = ? AND c.owner_user_id = i.owner_user_id AND i.revoked_at IS NULL`)
      .bind(now, installation.installation_id, p.data.nonce, now, installation.lookup_id).first<{ challenge: string; signer: string; owner_user_id: string }>();
    if (!row) throw new HTTPError(403, "owner_confirmation_required");
    return json({ challenge: JSON.parse(row.challenge), signer: row.signer, ownerUserId: row.owner_user_id });
  }
  throw new HTTPError(404, "not_found");
}
