import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './transport.mjs';
import { SCENARIOS } from './slice34-plan.mjs';
import { SCHEMA_COMMIT } from './slice34-binding.mjs';
import { verifyScenario } from './slice34-verifier.mjs';
import { verifyArtifact } from './run-slice34.mjs';
import { connect } from './slice34-service-adapter.mjs';

const [source, destination, ...names] = process.argv.slice(2);
assert.ok(source && destination && names.length, 'usage: SERVER NEW_EXTERNAL_EVIDENCE_DIR SCENARIO ...');
const server = resolve(source), evidence = resolve(destination);
assert.ok(!evidence.startsWith(server + '/'));
const git = (...args) => execFileSync('git', args, { cwd: server, encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--', 'services/cloud', 'shared/cloud-protocol', 'ios'), '', 'dirty candidate');
const candidate = git('rev-parse', 'HEAD'), schema = SCHEMA_COMMIT;
git('merge-base', '--is-ancestor', schema, candidate);
const pins = { candidate, schema, sourceTree: git('rev-parse', 'HEAD:services/cloud'),
  protocolTree: git('rev-parse', 'HEAD:shared/cloud-protocol'), nativeTree: git('rev-parse', 'HEAD:ios') };
mkdirSync(evidence, { mode: 0o700 });
writeFileSync(evidence + '/execution-context.json', JSON.stringify({ ...pins, names }, null, 2), { flag: 'wx', mode: 0o600 });
writeFileSync(evidence + '/raw.jsonl', '', { flag: 'wx', mode: 0o600 });
const record = entry => appendFileSync(evidence + '/raw.jsonl', JSON.stringify(redact({ at: new Date().toISOString(), ...entry })) + '\n', { flush: true });
let adapter, status = 'passed', failure, observations = [];
try {
  adapter = await connect({ server, evidence, ...pins, record });
  const target = await adapter.describe();
  assert.equal(target.real_issuer, true); assert.equal(target.isolated, true); assert.equal(target.modeled, false);
  record({ type: 'target', target });
  for (const name of names) {
    const spec = SCENARIOS.find(s => s.name === name); assert.ok(spec, 'unknown scenario');
    const observation = await adapter.scenario(spec); record({ type: 'scenario_observation', observation });
    verifyScenario(spec, observation);
    for (const artifact of Object.values(observation.artifacts)) verifyArtifact(artifact, evidence);
    observations.push(observation);
  }
} catch (error) { status = 'failed'; failure = error.stack; record({ type: 'scenario_failed', failure }); }
finally { if (adapter) await adapter.close(); }
const journalDigest = createHash('sha256').update(readFileSync(evidence + '/raw.jsonl')).digest('hex');
const result = { status, ...pins, journalDigest, scenarios: observations.map(o => ({ name: o.name, observed: o.observed })),
  failure, mode: 'focused gates only; not full-matrix or installed-device acceptance' };
writeFileSync(evidence + '/summary.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result)); if (status !== 'passed') process.exitCode = 1;
