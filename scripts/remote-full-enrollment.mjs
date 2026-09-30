import { createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { canonical } from "../electron/remote-full-protocol.mjs";

/** Explicit local owner ceremony. No discovery, adoption, credential rotation,
 * grant or task dispatch. persist must atomically save with private permissions. */
export async function enrollRemoteFullOwner({ client, account, previous, environmentId, audience, platform, confirm, persist, reviewScope = async () => {} }) {
  if (previous && (previous.environmentId !== environmentId || previous.audience !== audience || !previous.credential || !previous.privateKey))
    throw new Error("Existing enrollment does not match this server; no change made");
  let enrollment = previous;
  if (previous) {
    const installation = await client.inspectInstallation(previous.credential);
    if (installation.id !== previous.installationId) throw new Error("Installation credential mismatch; no change made");
    // Account list is used only to verify ownership of the credential-proven
    // installation. It is never a selection or recovery menu.
    const owned = await client.listInstallations(account.accountToken);
    if (!owned.some(item => item.id === installation.id)) throw new Error("Different installation owner; no change made");
  }
  const statement = `ENROLL ${environmentId} ${audience} AS ${account.user.email}`;
  if (await confirm({ statement, isNew: !previous, installationId: previous?.installationId }) !== statement) throw new Error("Cancelled");
  if (!previous) {
    // Random enrollment-specific identity, not a selectable existing record or
    // an environment ID which account recovery might silently rotate.
    const clientInstanceId = `remote-full-${randomUUID()}`;
    const created = await client.createNewInstallation({ accountToken: account.accountToken, clientInstanceId,
      name: new URL(audience).hostname, platform, appVersion: "remote-full-v1" });
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    enrollment = { privateKey, environmentId, installationId: created.installation.id, audience, credential: created.credential };
    // Keep a pending enrollment durable BEFORE registration. Failure/lost reply
    // retries with this exact credential/key; no credential rotation or new ID.
    await persist(enrollment);
  }
  const binding = { protocol: "bos.remote-full.enroll.v1", environmentId, audience, installationId: enrollment.installationId,
    serverKey: createPublicKey(enrollment.privateKey).export({ format: "jwk" }).x,
    ownerUserId: account.user.id, expiresAt: Date.now() + 120_000, confirmation: "enroll-this-server" };
  // Public-only scope for a separately reviewed CP permit. Never print or
  // export installation credentials, private keys, OTP or account sessions.
  await reviewScope({ environmentId, audience, installationId: enrollment.installationId, serverKey: binding.serverKey, ownerUserId: account.user.id });
  await client.enrollRemoteFull(account.accountToken, enrollment.credential, {
    binding, serverSignature: sign(null, Buffer.from(canonical(binding)), enrollment.privateKey).toString("base64url"),
  });
  return enrollment;
}
