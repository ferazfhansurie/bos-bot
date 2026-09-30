import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { enrollRemoteFullOwner } from "./remote-full-enrollment.mjs";
import { canonical } from "../electron/remote-full-protocol.mjs";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
const environmentId = "00000000-0000-4000-8000-000000000001", installationId = "00000000-0000-4000-8000-000000000002";
const account = { accountToken: "synthetic-account", user: { id: "owner", email: "owner@example.invalid" } };
const previous = { environmentId, audience: "https://fixture.invalid", installationId, credential: "synthetic-credential",
  privateKey: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) };
function fixture(overrides = {}) {
  const calls = []; let saved; let publicScope;
  const client = { inspectInstallation: async () => ({ id: installationId }), listInstallations: async () => [{ id: installationId }],
    createNewInstallation: async body => { calls.push(["create", body]); return { installation: { id: installationId }, credential: "new-secret" }; },
    enrollRemoteFull: async (token, credential, { binding, serverSignature }) => {
      calls.push(["enroll", binding]); assert.equal(token, account.accountToken);
      assert.equal(verify(null, Buffer.from(canonical(binding)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: binding.serverKey } }), Buffer.from(serverSignature, "base64url")), true);
    }, ...overrides };
  const options = { client, account, environmentId, audience: previous.audience, platform: "windows", confirm: async ({ statement }) => statement,
    persist: async value => { calls.push(["persist"]); saved = structuredClone(value); }, reviewScope: async scope => { publicScope = scope; } };
  return { calls, client, options, saved: () => saved, scope: () => publicScope };
}
test("new ceremony creates separate identity without listing/selecting/rotating unrelated installations", async () => {
  const f = fixture({ listInstallations: () => { throw new Error("must not discover or select"); }, ensureInstallation: () => { throw new Error("must not recover"); } });
  await enrollRemoteFullOwner(f.options);
  assert.deepEqual(f.calls.map(c => c[0]), ["create", "persist", "enroll"]);
  assert.match(f.calls[0][1].clientInstanceId, /^remote-full-[a-f0-9-]{36}$/);
  assert.equal(f.scope().ownerUserId, "owner");
  for (const key of ["credential", "privateKey", "accountToken"]) assert.equal(key in f.scope(), false);
});
test("arbitrary installation ID is not an accepted human enrollment confirmation", async () => {
  const f = fixture(); await assert.rejects(enrollRemoteFullOwner({ ...f.options, confirm: async () => installationId }), /Cancelled/);
  assert.deepEqual(f.calls, []);
});
test("existing proof is reused unchanged and cannot silently rotate", async () => {
  const f = fixture(); const result = await enrollRemoteFullOwner({ ...f.options, previous });
  assert.equal(result, previous); assert.deepEqual(f.calls.map(c => c[0]), ["enroll"]); assert.equal(f.saved(), undefined);
});
for (const error of ["revoked credential", "replaced credential", "network failure"]) test(`${error} fails closed without recovery`, async () => {
  const f = fixture({ inspectInstallation: async () => { throw new Error(error); } });
  await assert.rejects(enrollRemoteFullOwner({ ...f.options, previous }), new RegExp(error)); assert.deepEqual(f.calls, []);
});
test("different owner or credential installation cannot be adopted", async () => {
  for (const override of [{ listInstallations: async () => [{ id: "unrelated" }] }, { inspectInstallation: async () => ({ id: "unrelated" }) }]) {
    const f = fixture(override); await assert.rejects(enrollRemoteFullOwner({ ...f.options, previous })); assert.deepEqual(f.calls, []);
  }
});
test("existing registration failure retains every old credential byte", async () => {
  const before = JSON.stringify(previous); const f = fixture({ enrollRemoteFull: async () => { throw new Error("missing permit"); } });
  await assert.rejects(enrollRemoteFullOwner({ ...f.options, previous }), /missing permit/);
  assert.equal(JSON.stringify(previous), before); assert.equal(f.saved(), undefined); assert.deepEqual(f.calls, []);
});
test("failed or lost first registration retains pending credentials for exact retry", async () => {
  const f = fixture({ enrollRemoteFull: async () => { throw new Error("lost reply"); } });
  await assert.rejects(enrollRemoteFullOwner(f.options), /lost reply/);
  const pending = f.saved(); assert.ok(pending.credential); const g = fixture();
  const result = await enrollRemoteFullOwner({ ...g.options, previous: pending });
  assert.deepEqual(result, pending); assert.deepEqual(g.calls.map(c => c[0]), ["enroll"]);
});
test("failed durable save cannot register ownership", async () => {
  const f = fixture(); await assert.rejects(enrollRemoteFullOwner({ ...f.options, persist: async () => { throw new Error("disk full"); } }), /disk full/);
  assert.deepEqual(f.calls.map(c => c[0]), ["create"]);
});
test("new client creation conflict never retries through rotation or account recovery", async () => {
  const paths = []; const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl: async url => {
    paths.push(new URL(url).pathname); return new Response(JSON.stringify({ error: "installation_exists" }), { status: 409 });
  } });
  await assert.rejects(client.createNewInstallation({ accountToken: "synthetic", clientInstanceId: "new", name: "test", platform: "windows" }));
  assert.deepEqual(paths, ["/v1/installations"]);
});
