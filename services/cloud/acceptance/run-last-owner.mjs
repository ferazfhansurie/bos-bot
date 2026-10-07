import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { localURL, redact, Transport } from './transport.mjs';
import { lastOwnerRemoval } from './last-owner.mjs';

const [serverArg, stateArg, journalArg] = process.argv.slice(2);
assert.ok(serverArg && stateArg && journalArg, 'usage: node run-last-owner.mjs SERVER_WORKTREE STATE_PATH NEW_JOURNAL_PATH');
const server = realpathSync(serverArg);
const statePath = realpathSync(stateArg);
assert.ok(statePath.startsWith(server + '/services/cloud/.fixture/run-'), 'state must belong to this throwaway launcher');
const journalPath = resolve(journalArg);
assert.ok(!journalPath.startsWith(server + sep), 'evidence must remain outside service storage');
const git = args => execFileSync('git', args, { cwd: server, encoding: 'utf8' }).trim();
const owned = ['services/cloud/fixture.ts', 'services/cloud/service.ts', 'services/cloud/db.ts',
  'services/cloud/hooks.ts', 'services/cloud/http.ts', 'services/cloud/identity.ts',
  'services/cloud/migrate.ts', 'services/cloud/migrations', 'services/cloud/package.json',
  'services/cloud/package-lock.json'];
const candidate = git(['rev-parse', 'HEAD']);
assert.equal(git(['ls-files', '--error-unmatch', 'services/cloud/fixture.ts']), 'services/cloud/fixture.ts',
  'api server must be committed before acceptance');
assert.equal(git(['status', '--porcelain', '--', ...owned]), '', 'server candidate must be clean');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const base = localURL(state.url);
assert.equal(realpathSync(state.fixture_directory) + '/state.json', statePath);
assert.ok(state.hook_secret && state.schema === 1, 'isolated fixture state required');
for (const [field, role] of [['database_url', 'cloud_app'], ['migration_url', 'cloud_migrator']]) {
  const db = new URL(state[field]);
  assert.equal(db.protocol, 'postgres:');
  assert.equal(db.hostname, '127.0.0.1');
  assert.equal(db.username, role);
  assert.ok(db.pathname.startsWith('/cloud_slice1_'));
}
const appURL = new URL(state.database_url), migrationURL = new URL(state.migration_url);
assert.equal(appURL.host + appURL.pathname, migrationURL.host + migrationURL.pathname);
const pg = createRequire(server + '/services/cloud/package.json')('pg');
const admin = new pg.Client({ connectionString: state.migration_url, connectionTimeoutMillis: 2000,
  query_timeout: 5000 });
const app = new pg.Client({ connectionString: state.database_url, connectionTimeoutMillis: 2000,
  query_timeout: 5000 });
writeFileSync(journalPath, '', { flag: 'wx', mode: 0o600 });
const record = entry => appendFileSync(journalPath,
  JSON.stringify({ at: new Date().toISOString(), ...redact(entry) }) + '\n', { flush: entry.type === 'complete' });
const transport = new Transport(base.href, record);
async function hooks(action, body) {
  const path = '/v2/test/hooks' + (action ? '/' + action : '');
  record({ type: 'hook_request', path, body: body ?? null });
  const response = await fetch(new URL(path, base), { method: action ? 'POST' : 'GET',
    redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { 'X-Cloud-Fixture-Secret': state.hook_secret, 'content-type': 'application/json' },
    ...(action ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  record({ type: 'hook_response', path, status: response.status, data });
  assert.equal(response.status, 200, 'secret-gated fixture hook failed');
  return data;
}
try {
  await admin.connect();
  await app.connect();
  const role = (await app.query(`SELECT current_user, current_database(), rolsuper, rolbypassrls,
    rolinherit FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(role.current_user, 'cloud_app');
  for (const key of ['rolsuper', 'rolbypassrls', 'rolinherit']) assert.equal(role[key], false);
  record({ type: 'fixture', candidate, protocol: 'ffd3a022d56485a11363a49c2e070d6cb075bbb8',
    base: git(['merge-base', 'HEAD', 'e2b52598']), url: base.href,
    schema: state.schema, role, fixture_pid: state.fixture_pid, postgres_pid: state.postgres_pid });
  await lastOwnerRemoval({ transport, hooks, record,
    inspectOwners: async workspace => {
      const rows = (await admin.query(`SELECT account_id FROM cloud.members
        WHERE workspace_id=$1 AND role='owner' ORDER BY account_id`, [workspace])).rows;
      const owners = rows.map(row => row.account_id);
      record({ type: 'durable_owners', workspace_id: workspace, owners });
      return owners;
    },
  });
  record({ type: 'complete', case: 'a16-mutual-owner-removal', state: 'passed', races: 200 });
  console.log(JSON.stringify({ case: 'a16-mutual-owner-removal', state: 'passed', candidate,
    races: 200, journal: journalPath }));
} catch (error) {
  record({ type: 'complete', case: 'a16-mutual-owner-removal', state: 'failed', error: error.message });
  throw error;
} finally {
  await app.end();
  await admin.end();
}
