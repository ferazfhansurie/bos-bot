import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonical, parseChallenge } from "./remote-full-protocol.mjs";

/** Only Electron main calls this. Dependencies expose neither signing nor
 * account credentials to remote content. Key lifetime is one confirmation. */
export async function confirmRemoteFull({ environment, targets, request, ownerSignIn, authorize, confirm, stillCurrent, pinEnvironment = async () => {}, now = Date.now }) {
  if (!environment || !environment.origin.startsWith("https://") || !stillCurrent()) throw new Error("Select a paired HTTPS server first");
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8 || targets.some(t => !t || typeof t.botId !== "string" || !/^[\w-]{1,128}$/.test(t.botId) || typeof t.threadId !== "string" || !/^[\w-]{1,128}$/.test(t.threadId) || typeof t.updateBotDefault !== "boolean" || Object.keys(t).sort().join() !== "botId,threadId,updateBotDefault")) throw new Error("Invalid targets");
  // Sign-in first: OTP delivery must not consume the two-minute grant window.
  const account = await ownerSignIn(environment);
  try {
    if (!stillCurrent()) throw new Error("Workspace changed");
    const { challenge: raw, serverSignature } = await request("prepare", targets);
    const challenge = parseChallenge(raw);
    if (typeof serverSignature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(serverSignature) || !verify(null, Buffer.from(canonical(challenge)),
      createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: challenge.serverKey } }), Buffer.from(serverSignature, "base64url"))) throw new Error("Server signature mismatch");
    if (challenge.audience !== environment.origin || challenge.environmentId !== environment.environmentId || challenge.expiresAt <= now() || challenge.expiresAt > now() + 120_000 ||
      canonical(challenge.operations.map(({ botId, threadId, updateBotDefault }) => ({ botId, threadId, updateBotDefault }))) !== canonical(targets)) throw new Error("Server identity or targets changed");
    const detail = [`Server: ${environment.origin}`, `Environment: ${challenge.environmentId}`, `Installation: ${challenge.installationId}`, `Server public key: ${challenge.serverKey}`, `Owner account: ${account.user.email}`,
      ...challenge.operations.map(op => `\n${op.name} [${op.botId}]\nTask: ${op.title} [${op.threadId}]\nProvider: ${op.modelSelection.instanceId} / ${op.modelSelection.model} / ${op.modelSelection.effort ?? "default effort"} / ${op.modelSelection.variant ?? "default variant"}\nFull access: ${op.updateBotDefault ? "bot default AND this task" : "this task only"}`),
      "\nThis installation must already have a verified ownership binding to this exact server. Full access allows these tasks to run tools without individual approval. This does not start or resume tasks. Other existing tasks keep their current access."].join("\n");
    if (!stillCurrent() || !(await confirm(detail)) || !stillCurrent()) throw new Error("Confirmation cancelled or workspace changed");
    if (challenge.expiresAt <= now()) throw new Error("Confirmation expired");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = publicKey.export({ format: "jwk" }).x;
    await authorize(account.accountToken, { installationId: challenge.installationId, nonce: challenge.nonce, signer, challenge });
    if (!stillCurrent() || challenge.expiresAt <= now()) throw new Error("Workspace changed or confirmation expired");
    await pinEnvironment(challenge.environmentId);
    if (!stillCurrent()) throw new Error("Workspace changed");
    const signature = sign(null, Buffer.from(canonical(challenge)), privateKey).toString("base64url");
    try { return await request("commit", { challenge, signature }); }
    catch (error) {
      // A lost response must not trigger a second elevation attempt.
      const receipt = await request("receipt", { challenge }).catch(() => null);
      if (receipt?.applied) return receipt;
      throw error;
    }
  } finally { await account.close?.(); }
}
