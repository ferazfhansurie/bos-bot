import { createPublicKey, verify } from "node:crypto";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { requireInstallation } from "./installations";
import { HTTPError, json, readBoundedJSON } from "./http";
import { canonical, parseChallenge } from "../../../electron/remote-full-protocol.mjs";
import { z } from "zod";

const reference = z.object({ installationId: z.string().uuid(), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const approve = reference.extend({ challenge: z.unknown(), signer: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export async function remoteFull(request: Request, env: Env, auth: ControlPlaneAuth, action: string): Promise<Response> {
  const now = Date.now();
  const body = await readBoundedJSON(request);
  if (action === "prepare") {
    const installation = await requireInstallation(request, env);
    let challenge;
    try {
      const input = z.object({ challenge: z.unknown(), serverSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().parse(body);
      challenge = parseChallenge(input.challenge);
      if (!verify(null, Buffer.from(canonical(challenge)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: challenge.serverKey } }), Buffer.from(input.serverSignature, "base64url"))) throw new Error("invalid server signature");
    } catch { throw new HTTPError(400, "invalid_request"); }
    if (challenge.installationId !== installation.installation_id || challenge.expiresAt <= now || challenge.expiresAt > now + 120_000) throw new HTTPError(403, "forbidden");
    // Bound outstanding work per installation, including a compromised paired client.
    await env.DB.prepare("DELETE FROM remote_full_challenges WHERE expires_at < ?").bind(now - 120_000).run();
    const inserted = await env.DB.prepare(`INSERT INTO remote_full_challenges (installation_id, nonce, challenge, expires_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM remote_full_challenges WHERE installation_id = ? AND expires_at > ?) < 16
      ON CONFLICT(installation_id, nonce) DO NOTHING`).bind(installation.installation_id, challenge.nonce, canonical(challenge), challenge.expiresAt, installation.installation_id, now).run();
    if (inserted.meta.changes !== 1) throw new HTTPError(409, "challenge_conflict");
    return json({ prepared: true });
  }
  if (action === "authorize") {
    const session = await accountSession(request, auth);
    if (!session || !session.user.emailVerified) throw new HTTPError(401, "unauthorized");
    const p = approve.safeParse(body);
    if (!p.success) throw new HTTPError(400, "invalid_request");
    let challenge;
    try { challenge = parseChallenge(p.data.challenge); } catch { throw new HTTPError(400, "invalid_request"); }
    if (challenge.installationId !== p.data.installationId || challenge.nonce !== p.data.nonce) throw new HTTPError(400, "invalid_request");
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO remote_full_bindings (installation_id, environment_id, server_key, audience, owner_user_id, confirmed_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM remote_full_challenges c JOIN installations i ON i.id = c.installation_id
          WHERE c.installation_id = ? AND c.nonce = ? AND c.challenge = ? AND c.expires_at > ? AND c.signer IS NULL AND i.owner_user_id = ? AND i.revoked_at IS NULL)
        ON CONFLICT(installation_id) DO NOTHING`).bind(challenge.installationId, challenge.environmentId, challenge.serverKey, challenge.audience, session.user.id, now,
          challenge.installationId, challenge.nonce, canonical(challenge), now, session.user.id),
      env.DB.prepare(`UPDATE remote_full_challenges SET signer = ?, owner_user_id = ?
        WHERE installation_id = ? AND nonce = ? AND challenge = ? AND expires_at > ? AND signer IS NULL
        AND EXISTS (SELECT 1 FROM installations WHERE id = remote_full_challenges.installation_id AND owner_user_id = ? AND revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM remote_full_bindings WHERE installation_id = remote_full_challenges.installation_id AND environment_id = ? AND server_key = ? AND audience = ? AND owner_user_id = ?)`)
        .bind(p.data.signer, session.user.id, p.data.installationId, p.data.nonce, canonical(challenge), now, session.user.id, challenge.environmentId, challenge.serverKey, challenge.audience, session.user.id),
    ]);
    const result = results[1];
    if (result.meta.changes !== 1) throw new HTTPError(403, "owner_confirmation_required");
    return json({ authorized: true });
  }
  if (action === "verify") {
    const installation = await requireInstallation(request, env);
    const p = reference.safeParse(body);
    if (!p.success || p.data.installationId !== installation.installation_id) throw new HTTPError(403, "forbidden");
    const row = await env.DB.prepare(`SELECT c.challenge, c.signer, c.owner_user_id FROM remote_full_challenges c JOIN installations i ON i.id = c.installation_id
      JOIN remote_full_bindings b ON b.installation_id = c.installation_id AND b.owner_user_id = c.owner_user_id
      WHERE c.installation_id = ? AND c.nonce = ? AND c.expires_at > ? AND c.signer IS NOT NULL AND c.owner_user_id = i.owner_user_id AND i.revoked_at IS NULL`)
      .bind(installation.installation_id, p.data.nonce, now).first<{ challenge: string; signer: string; owner_user_id: string }>();
    if (!row) throw new HTTPError(403, "owner_confirmation_required");
    return json({ challenge: JSON.parse(row.challenge), signer: row.signer, ownerUserId: row.owner_user_id });
  }
  throw new HTTPError(404, "not_found");
}
