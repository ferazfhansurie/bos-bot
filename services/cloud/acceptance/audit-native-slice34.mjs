import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digest, loadManifest } from './oracle.mjs';
import { SCENARIOS } from './slice34-plan.mjs';
import { verifyScenario } from './slice34-verifier.mjs';
import { verifyArtifact } from './run-slice34.mjs';
const evidence = resolve(process.argv[2]);
const read = name => JSON.parse(readFileSync(evidence + '/' + name, 'utf8'));
const summary = read('summary.json');
assert.equal(summary.status, 'passed');
const raw = readFileSync(evidence + '/raw.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const source = loadManifest(evidence + '/two-human-native.sources.manifest.json');
const wire = loadManifest(evidence + '/two-human-native.wire.manifest.json');
assert.equal(source.candidate, summary.candidate); assert.equal(wire.candidate, summary.candidate);
const identities = new Map(raw.filter(e => e.type === 'real_issuer_identity').map(e => ['fictional-' + e.label, e.identity.account_id]));
const intents = source.intents.map(({ id, envelope, expected }) => ({ id, envelope, expected }));
for (const result of summary.results) {
  const spec = SCENARIOS.find(s => s.name === result.name); assert.ok(spec);
  const matches = raw.filter(e => e.type === 'scenario_observation' && e.observation.name === result.name);
  assert.equal(matches.length, 1);
  const o = matches[0].observation;
  verifyScenario(spec, o, intents);
  for (const a of Object.values(o.artifacts)) verifyArtifact(a, evidence);
  for (const key of spec.evidence) for (const a of o.evidence[key]) verifyArtifact(a, evidence);
  verifyArtifact(o.native_run_artifact, evidence);
  const durable = JSON.parse(readFileSync(o.native_run_artifact.path, 'utf8'));
  assert.equal(durable.settled.length, 2); assert.equal(durable.controlEvents.length, 0);
  for (const row of durable.settled) {
    assert.ok(durable.sends.some(s => s.message_id === row.source_message_id));
    assert.equal(BigInt(row.control_revision), 0n);
    assert.equal(row.state, 'completed');
  }
  for (const t of o.native.triggers) {
    verifyArtifact(t.provider_transcript_artifact, evidence);
    const provider = JSON.parse(readFileSync(t.provider_transcript_artifact.path, 'utf8'));
    const input = provider.events.filter(e => e.type === 'provider_input'); assert.equal(input.length, 1);
    const expected = source.intents.find(s => s.id === t.source_intent_id);
    const w = wire.intents.find(s => s.id === t.source_intent_id);
    assert.equal(input[0].text, expected.envelope.text); assert.equal(input[0].text, w.envelope.text);
    assert.deepEqual(provider.invocation.source.mentions, w.envelope.mentions);
    assert.equal(provider.invocation.source.actor_id, identities.get(t.actor_alias));
    const { digest: sourceDigest, ...actualSource } = provider.invocation.source;
    assert.equal(sourceDigest, digest(actualSource));
    assert.equal(provider.ingress, w.envelope.text);
    assert.equal(input[0].sharedContext.mode, 'conversation-only');
    assert.ok(!input[0].integrations && !input[0].resumeCursor);
    const native = provider.events.filter(e => e.type === 'session.started'); assert.equal(native.length, 1);
    assert.equal(native[0].model, expected.envelope.pinned_model.model);
    assert.equal(native[0].model, t.provider_receipt.actual_model);
    assert.equal(provider.events.filter(e => e.type === 'turn.completed' && e.ok).length, 1);
    for (const v of t.recipient_views) {
      assert.equal(v.websocket_receipt.payload.invocation_id, t.invocation_id);
      assert.deepEqual(v.websocket_receipt.payload.message, v.final);
      assert.deepEqual(v.final.mentions, []);
    }
  }
}
const providerInputs = raw.filter(e => e.type === 'native_provider' && e.event.type === 'provider_input');
assert.equal(providerInputs.length, 2, 'exactly two provider submissions');
assert.equal(new Set(providerInputs.map(e => e.invocation_id)).size, 2);
assert.equal(summary.native_data_removed, true);
const cleanup = raw.filter(e => e.type === 'ws_close'); assert.equal(cleanup.length, 2);
console.log(JSON.stringify({ candidate: summary.candidate, gates: summary.results.map(r => r.name), provider_submissions: providerInputs.length, recipients_per_trigger: 2, evidence_reverified: true }));
