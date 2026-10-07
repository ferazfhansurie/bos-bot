import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { plan, recoveryOperations, SCENARIOS, FAULTS } from './slice34-plan.mjs';
import { verifyNative, verifyRace, verifyRecovery, verifyScenario } from './slice34-verifier.mjs';
import { digest, loadManifest } from './oracle.mjs';
import { prepare, verifyArtifact } from './run-slice34.mjs';

const native = () => ({ triggers: ['fictional-alice', 'fictional-bob'].map((actor_alias, i) => {
  const source = { room_id: 'fictional-room', actor_alias, text: `fictional trigger ${i}`, pinned_model: 'fixture-test-model' };
  return { actor_alias, source_intent_id: `test-source-${i}`, invocation_id: `inv-${i}`, source, ingress_digest: digest(source), provider_input_digest: digest(source),
    actual_model: 'fixture-test-model', pinned_model: 'fixture-test-model', provider_receipt: 'fixture-test-receipt', host_build: 'fixture-test-build',
    provider_transcript_artifact: 'fixture-test-only', final_room_id: source.room_id, canonical_finals: [{ text: `final-${i}` }],
    private_task_count: 0, recipient_views: [{ final: { text: `final-${i}` } }, { final: { text: `final-${i}` } }] };
}) });
const nativeIntents = () => native().triggers.map(t => ({ id: t.source_intent_id, envelope: t.source }));
test('coverage includes every requested gate and exact frozen wire names', () => {
  const p = plan();
  assert.deepEqual([...new Set(p.scenarios.map(s => s.requirement))].sort(), ['a02','a03','a04','a05','a06','a07','a08','a13','a14','a15','a16','a17','a19','a20']);
  assert.equal(p.races.length, 8); assert.ok(p.races.every(r => r.repetitions === 100));
  assert.equal(p.recovery.length, 1000); assert.equal(p.product_status, 'unrun');
  assert.deepEqual([...new Set(p.recovery.map(o => o.fault))], FAULTS);
  assert.throws(() => recoveryOperations(999));
});
test('prepare freezes private unique manifests, never reports product pass', () => {
  const root = mkdtempSync(tmpdir() + '/slice34-selftest-');
  try {
    prepare(root + '/evidence', { candidate: 'fixture-unit', schema: 'fixture-unit' });
    const m = loadManifest(root + '/evidence/recovery-intents.manifest.json');
    assert.equal(m.intents.length, 1000); assert.equal(new Set(m.intents.map(o => o.id)).size, 1000);
    assert.equal(JSON.parse(readFileSync(root + '/evidence/schedule.json')).product_status, 'unrun');
    assert.throws(() => prepare(root + '/evidence', { candidate: 'fixture-unit', schema: 'fixture-unit' }));
  } finally { rmSync(root, { recursive: true }); }
});
test('native gate rejects changed source, wrong model, duplicate final, missing recipient', () => {
  verifyNative(native(), nativeIntents());
  for (const mutate of [n => n.triggers[0].source.text += 'changed', n => n.triggers[0].actual_model = 'fallback',
    n => n.triggers[0].canonical_finals.push({ text: 'duplicate' }), n => n.triggers[0].recipient_views.pop(),
    n => n.triggers[0].private_task_count = 1, n => n.triggers[0].final_room_id = 'foreign-room']) {
    const n = native(); mutate(n); assert.throws(() => verifyNative(n, nativeIntents()));
  }
});
test('scenario oracle uses frozen expectations and refuses missing evidence or unsupported', () => {
  const spec = SCENARIOS.find(s => s.name === 'cross-tenant-all-indirect-routes');
  const o = { name: spec.name, status: 'observed', evidence: Object.fromEntries(spec.evidence.map(k => [k, ['test-only']])),
    observed: { ...spec.expected }, artifacts: Object.fromEntries(Object.keys(spec.expected).map(k => [k, 'test-only'])) };
  verifyScenario(spec, o);
  for (const mutate of [o => o.observed.sentinel_leaks = 1, o => delete o.evidence.route_matrix,
    o => o.status = 'unsupported', o => delete o.artifacts.sentinel_leaks, o => o.observed = {}]) {
    const broken = structuredClone(o); mutate(broken); assert.throws(() => verifyScenario(spec, broken));
  }
});
const fence = () => ({ boundary: 'before-protected-admission', barrier_artifact: 'test-only', durable_readback_artifact: 'test-only',
  current_fence_gen: '10', stale_fence_gen: '9', stale_admitted_after_reclaim: false, canonical_finals: [{ text: 'final' }],
  pinned_model: 'test-model', new_attempt_model: 'test-model', unresolved_provider_replayed: false,
  events: [{ type: 'final.commit', invocation_id: 'test-id', attempt: 2, fence_gen: '10', admitted_after_reclaim: true }] });
test('fencing rejects stale publish, missing actual barrier and unsafe provider replay', () => {
  verifyRace('stale-host-final', fence());
  for (const mutate of [r => r.stale_admitted_after_reclaim = true, r => r.events[0].fence_gen = '9',
    r => r.boundary = 'sequential', r => r.events[0].fence_gen = 10, r => r.current_fence_gen = '09', r => r.unresolved_provider_replayed = true, r => r.canonical_finals.push({ text: 'dup' })]) {
    const r = fence(); mutate(r); assert.throws(() => verifyRace('stale-host-final', r));
  }
});
const approval = () => {
  const card = { approval_id: 'test-card', version: 1, effect_id: 'test-effect', digest: 'test-digest', invocation_id: 'test-run', attempt: 1, fence_gen: '9007199254740993', expires_at: 'test-expiry' };
  return { boundary: 'before-protected-admission', barrier_artifact: 'test-only', durable_readback_artifact: 'test-only',
    card, authorized_actor_id: 'test-actor', valid_decisions: [{ ...card, actor_id: 'test-actor', status: 'approved' }], loser_side_effects: 0 };
};
test('approval oracle rejects double decision, wrong actor/version/digest and loser effect', () => {
  verifyRace('approval-double-decision', approval());
  for (const mutate of [r => r.valid_decisions.push({ ...r.valid_decisions[0], status: 'denied' }),
    r => r.valid_decisions[0].actor_id = 'foreign', r => r.valid_decisions[0].version++,
    r => r.valid_decisions[0].digest = 'changed', r => r.valid_decisions[0].fence_gen = '9007199254740992', r => r.loser_side_effects = 1]) {
    const r = approval(); mutate(r); assert.throws(() => verifyRace('approval-double-decision', r));
  }
});
test('seal oracle rejects acceptance after terminal rejection', () => {
  const r = { boundary: 'before-protected-admission', barrier_artifact: 'test', durable_readback_artifact: 'test',
    terminal_state: 'rejected', message_count: 0, later_state: 'rejected', original_digest: 'same', later_digest: 'same' };
  verifyRace('seal-delayed-submit', r);
  assert.throws(() => verifyRace('seal-delayed-submit', { ...r, later_state: 'accepted' }));
});
function recovery(ops) {
  const receipts = ops.map(o => ({ id: o.id, state: 'accepted', envelope_digest: digest(o.envelope), canonical_message_id: o.id + '-message', commit_artifact: 'test' }));
  const messages = ops.map(o => ({ operation_id: o.id, text: o.envelope.text, actor_alias: o.envelope.actor_alias, message_id: o.id + '-message' }));
  return { receipts, projections: [0,1].map(() => ({ messages: structuredClone(messages), cursor_artifact: 'test', durable_readback_artifact: 'test' })), faults_exercised: [...FAULTS], unresolved_outbox_lost: 0 };
}
test('1000-operation oracle detects loss, duplication, text corruption, replacement and unknown', () => {
  const ops = recoveryOperations(); verifyRecovery(ops, recovery(ops));
  for (const mutate of [r => r.receipts.pop(), r => r.receipts[0].state = 'recovery_unknown',
    r => r.receipts[0].envelope_digest = 'replacement', r => r.projections[0].messages[0].text += 'corrupt',
    r => r.projections[0].messages[1] = r.projections[0].messages[0], r => r.faults_exercised.pop(),
    r => r.unresolved_outbox_lost = 1]) {
    const r = recovery(ops); mutate(r); assert.throws(() => verifyRecovery(ops, r));
  }
});
test('raw artifacts require matching hashes and reject evidence-directory escape', () => {
  const root = mkdtempSync(tmpdir() + '/slice34-artifact-');
  const foreign = mkdtempSync(tmpdir() + '/slice34-foreign-');
  try {
    writeFileSync(root + '/raw', 'fictional evidence'); writeFileSync(foreign + '/raw', 'fictional evidence');
    const a = { path: root + '/raw', sha256: createHash('sha256').update('fictional evidence').digest('hex') };
    verifyArtifact(a, root);
    assert.throws(() => verifyArtifact('claimed-artifact', root));
    assert.throws(() => verifyArtifact({ ...a, sha256: '0'.repeat(64) }, root));
    assert.throws(() => verifyArtifact({ ...a, path: foreign + '/raw' }, root));
    symlinkSync(foreign + '/raw', root + '/escape');
    assert.throws(() => verifyArtifact({ ...a, path: root + '/escape' }, root));
  } finally { rmSync(root, { recursive: true }); rmSync(foreign, { recursive: true }); }
});
