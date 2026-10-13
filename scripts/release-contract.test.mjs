import { compatEnv } from "../electron/branding-env.cjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validatePackaged, signingPrerequisites, releaseSigning, releaseFeed, validateWindowsUpdateSigning, DEFAULT_FEED } from './release-contract.mjs';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const config = parse(readFileSync('electron-builder.yml', 'utf8'));
test('live identity and feed are BOS owned', () => validateConfig(config, 'live'));
test('upstream feed, staging identity, wrong output fail', () => {
  for (const patch of [{publish:[{provider:'github',owner:'milind-soni',repo:'BOS Bot'}]}, {appId:'ai.bos.bot.staging'}, {directories:{output:'release-staging'}}]) assert.throws(() => validateConfig({...config,...patch}, 'live'));
});
test('staging has no update feed', () => { const s = parse(readFileSync('electron-builder.staging.yml','utf8')); validateConfig({...config,...s},'staging'); assert.throws(() => validateConfig({...config,...s,publish:config.publish},'staging')); });
test('production signing fails closed without secrets', () => { assert.throws(() => signingPrerequisites('win',{})); assert.throws(() => signingPrerequisites('mac',{})); signingPrerequisites('win',{WIN_CSC_LINK:'supplied',WIN_CSC_KEY_PASSWORD:'supplied',BOS_WINDOWS_PUBLISHER:'stable subject'}); });
test('packaged channel, commit and feed parity', () => {
 const p={name:'bos-bot',bosChannel:'live',bosSourceCommit:'a'.repeat(40)};
 const feed={provider:'github',owner:'ferazfhansurie',repo:'bos-bot'};
 validatePackaged(p,feed,'live','a'.repeat(40));
 assert.throws(()=>validatePackaged({...p,bosSourceCommit:'b'.repeat(40)},feed,'live','a'.repeat(40)));
 assert.throws(()=>validatePackaged(p,{...feed,repo:'BOS Bot'},'live','a'.repeat(40)));
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

test('1.0 is a stable live version', () => {
 assert.match(JSON.parse(readFileSync('package.json','utf8')).version,/^\d+\.\d+\.\d+$/);
});
test('update feed defaults to the BOS repo and is configurable', () => {
 assert.deepEqual(releaseFeed({}),DEFAULT_FEED);
 assert.deepEqual(releaseFeed({BOS_UPDATE_FEED_URL:'',BOS_UPDATE_GITHUB_OWNER:' '}),DEFAULT_FEED);
 assert.deepEqual(releaseFeed({BOS_UPDATE_GITHUB_REPO:'bos-releases'}),{provider:'github',owner:'ferazfhansurie',repo:'bos-releases'});
 assert.deepEqual(releaseFeed({BOS_UPDATE_FEED_URL:'https://dl.example.com/bos/'}),{provider:'generic',url:'https://dl.example.com/bos'});
 for(const env of [{BOS_UPDATE_FEED_URL:'http://dl.example.com'},{BOS_UPDATE_FEED_URL:'https://u:p@dl.example.com'},{BOS_UPDATE_FEED_URL:'https://dl.example.com/?x=1'},{BOS_UPDATE_FEED_URL:'nope'},
  {BOS_UPDATE_FEED_URL:'https://dl.example.com',BOS_UPDATE_GITHUB_REPO:'r'},{BOS_UPDATE_GITHUB_OWNER:'a/b'}]) assert.throws(()=>releaseFeed(env));
});
test('windows may ship unsigned only when asked; everything else fails closed', () => {
 assert.equal(releaseSigning('win',{BOS_WINDOWS_SIGNING:'unsigned'}),'unsigned');
 assert.throws(()=>releaseSigning('win',{}));
 assert.throws(()=>releaseSigning('win',{BOS_WINDOWS_SIGNING:'signed'}));
 assert.throws(()=>releaseSigning('win',{BOS_WINDOWS_SIGNING:'maybe'}));
 assert.throws(()=>releaseSigning('mac',{BOS_WINDOWS_SIGNING:'unsigned'}));
 assert.throws(()=>releaseSigning('linux',{BOS_WINDOWS_SIGNING:'unsigned'}));
 assert.equal(releaseSigning('win',{WIN_CSC_LINK:'x',WIN_CSC_KEY_PASSWORD:'x',BOS_WINDOWS_PUBLISHER:'BOS'}),'signed');
 assert.equal(releaseSigning('linux',{}),'signed');
});
test('unsigned windows feed carries no publisherName; signed pins the publisher', () => {
 validateWindowsUpdateSigning({...DEFAULT_FEED},'unsigned');
 assert.throws(()=>validateWindowsUpdateSigning({...DEFAULT_FEED,publisherName:['BOS']},'unsigned'));
 validateWindowsUpdateSigning({...DEFAULT_FEED,publisherName:['BOS']},'signed','BOS');
 assert.throws(()=>validateWindowsUpdateSigning({...DEFAULT_FEED},'signed','BOS'));
});
test('packaged feed must match the configured feed', () => {
 const p={name:'bos-bot',bosChannel:'live',bosSourceCommit:'a'.repeat(40)};
 const generic={provider:'generic',url:'https://dl.example.com/bos'};
 validatePackaged(p,{...generic,updaterCacheDirName:'bos-bot-updater'},'live','a'.repeat(40),generic);
 assert.throws(()=>validatePackaged(p,DEFAULT_FEED,'live','a'.repeat(40),generic));
});
// The live config is what electron-builder actually merges. Evaluate it in a
// fresh process per environment (require caches the config module).
function liveConfig(env) {
 const probe=`const path=require('node:path');const {createRequire}=require('node:module');
const r=createRequire(require.resolve('electron-builder',{paths:[process.cwd()]}));
const {getConfig}=require(path.join(path.dirname(r.resolve('app-builder-lib')),'util/config/config.js'));
getConfig(process.cwd(),'electron-builder.live.cjs',null).then(c=>process.stdout.write('\\n'+JSON.stringify(c)));`;
 const out=execFileSync(process.execPath,['-e',probe],{encoding:'utf8',env:{PATH:compatEnv.PATH,...env}});
 return JSON.parse(out.slice(out.lastIndexOf('\n')+1));
}
test('live builder config: one feed, signed by default, unsigned windows skips update signature checks', () => {
 const base=parse(readFileSync('electron-builder.yml','utf8'));
 const signed=liveConfig({});
 validateConfig(signed,'live');
 assert.equal(signed.forceCodeSigning,true);
 assert.equal(signed.win.verifyUpdateCodeSignature,true);
 assert.deepEqual(signed.win.target,base.win.target);
 assert.deepEqual(signed.extraMetadata,{bosChannel:'live',name:'bos-bot',bosUpdatePolicy:{mode:'native',feed:{provider:'github',owner:'ferazfhansurie',repo:'bos-bot'}}});
 const unsigned=liveConfig({BOS_WINDOWS_SIGNING:'unsigned'});
 validateConfig(unsigned,'live');
 assert.equal(unsigned.forceCodeSigning,false);
 assert.equal(unsigned.win.verifyUpdateCodeSignature,false);
 assert.equal(unsigned.win.signtoolOptions,undefined);
 assert.deepEqual(unsigned.win.extraResources,base.win.extraResources);
 assert.deepEqual(liveConfig({BOS_UPDATE_FEED_URL:'https://dl.example.com/bos'}).publish,[{provider:'generic',url:'https://dl.example.com/bos'}]);
 assert.deepEqual(liveConfig({BOS_UPDATE_GITHUB_REPO:'bos-releases'}).publish,[{provider:'github',owner:'ferazfhansurie',repo:'bos-releases'}]);
});
test('release workflow builds the 1.0 windows installer unsigned unless configured', () => {
 const workflow=parse(readFileSync('.github/workflows/release.yml','utf8'));
 assert.equal(workflow.jobs.windows.env.BOS_WINDOWS_SIGNING,"${{ vars.BOS_WINDOWS_SIGNING || 'unsigned' }}");
 const authenticode=workflow.jobs.windows.steps.find(step=>step.name==='Verify Windows Authenticode trust and publisher');
 assert.equal(authenticode.if,"env.BOS_WINDOWS_SIGNING == 'signed'");
 for(const job of ['mac','linux']) assert.equal(workflow.jobs[job].env?.BOS_WINDOWS_SIGNING,undefined);
});
