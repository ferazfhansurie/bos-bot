import { compatEnv } from "../../../electron/branding-env.cjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { redact } from './transport.mjs';
import { SCENARIOS } from './slice34-plan.mjs';
import { SCHEMA_COMMIT } from './slice34-binding.mjs';
import { verifyScenario } from './slice34-verifier.mjs';
import { verifyArtifact } from './run-slice34.mjs';
const [serverArg, evidenceArg, model = 'claude-sonnet-4-6'] = process.argv.slice(2);
assert.ok(serverArg && evidenceArg, 'usage: node --experimental-strip-types run-native-slice34.mjs SERVER NEW_EVIDENCE_DIR [MODEL]');
const server = resolve(serverArg), evidence = resolve(evidenceArg);
assert.notEqual(server, evidence); assert.ok(!evidence.startsWith(server + '/'), 'evidence stays outside the source tree');
const git = args => execFileSync('git', args, { cwd: server, encoding: 'utf8' }).trim();
assert.equal(git(['status','--porcelain','--','services/cloud', 'server/cloud-host.ts', 'server/drivers/claude.ts', 'shared/cloud-protocol', ':!services/cloud/acceptance']), '', 'dirty SUT');
mkdirSync(evidence, { mode: 0o700 });
const data = mkdtempSync(resolve(tmpdir(), 'bos-native-host-data-'));
compatEnv.OMB_DATA_DIR = data;
compatEnv.OMB_DISABLE_LEGACY_MIGRATION = '1';
mkdirSync(data + '/native', { mode: 0o700 });
const candidate = git(['rev-parse','HEAD']);
const record = entry => appendFileSync(evidence + '/raw.jsonl', JSON.stringify(redact({ at: new Date().toISOString(), ...entry })) + '\n', { mode: 0o600, flush: true });
let adapter;
const summary = { candidate, schema: SCHEMA_COMMIT, status: 'failed', results: [], provider_runs_limit: 2 };
try {
  const { connect } = await import('./slice34-service-adapter.mjs');
  adapter = await connect({ server, candidate, schema: SCHEMA_COMMIT, evidence, record, nativeProvider: { model } });
  summary.target = await adapter.describe(); record({ type: 'target', description: summary.target });
  for (const spec of SCENARIOS.filter(s => ['two-human-native','explicit-steer-and-two-bot-no-loop'].includes(s.name))) {
    const o = await adapter.scenario(spec);
    // Both gates consume the same independently frozen wire/provider pair.
    verifyScenario(spec, o, o.native_intents);
    for (const key of spec.evidence) for (const a of o.evidence[key]) verifyArtifact(a, evidence);
    for (const a of Object.values(o.artifacts)) verifyArtifact(a, evidence);
    for (const t of o.native.triggers) verifyArtifact(t.provider_transcript_artifact, evidence);
    verifyArtifact(o.native_run_artifact, evidence);
    summary.results.push({ name: spec.name, status: 'passed', observed: o.observed, artifact: o.native_run_artifact,
      native_receipts: o.native.triggers.map(t => ({ invocation_id: t.invocation_id, provider_receipt: t.provider_receipt, recipients: t.recipient_views.map(v => v.actor_id), final_message_id: t.canonical_finals[0].message_id })) });
    record({ type: 'scenario_observation', observation: o });
  }
  summary.status = 'passed';
} catch (error) { summary.error = error.message; process.exitCode = 1; }
finally {
  try { await adapter?.close(); } finally { rmSync(data, { recursive: true, force: true }); }
  summary.native_data_removed = true;
  writeFileSync(evidence + '/summary.json', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify(summary));
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
