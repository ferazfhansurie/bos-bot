import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { confirmRemoteFull } from "./remote-full-client.mjs";
import { canonical } from "./remote-full-protocol.mjs";
function fixture() {
  const environment = { id: "local-bookmark", environmentId: "server-env", origin: "https://fixture.invalid" };
  const targets = [{ botId: "sol", threadId: "task", updateBotDefault: true }];
  const serverKeys = generateKeyPairSync("ed25519");
  const challenge = { protocol: "bos.remote-full.v1", nonce: "a".repeat(64), environmentId: environment.environmentId, installationId: "install", serverKey: serverKeys.publicKey.export({ format: "jwk" }).x, audience: environment.origin,
    expiresAt: 100000, operations: [{ ...targets[0], mode: "full", name: "Sol", title: "Exact task", modelSelection: { instanceId: "codex", model: "fixture", effort: undefined }, revision: "b".repeat(64) }] };
  const calls = []; let signer;
  const options = { environment, targets, now: () => 0, stillCurrent: () => true,
    ownerSignIn: async () => ({ accountToken: "test-only", user: { email: "owner@fixture.invalid" } }),
    confirm: async detail => { assert.match(detail, /bot default AND this task/); return true; },
    authorize: async (_token, body) => { calls.push("authorize"); signer = body.signer; },
    request: async (action, body) => { calls.push(action); if (action === "prepare") return JSON.parse(JSON.stringify({ challenge, serverSignature: sign(null, Buffer.from(canonical(challenge)), serverKeys.privateKey).toString("base64url") }));
      if (action === "commit") { assert.ok(verify(null, Buffer.from(canonical(challenge)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signer }, format: "jwk" }), Buffer.from(body.signature, "base64url"))); return { applied: true }; }
    } };
  return { options, challenge, calls };
}
test("native confirmation signs only exact challenge after owner authorization", async () => { const f = fixture(); assert.equal((await confirmRemoteFull(f.options)).applied, true); assert.deepEqual(f.calls, ["prepare", "authorize", "commit"]); });
for (const fault of ["cancel", "origin", "environment", "targets", "expiry", "navigation", "owner"]) test(`rejects ${fault} without submitting a grant`, async () => {
  const f = fixture();
  if (fault === "cancel") f.options.confirm = async () => false;
  if (fault === "origin") f.challenge.audience = "https://attacker.invalid";
  if (fault === "environment") f.challenge.environmentId = "other";
  if (fault === "targets") f.challenge.operations[0].threadId = "other";
  if (fault === "expiry") f.challenge.expiresAt = 0;
  if (fault === "navigation") { let active = true; f.options.stillCurrent = () => active; f.options.confirm = async () => { active = false; return true; }; }
  if (fault === "owner") f.options.authorize = async () => { throw new Error("wrong owner"); };
  await assert.rejects(confirmRemoteFull(f.options)); assert.ok(!f.calls.includes("commit"));
});
test("lost response reads receipt without replaying commit", async () => { const f = fixture(); const request = f.options.request;
  f.options.request = async (a,b) => { if (a === "commit") { f.calls.push(a); throw new Error("lost"); } if (a === "receipt") { f.calls.push(a); return { applied: true }; } return request(a,b); };
  assert.equal((await confirmRemoteFull(f.options)).applied,true); assert.deepEqual(f.calls,["prepare","authorize","commit","receipt"]);
});


test("owner session is closed on both cancellation and success", async () => {
  for (const allow of [false, true]) { const f = fixture(); let closed = 0;
    f.options.ownerSignIn = async () => ({ accountToken: "temporary", user: { email: "fixture@example.invalid" }, close: async () => { closed++; } });
    f.options.confirm = async () => allow;
    await confirmRemoteFull(f.options).catch(() => {}); assert.equal(closed, 1);
  }
});
