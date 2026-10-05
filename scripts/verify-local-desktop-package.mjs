// Read-only candidate checks. Never launches, installs or restamps an app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoArg, appArg, commit] = process.argv.slice(2);
assert.ok(repoArg && appArg, 'usage: node verifier.mjs REPO APP FINAL_COMMIT');
assert.match(commit ?? '', /^[a-f0-9]{40}$/);
const repo = resolve(repoArg), app = resolve(appArg);
assert.notEqual(app, '/Applications/BOS Bot.app');
const resources = join(app, 'Contents/Resources');
const run = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(run('git', ['-C', repo, 'rev-parse', 'HEAD']).trim(), commit);
assert.equal(run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no']).trim(), '');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(join(repo, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const asar = builderRequire('@electron/asar');
const archive = join(resources, 'app.asar');
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString());
const expectedVersion = json(join(repo, 'package.json')).version;
assert.equal(pkg.version, expectedVersion);
assert.equal(pkg.bosSourceCommit, commit);
assert.equal(pkg.bosChannel, 'live');
assert.equal(pkg.bosUpdatePolicy.mode, 'offline');
const sourceChecks = ['electron/main.mjs', 'electron/preload.cjs', 'electron/tools-browser.mjs', 'electron/native-contract.mjs', 'electron/vendor/update-yaml.cjs'].map(p => {
  const bytes = asar.extractFile(archive, p);
  assert.ok(bytes.equals(readFileSync(join(repo, p))), `archive differs: ${p}`);
  return { path: p, sha256: sha(bytes) };
});
const required = ['ui/index.html', 'server/index.js', 'companion', 'skills', 'licenses', 'cua-driver', 'cua-sdk/cua-sdk.mjs', 'cua-sdk/native/libcua_driver_sdk.dylib', 'cua-sdk/native/cua_driver_node_runtime.node', 'cloudflared/cloudflared', 'browser-engine/manifest.json', 'android-platform-tools/darwin/adb', 'OpenMausBot Speech.app/Contents/MacOS/speech-helper', 'updater/preflight.py', 'updater/no-downgrade.py'];
for (const p of required) statSync(join(resources, p));
for (const p of ['cua-driver', 'cloudflared/cloudflared', 'android-platform-tools/darwin/adb', 'OpenMausBot Speech.app/Contents/MacOS/speech-helper']) assert.ok(statSync(join(resources, p)).mode & 0o111, `not executable: ${p}`);
function treeDigest(name) {
  const root = join(resources, name), files = [];
  function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } }
  walk(root);
  const hash = createHash('sha256');
  for (const p of files.sort((a,b) => relative(root,a) < relative(root,b) ? -1 : 1)) { hash.update(relative(root,p)); hash.update(readFileSync(p)); }
  return hash.digest('hex');
}
const stamp = json(join(resources, 'build-commit.json'));
assert.equal(stamp.commit, commit);
assert.equal(stamp.server_sha256, treeDigest('server'));
assert.equal(stamp.ui_sha256, treeDigest('ui'));
assert.equal(stamp.native_contract_sha256, sha(readFileSync(join(resources, 'native-contract.json'))));
const { assertNativeCompatibility } = await import(pathToFileURL(join(repo, 'electron/native-contract.mjs')).href);
const native = assertNativeCompatibility(resources, repo, commit);
assert.equal(native.shellCommit, commit);
const authority = 'Apple Development: Firaz Fhansurie (KL78M575FW)';
const identities = [];
for (const [candidate, installed] of [[app, '/Applications/BOS Bot.app'], [join(resources, 'OpenMausBot Speech.app'), '/Applications/BOS Bot.app/Contents/Resources/OpenMausBot Speech.app']]) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
  // codesign writes descriptions and designated requirements to stderr.
  const details = spawnSync('/usr/bin/codesign', ['-d', '-r-', '--verbose=4', candidate], { encoding: 'utf8' });
  assert.equal(details.status, 0);
  assert.ok(details.stderr.includes(`Authority=${authority}`));
  assert.ok(details.stderr.includes('TeamIdentifier=6LH87G88CQ'));
  const old = spawnSync('/usr/bin/codesign', ['-d', '-r-', installed], { encoding: 'utf8' });
  assert.equal(old.status, 0);
  const requirement = old.stderr.match(/^designated => (.+)$/m)?.[1];
  assert.ok(requirement, 'installed designated requirement unavailable');
  run('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, candidate]);
  identities.push({ candidate, matchesInstalledRequirement: true });
}
assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(app, 'Contents/Info.plist')]).trim(), 'ai.bos.bot');
assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).trim(), expectedVersion);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), app, commit, sourceChecks, stamp, native, identities, package: 'verified', installation: 'not performed', appAcceptance: 'pending' }, null, 2));
