import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// Independent intent evidence. Never import service reducers, digest code or DB models.
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('manifest values must be JSON');
}
export const digest = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
export function freezeManifest(path, { candidate, protocol, scope, operations }) {
  assert.ok(candidate && protocol && scope, 'pin candidate, protocol and fictional scope');
  const ids = new Set();
  const intents = operations.map(({ id, envelope, expected }) => {
    assert.ok(typeof id === 'string' && id.length > 0 && !ids.has(id), 'unique independent operation ID');
    assert.ok(envelope && expected, 'freeze both the intended envelope and expected outcome');
    ids.add(id);
    return { id, envelope, expected, envelope_digest: digest(envelope) };
  });
  const data = { version: 1, candidate, protocol, scope, intents };
  const manifest = { ...data, manifest_digest: digest(data) };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  return loadManifest(path);
}
export function loadManifest(path) {
  const { manifest_digest, ...data } = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(digest(data), manifest_digest, 'independent manifest changed');
  assert.equal(new Set(data.intents.map(x => x.id)).size, data.intents.length, 'duplicate ID');
  for (const intent of data.intents) assert.equal(digest(intent.envelope), intent.envelope_digest);
  return { ...data, manifest_digest };
}
export class Oracle {
  constructor(manifestPath, journalPath) {
    this.manifest = loadManifest(manifestPath);
    this.intents = new Map(this.manifest.intents.map(x => [x.id, x]));
    this.receipts = new Map();
    this.journalPath = journalPath;
    // Refuse to mix a fresh run with old observations.
    writeFileSync(journalPath, '', { flag: 'wx', mode: 0o600 });
    this.record({ type: 'manifest', digest: this.manifest.manifest_digest });
  }
  record(entry) {
    appendFileSync(this.journalPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { flush: true });
  }
  submitted(id, envelope) {
    const intent = this.intents.get(id);
    assert.ok(intent, 'submission absent from independent manifest');
    assert.equal(digest(envelope), intent.envelope_digest, 'submission changed frozen intent');
    this.record({ type: 'submitted', id, envelope_digest: intent.envelope_digest });
  }
  outcome(id, state, reference = null) {
    assert.ok(this.intents.has(id), 'unexpected outcome ID');
    assert.ok(['accepted', 'rejected', 'not_found', 'recovery_unknown'].includes(state));
    const previous = this.receipts.get(id);
    if (previous && ['accepted', 'rejected'].includes(previous.state)) {
      assert.equal(state, previous.state, 'terminal outcome changed');
      assert.deepEqual(reference, previous.reference, 'canonical receipt changed');
    }
    this.receipts.set(id, { state, reference });
    this.record({ type: 'outcome', id, state, reference });
  }
  verifyMessages(messages) {
    const expected = this.manifest.intents.filter(x => this.receipts.get(x.id)?.state === 'accepted' && x.expected.message);
    for (const intent of expected) {
      const matches = messages.filter(x => x.operation_id === intent.id);
      assert.equal(matches.length, 1, `accepted logical message must exist exactly once: ${intent.id}`);
      for (const [key, value] of Object.entries(intent.expected.message)) assert.deepEqual(matches[0][key], value, `recipient ${key}: ${intent.id}`);
    }
    for (const message of messages) {
      const intent = this.intents.get(message.operation_id);
      assert.ok(intent, 'unexpected logical message in fictional room');
      assert.equal(this.receipts.get(intent.id)?.state, 'accepted', 'nonaccepted operation produced a message');
    }
    this.record({ type: 'projection_verified', operations: expected.map(x => x.id), digest: digest(messages) });
  }
  assertResolved() {
    for (const intent of this.manifest.intents) {
      const observed = this.receipts.get(intent.id);
      assert.ok(observed && ['accepted', 'rejected'].includes(observed.state), `operation unresolved: ${intent.id}`);
      if (intent.expected.state) assert.equal(observed.state, intent.expected.state, `wrong intended outcome: ${intent.id}`);
    }
  }
}
