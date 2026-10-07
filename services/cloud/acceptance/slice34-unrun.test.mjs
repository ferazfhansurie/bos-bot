import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unrunReason } from './run-slice34.mjs';

test('unavailable native evidence stays unrun and cannot carry modeled invariants', () => {
  const spec = { name: 'native-provider' };
  const missing = { name: spec.name, status: 'unrun', reason: 'native provider transcript unavailable' };
  assert.equal(unrunReason(spec, missing), missing.reason);
  assert.throws(() => unrunReason(spec, { ...missing, observed: { canonical_finals: 1 } }));
  assert.throws(() => unrunReason(spec, { ...missing, reason: '' }));
  assert.throws(() => unrunReason(spec, { ...missing, name: 'other-gate' }));
  assert.equal(unrunReason(spec, { name: spec.name, status: 'observed' }), null);
});
