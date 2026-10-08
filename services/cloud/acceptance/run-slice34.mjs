import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { freezeManifest, digest } from './oracle.mjs';
import { redact, localURL } from './transport.mjs';
import { bothOrders } from './schedules.mjs';
import { plan, planDigest, RACES, FIXTURES } from './slice34-plan.mjs';
import { BINDING, ROUTES, SCHEMA_COMMIT } from './slice34-binding.mjs';
import { verifyScenario, verifyRace, verifyRecovery } from './slice34-verifier.mjs';

export function verifyArtifact(artifact, evidence) {
  assert.ok(artifact && typeof artifact.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), 'raw artifact path/digest required');
  const path = realpathSync(artifact.path), root = realpathSync(evidence);
  assert.ok(path.startsWith(root + sep), 'artifact must stay in independent evidence directory');
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), artifact.sha256, 'artifact digest mismatch');
}

export function unrunReason(spec, observation) {
  if (observation.status !== 'unrun') return null;
  assert.equal(observation.name, spec.name);
  assert.ok(typeof observation.reason === 'string' && observation.reason.trim().length > 0, 'unrun requires a concrete missing capability');
  assert.equal(observation.observed, undefined, 'unrun cannot supply modeled observations');
  return observation.reason;
}

// Schema binding is pinned; actual service adapter awaits the backend commit.
// No modeled adapter is shipped as an acceptance target.
export function prepare(evidence, pins, count = 1000) {
  mkdirSync(evidence, { mode: 0o700 });
  const p = plan(count);
  const scope = { workspace_id: 'fictional-workspace', room_id: 'fictional-room', host_id: 'fictional-host',
    invocation_id: 'fictional-invocation', approval_id: 'fictional-card', attachment_id: 'fictional-attachment' };
  const routes = Object.fromEntries(Object.entries(ROUTES).map(([name, [method, path, , , host]]) =>
    [name, { method, path: path(scope), host }]));
  writeFileSync(evidence + '/binding.json', JSON.stringify({ ...BINDING, routes }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600, flush: true });
  writeFileSync(evidence + '/schedule.json', JSON.stringify({ ...p, pins, plan_digest: planDigest(p) }, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  freezeManifest(evidence + '/recovery-intents.manifest.json', { candidate: pins.candidate, protocol: pins.schema, scope: { fictional: true }, operations: p.recovery });
  return p;
}
export async function run({ server, evidence, candidate, schema, adapterPath }) {
  server = realpathSync(server); evidence = resolve(evidence);
  assert.ok(!evidence.startsWith(server + sep));
  const git = args => execFileSync('git', args, { cwd: server, encoding: 'utf8' }).trim();
  const candidateSHA = git(['rev-parse', candidate + '^{commit}']);
  const schemaSHA = git(['rev-parse', schema + '^{commit}']);
  assert.equal(schemaSHA, SCHEMA_COMMIT, 'adapter binding targets frozen schema');
  assert.equal(git(['rev-parse', 'HEAD']), candidateSHA);
  assert.equal(git(['status', '--porcelain', '--', 'services/cloud', 'shared/cloud-protocol', ':!services/cloud/acceptance']), '', 'dirty SUT');
  git(['merge-base', '--is-ancestor', schemaSHA, candidateSHA]);
  const sourceTree = git(['rev-parse', candidateSHA + ':services/cloud']);
  const protocolTree = git(['rev-parse', candidateSHA + ':shared/cloud-protocol']);
  const modulePath = realpathSync(adapterPath);
  const adapterDigest = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const p = prepare(evidence, { candidate: candidateSHA, schema: schemaSHA, sourceTree, protocolTree, adapterDigest });
  const raw = evidence + '/raw.jsonl'; writeFileSync(raw, '', { flag: 'wx', mode: 0o600 });
  const record = entry => appendFileSync(raw, JSON.stringify(redact({ at: new Date().toISOString(), ...entry })) + '\n', { flush: true });
  const adapter = await (await import(pathToFileURL(modulePath).href)).connect({ server, candidate: candidateSHA, schema: schemaSHA, evidence, record });
  const results = [];
  const counts = { scenarios: { scheduled: p.scenarios.length, passed: 0, failed: 0, unrun: 0 }, races: { scheduled: 800, passed: 0, failed: 0, unrun: 800 }, recovery: { scheduled: p.recovery.length, prepared: 0, submitted: 0, verified: 0 } };
  const journalRecord = record;
  const countRecord = entry => { if (entry.type === 'race') { counts.races[entry.state === 'passed' ? 'passed' : 'failed']++; counts.races.unrun--; } journalRecord(entry); };
  try {
    const d = await adapter.describe();
    localURL(d.url); assert.equal(d.isolated, true); assert.equal(d.acceptance_hooks, true);
    assert.equal(d.modeled, false); assert.equal(d.candidate, candidateSHA); assert.equal(d.schema, schemaSHA);
    assert.equal(d.real_issuer, true); record({ type: 'target', description: d });
    for (const spec of p.scenarios) {
      try {
      let nativeIntents;
      if (spec.evidence.includes('provider') && d.native_provider_available !== false) {
        assert.ok(d.pinned_model && d.scope?.room_id, 'real pinned native provider required');
        nativeIntents = ['fictional-alice', 'fictional-bob'].map((actor_alias, index) => ({
          id: `${spec.name}-source-${index}`, envelope: { room_id: d.scope.room_id, actor_alias,
            text: `@fictional-bot ${spec.name} source ${index} e\u0301 🦊`,
            mentions: [{ bot_alias: 'fictional-bot', start: 0, end: 14 }], pinned_model: d.pinned_model },
          expected: { canonical_finals: 1, private_tasks: 0 },
        }));
        freezeManifest(evidence + '/' + spec.name + '.sources.manifest.json', {
          candidate: candidateSHA, protocol: schemaSHA, scope: d.scope, operations: nativeIntents,
        });
      }
      const o = await adapter.scenario(spec, { fixtures: FIXTURES, nativeIntents });
      record({ type: 'scenario_observation', observation: o });
      const missing = unrunReason(spec, o);
      if (missing) { results.push({ name: spec.name, state: 'unrun', reason: missing }); counts.scenarios.unrun++; continue; }
      verifyScenario(spec, o, nativeIntents);
      for (const key of spec.evidence) for (const a of o.evidence[key]) verifyArtifact(a, evidence);
      for (const key of Object.keys(spec.expected)) verifyArtifact(o.artifacts[key], evidence);
      if (nativeIntents) for (const trigger of o.native.triggers) verifyArtifact(trigger.provider_transcript_artifact, evidence);
      results.push({ name: spec.name, state: 'passed' });
      counts.scenarios.passed++;
      } catch (error) { counts.scenarios.failed++; const result = { name: spec.name, state: 'failed', error: error.message }; results.push(result); record({ type: 'scenario_failure', ...result }); }
    }
    for (const name of RACES) { try { await bothOrders({ name,
      prepare: async context => {
        const fixture = await adapter.prepareRace(name, context);
        assert.ok(fixture.scope && fixture.intents?.length === 2 && fixture.expected);
        freezeManifest(evidence + `/race-${name}-${context.order}-${context.iteration}.manifest.json`, {
          candidate: candidateSHA, protocol: schemaSHA, scope: fixture.scope, operations: fixture.intents,
        });
        // Freeze expected card/authority metadata before either admission is attempted.
        fixture.frozenExpected = structuredClone(fixture.expected);
        record({ type: 'race_expected', name, ...context, expected: fixture.frozenExpected });
        return fixture;
      },
      first: fixture => fixture.first(), second: fixture => fixture.second(),
      inspect: async ({ fixture, ...context }) => {
        const o = await fixture.inspect(context); record({ type: 'race_observation', name, ...context, observation: o }); verifyRace(name, o);
        if (name === 'approval-double-decision') {
          assert.deepEqual(o.card, fixture.frozenExpected.card);
          assert.equal(o.authorized_actor_id, fixture.frozenExpected.authorized_actor_id);
        }
        verifyArtifact(o.barrier_artifact, evidence); verifyArtifact(o.durable_readback_artifact, evidence);
      }, record: countRecord });
      } catch (error) { record({ type: 'race_group_failed', name, error: error.message }); results.push({ name: 'race-' + name, state: 'failed', error: error.message }); }
    }
    // Allocate signed windows first; freeze the exact wire envelopes before dispatch.
    const wired = [];
    try {
    for (const intent of p.recovery) {
      const envelope = await adapter.prepareOperation(intent);
      wired.push({ id: intent.id, envelope, expected: intent.expected });
      counts.recovery.prepared++;
    }
    freezeManifest(evidence + '/recovery-wire.manifest.json', { candidate: candidateSHA, protocol: schemaSHA, scope: d.scope, operations: wired });
    for (let index = 0; index < p.recovery.length; index++) {
      const intent = p.recovery[index], wire = wired[index];
      record({ type: 'submitted', id: intent.id, intent_digest: digest(intent.envelope), wire_digest: digest(wire.envelope), fault: intent.fault });
      counts.recovery.submitted++;
      await adapter.submitRecovery(intent, wire.envelope);
    }
    const recovered = await adapter.reconcileRecovery(p.recovery);
    record({ type: 'recovery_observation', observation: recovered });
    verifyRecovery(p.recovery, recovered);
    for (const receipt of recovered.receipts) {
      assert.equal(receipt.wire_digest, digest(wired.find(w => w.id === receipt.id).envelope));
      verifyArtifact(receipt.commit_artifact, evidence);
    }
    for (const projection of recovered.projections) {
      verifyArtifact(projection.cursor_artifact, evidence); verifyArtifact(projection.durable_readback_artifact, evidence);
    }
    results.push({ name: 'recovery', state: 'passed', count: p.recovery.length });
    counts.recovery.verified = p.recovery.length;
    } catch (error) { results.push({ name: 'recovery', state: 'failed', error: error.message }); record({ type: 'recovery_failed', error: error.message }); }
    const status = counts.scenarios.failed || counts.races.failed || results.some(r => r.state === 'failed') ? 'failed'
      : counts.scenarios.unrun || counts.races.unrun || counts.recovery.verified !== p.recovery.length ? 'incomplete' : 'passed';
    const summary = { candidate: candidateSHA, schema: schemaSHA, adapterDigest, status, counts, results };
    writeFileSync(evidence + '/summary.json', JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    record({ type: 'complete', ...summary }); return summary;
  } catch (error) { record({ type: 'complete', status: 'failed', error: error.message, results }); throw error; }
  finally { await adapter.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--prepare') {
    assert.equal(args.length, 1, 'usage: --prepare NEW_EXTERNAL_EVIDENCE_DIR');
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
    git(['merge-base', '--is-ancestor', SCHEMA_COMMIT, 'HEAD']);
    assert.equal(git(['status', '--porcelain', '--', 'shared/cloud-protocol']), '', 'dirty protocol');
    prepare(resolve(args[0]), { candidate: git(['rev-parse', 'HEAD']), schema: SCHEMA_COMMIT, protocolTree: git(['rev-parse', 'HEAD:shared/cloud-protocol']) });
    console.log('prepared; product acceptance unrun');
  } else {
    assert.equal(mode, '--run'); assert.equal(args.length, 5, 'usage: --run SERVER CANDIDATE SCHEMA ADAPTER NEW_EXTERNAL_EVIDENCE_DIR');
    const summary = await run({ server: args[0], candidate: args[1], schema: args[2], adapterPath: args[3], evidence: args[4] });
    console.log(JSON.stringify({ status: summary.status, counts: summary.counts }));
    if (summary.status !== 'passed') process.exitCode = summary.status === 'incomplete' ? 2 : 1;
  }
}
