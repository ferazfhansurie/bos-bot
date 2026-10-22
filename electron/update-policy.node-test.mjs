import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMinimumVersion, fetchUpdatePolicy, belowMinimumVersion, updateTelemetryState, persistUpdateState } from "./update-policy.mjs";

test("minimum gate compares semantic versions and ignores invalid/missing config", () => {
  for (const [current, min, expected] of [
    ["2.1.2", "2.1.3", true], ["2.1.3", "2.1.3", false], ["2.10.0", "2.9.0", false],
    ["2.1.3-beta.1", "2.1.3", true], ["2.1.3+commit", "2.1.3", false],
    ["2.1.2", undefined, false], ["2.1.2", "broken", false], ["unknown", "2.1.3", false],
  ]) assert.equal(belowMinimumVersion(current, min), expected, `${current} < ${min}`);
});

test("minimum config is bounded, optional and offline-safe", async () => {
  const good = await fetchMinimumVersion(async (url, opts) => {
    assert.equal(url, "https://bosbot.my/api/app-config");
    assert.equal(opts.redirect, "error");
    assert.ok(opts.signal);
    return new Response(JSON.stringify({ minVersion: { desktop: "2.1.3" } }));
  });
  assert.equal(good, "2.1.3");
  for (const request of [async () => { throw new Error("offline"); }, async () => new Response("{}"),
    async () => new Response("bad"), async () => new Response('"' + 'x'.repeat(100_000) + '"'),
    async () => new Response('{"minVersion":{"desktop":"2.1.3"}}', {status: 503})]) {
    assert.equal(await fetchMinimumVersion(request), null);
  }
});

test("telemetry emits bounded classes without raw error content and writes atomically", () => {
  assert.equal(updateTelemetryState({status: "error", message: "ENOTFOUND secret.example"}), "failed:network");
  assert.equal(updateTelemetryState({status: "error", message: "sha512 mismatch secret"}), "failed:verification");
  assert.equal(updateTelemetryState({status: "preparing"}), "downloading");
  assert.equal(updateTelemetryState({status: "downloaded"}), "downloaded");
  const dir = mkdtempSync(join(tmpdir(), "bos-update-state-"));
  try {
    persistUpdateState(dir, {status: "error", message: "404 secret-token"});
    const raw = readFileSync(join(dir, "update-state.json"), "utf8");
    assert.equal(JSON.parse(raw).update_state, "failed:feed");
    assert.ok(!raw.includes("secret"));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("ordinary automatic updates require the explicit remote rollout flag", async () => {
  for (const [value, expected] of [[true,true],[false,false],["true",false],[undefined,false]]) {
    const policy = await fetchUpdatePolicy(async () => new Response(JSON.stringify({minVersion:{desktop:"2.1.3"}, flags:{autoUpdates:value}})));
    assert.deepEqual(policy,{minimumVersion:"2.1.3",autoUpdates:expected});
  }
});
