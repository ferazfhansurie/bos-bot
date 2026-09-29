import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validatePackaged, signingPrerequisites } from './release-contract.mjs';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
const config = parse(readFileSync('electron-builder.yml', 'utf8'));
test('live identity and feed are BOS owned', () => validateConfig(config, 'live'));
test('upstream feed, staging identity, wrong output fail', () => {
  for (const patch of [{publish:[{provider:'github',owner:'milind-soni',repo:'OpenMausBot'}]}, {appId:'ai.bos.bot.staging'}, {directories:{output:'release-staging'}}]) assert.throws(() => validateConfig({...config,...patch}, 'live'));
});
test('staging has no update feed', () => { const s = parse(readFileSync('electron-builder.staging.yml','utf8')); validateConfig({...config,...s},'staging'); assert.throws(() => validateConfig({...config,...s,publish:config.publish},'staging')); });
test('production signing fails closed without secrets', () => { assert.throws(() => signingPrerequisites('win',{})); assert.throws(() => signingPrerequisites('mac',{})); signingPrerequisites('win',{WIN_CSC_LINK:'supplied',WIN_CSC_KEY_PASSWORD:'supplied',BOS_WINDOWS_PUBLISHER:'stable subject'}); });
test('packaged channel, commit and feed parity', () => {
 const p={name:'bos-bot',bosChannel:'live',bosSourceCommit:'a'.repeat(40)};
 const feed={provider:'github',owner:'firazfhansurie',repo:'bos-bot'};
 validatePackaged(p,feed,'live','a'.repeat(40));
 assert.throws(()=>validatePackaged({...p,bosSourceCommit:'b'.repeat(40)},feed,'live','a'.repeat(40)));
 assert.throws(()=>validatePackaged(p,{...feed,repo:'OpenMausBot'},'live','a'.repeat(40)));
 assert.throws(()=>validatePackaged({...p,bosChannel:'staging'},feed,'live','a'.repeat(40)));
 validatePackaged({...p,name:'bos-staging',bosChannel:'staging'},null,'staging','a'.repeat(40));
 assert.throws(()=>validatePackaged({...p,name:'bos-staging',bosChannel:'staging'},feed,'staging','a'.repeat(40)));
});
test('release workflow is manual BOS-only with explicit live packaging and installed Linux acceptance', () => {
 const workflow=parse(readFileSync('.github/workflows/release.yml','utf8'));
 assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
 const text=readFileSync('.github/workflows/release.yml','utf8');
 assert.ok(!text.includes('milind-soni') && !text.includes('RELEASES_PAT'));
 for(const platform of ['mac','win','linux']) assert.ok(text.includes(`pnpm package:${platform}:live`));
 assert.ok(text.includes('Reproduce and verify an in-place DEB upgrade'));
 assert.ok(!text.includes('Block pending BOS installed Linux acceptance'));
 assert.ok(text.includes('Get-AuthenticodeSignature'));
 assert.ok(text.includes('manifest.sha, process.env.SHA'));
});
