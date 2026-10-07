import assert from 'node:assert/strict';
import { digest } from './oracle.mjs';
import { WIRE } from './slice34-plan.mjs';

export function verifyScenario(spec, observation, nativeIntents) {
  assert.equal(observation.name, spec.name);
  assert.equal(observation.status, 'observed', 'missing/unsupported is a gate');
  for (const key of spec.evidence) assert.ok(observation.evidence?.[key]?.length > 0, `missing raw ${key} evidence`);
  for (const [key, expected] of Object.entries(spec.expected)) {
    assert.ok(observation.artifacts?.[key], `missing ${key} artifact`);
    assert.deepEqual(observation.observed?.[key], expected, `${spec.name}: ${key}`);
  }
  if (spec.evidence.includes('provider')) verifyNative(observation.native, nativeIntents);
}
export function verifyNative(n, intents) {
  assert.ok(intents?.length >= 2, 'independently frozen source intents required');
  assert.ok(n?.triggers?.length >= 2, 'two fictional human source triggers');
  assert.equal(n.triggers.length, intents.length);
  assert.ok(new Set(n.triggers.map(t => t.actor_alias)).size >= 2);
  const ids = new Set();
  for (const t of n.triggers) {
    const intent = intents.find(i => i.id === t.source_intent_id); assert.ok(intent);
    assert.deepEqual(t.source, intent.envelope, 'source must match the independently frozen input');
    assert.equal(t.actor_alias, intent.envelope.actor_alias);
    assert.ok(t.invocation_id && !ids.has(t.invocation_id)); ids.add(t.invocation_id);
    assert.equal(t.ingress_digest, digest(t.source));
    assert.equal(t.provider_input_digest, t.ingress_digest);
    assert.deepEqual(t.actual_model, intent.envelope.pinned_model); assert.deepEqual(t.actual_model, t.pinned_model); assert.ok(t.actual_model);
    assert.ok(t.provider_receipt && t.host_build && t.provider_transcript_artifact);
    assert.equal(t.final_room_id, t.source.room_id);
    assert.equal(t.canonical_finals.length, 1);
    assert.equal(t.private_task_count, 0);
    assert.ok(t.recipient_views.length >= 2);
    for (const v of t.recipient_views) assert.deepEqual(v.final, t.canonical_finals[0]);
  }
  assert.equal(new Set(n.triggers.map(t => t.source_intent_id)).size, intents.length);
}
export function verifyRace(name, r) {
  assert.equal(r.boundary, 'before-protected-admission');
  assert.ok(r.barrier_artifact && r.durable_readback_artifact);
  if (name.startsWith('stale-host-')) {
    for (const gen of [r.current_fence_gen, r.stale_fence_gen]) assert.match(gen, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(r.current_fence_gen) > BigInt(r.stale_fence_gen));
    assert.equal(r.stale_admitted_after_reclaim, false);
    assert.ok(r.canonical_finals.length <= 1);
    assert.deepEqual(r.new_attempt_model, r.pinned_model);
    assert.equal(r.unresolved_provider_replayed, false);
    for (const e of r.events) {
      assert.ok(WIRE.includes(e.type)); assert.ok(e.invocation_id);
      assert.ok(Number.isInteger(e.attempt) && e.attempt >= 0);
      assert.match(e.fence_gen, /^(0|[1-9][0-9]*)$/);
      if (e.admitted_after_reclaim) assert.equal(e.fence_gen, r.current_fence_gen);
    }
  } else if (name === 'approval-double-decision') {
    assert.equal(r.valid_decisions.length, 1);
    assert.ok(['approved', 'denied'].includes(r.valid_decisions[0].status));
    assert.equal(r.valid_decisions[0].actor_id, r.authorized_actor_id);
    for (const key of ['approval_id', 'version', 'effect_id', 'digest', 'invocation_id', 'attempt', 'fence_gen', 'expires_at']) {
      assert.ok(r.card[key] !== undefined); assert.deepEqual(r.valid_decisions[0][key], r.card[key]);
    }
    assert.equal(r.loser_side_effects, 0);
  } else if (name === 'seal-delayed-submit') {
    assert.ok(['accepted', 'rejected'].includes(r.terminal_state));
    assert.equal(r.message_count, r.terminal_state === 'accepted' ? 1 : 0);
    assert.equal(r.later_state, r.terminal_state);
    assert.equal(r.later_digest, r.original_digest);
  } else assert.fail(`unsupported race ${name}`);
}
export function verifyRecovery(operations, observed) {
  assert.ok(operations.length >= 1000);
  assert.equal(observed.receipts.length, operations.length);
  const receipts = new Map(observed.receipts.map(r => [r.id, r]));
  assert.equal(receipts.size, operations.length, 'duplicate receipt');
  for (const op of operations) {
    const r = receipts.get(op.id); assert.ok(r, `missing ${op.id}`);
    assert.equal(r.state, op.expected.state);
    assert.equal(r.envelope_digest, digest(op.envelope), 'recovery replaced original intent');
    assert.ok(r.canonical_message_id && r.commit_artifact);
  }
  assert.ok(observed.projections.length >= 2, 'two independent recipient projections');
  for (const projection of observed.projections) {
    assert.equal(projection.messages.length, operations.length);
    const messages = new Map(projection.messages.map(m => [m.operation_id, m]));
    assert.equal(messages.size, operations.length, 'duplicate logical message');
    for (const op of operations) {
      const m = messages.get(op.id); assert.ok(m);
      assert.equal(m.text, op.envelope.text);
      assert.equal(m.actor_alias, op.envelope.actor_alias);
      assert.equal(m.message_id, receipts.get(op.id).canonical_message_id);
    }
    assert.ok(projection.cursor_artifact && projection.durable_readback_artifact);
  }
  assert.deepEqual(observed.faults_exercised.sort(), [...new Set(operations.map(o => o.fault))].sort());
  assert.equal(observed.unresolved_outbox_lost, 0);
}
