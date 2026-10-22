import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bos-release-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['latest-mac.yml', 'latest.yml']) {
    writeFileSync(join(dir, name), 'version: 2.1.3\nfiles: []\nreleaseNotes: keep this\n');
  }
  for (const name of ['arm64.zip', 'arm64.dmg', 'x64.zip', 'x64.dmg', 'setup.exe', 'setup.exe.blockmap']) {
    writeFileSync(join(dir, `BOS-Bot-2.1.3-${name}`), 'fixture bytes');
  }
  return dir;
}
function run(script, ...args) {
  return spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { encoding: 'utf8' });
}

test('staging writes native rollout percentages to both feeds and preserves metadata', t => {
  const dir = fixture(t);
  for (const percent of ['0', '10', '50', '100']) {
    const result = run('release-stage', dir, percent);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['latest-mac.yml', 'latest.yml']) {
      const feed = parse(readFileSync(join(dir, name), 'utf8'));
      assert.equal(feed.stagingPercentage, Number(percent));
      assert.equal(feed.version, '2.1.3');
      assert.equal(feed.releaseNotes, 'keep this');
    }
  }
});
test('invalid rollout percentages fail before either feed changes', t => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, 'latest-mac.yml'), 'utf8');
  for (const percent of ['', '-1', '101', '10.5', 'NaN', '1e1', ' ']) {
    assert.notEqual(run('release-stage', dir, percent).status, 0);
    assert.equal(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'), before);
  }
});
test('staging rejects missing or mismatched Windows feeds without changing mac', t => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, 'latest-mac.yml'), 'utf8');
  writeFileSync(join(dir, 'latest.yml'), 'version: 2.1.0\n');
  assert.notEqual(run('release-stage', dir, '10').status, 0);
  rmSync(join(dir, 'latest.yml'));
  assert.notEqual(run('release-stage', dir, '10').status, 0);
  assert.equal(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'), before);
});
test('staging preserves file order, hashes and comments', t => {
  const dir = fixture(t);
  const file = join(dir, 'latest-mac.yml');
  const text = "version: 2.1.3\n# architecture order\nfiles:\n  - url: BOS-Bot-2.1.3-x64.zip\n    sha512: fixture-hash-x64\n  - url: BOS-Bot-2.1.3-arm64.zip\n    sha512: fixture-hash-arm64\nreleaseNotes: |\n  first line\n  second line\n";
  writeFileSync(file, text);
  assert.equal(run('release-stage', dir, '10').status, 0);
  const updated = readFileSync(file, 'utf8');
  assert.ok(updated.includes('# architecture order'));
  assert.deepEqual(parse(updated).files, parse(text).files);
  assert.equal(parse(updated).releaseNotes, parse(text).releaseNotes);
});
test('malformed Windows YAML cannot partially stage mac', t => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, 'latest-mac.yml'), 'utf8');
  writeFileSync(join(dir, 'latest.yml'), 'version: 2.1.3\nfiles: [broken\n');
  assert.notEqual(run('release-stage', dir, '10').status, 0);
  assert.equal(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'), before);
});
test('publish guard accepts matching Windows and mac artifacts', t => {
  const dir = fixture(t);
  assert.equal(run('release-publish-guard', dir, '2.1.3').status, 0);
});
test('publish guard refuses stale feed versions, duplicate version keys, or mismatched requested version', t => {
  const dir = fixture(t);
  assert.notEqual(run('release-publish-guard', dir, '2.1.2').status, 0);
  for (const text of ['version: 2.1.0\n', 'version: 2.1.3\nversion: 2.1.0\n', 'version: 2.1.3-beta.1\n']) {
    writeFileSync(join(dir, 'latest.yml'), text);
    assert.notEqual(run('release-publish-guard', dir, '2.1.3').status, 0);
  }
});
test('publish guard refuses absent or empty Windows installers', t => {
  const dir = fixture(t);
  const installer = join(dir, 'BOS-Bot-2.1.3-setup.exe');
  rmSync(installer);
  assert.notEqual(run('release-publish-guard', dir, '2.1.3').status, 0);
  writeFileSync(installer, '');
  assert.notEqual(run('release-publish-guard', dir, '2.1.3').status, 0);
});
test('all desktop publication paths invoke the same guard before publication', () => {
  for (const [path, publication] of [
    ['.github/workflows/release.yml', 'gh release edit "v$VERSION"'],
    ['.github/workflows/sync-published-release.yml', 'gh release edit "$TAG" --repo milind-soni/openmausbot-releases'],
  ]) {
    const workflow = parse(readFileSync(path, 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const publish = steps.findIndex(step => step.run?.includes(publication));
    assert.ok(publish >= 0, path);
    const guard = steps.findIndex(step => step.run?.includes('node scripts/release-publish-guard.mjs assets'));
    assert.ok(guard >= 0 && guard <= publish, `${path}: guard runs before publish`);
    assert.ok(steps.slice(0, guard).some(step => step.uses?.startsWith('actions/checkout@')), `${path}: guard source checked out`);
  }
});
