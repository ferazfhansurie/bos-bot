import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('packaged staging overrides inherited live paths and separates all listeners', () => {
  const root = mkdtempSync(join(tmpdir(), 'bos-stage-test-'));
  try {
    mkdirSync(join(root, 'electron'));
    mkdirSync(join(root, 'node_modules/electron'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', bosChannel: 'staging' }));
    writeFileSync(join(root, 'node_modules/electron/package.json'), JSON.stringify({type:'module',exports:'./index.js'}));
    writeFileSync(join(root, 'node_modules/electron/index.js'), `export const app = { paths: { home: ${JSON.stringify(root)}, appData: ${JSON.stringify(root)} }, getPath(k) { return this.paths[k]; }, setPath(k,v) { this.paths[k]=v; }, setName(n) { this.name=n; }, setAppLogsPath(p) { this.paths.logs=p; } };`);
    for (const file of ['staging-bootstrap.mjs', 'release-channel.mjs', 'package-link.mjs']) copyFileSync(new URL(file, import.meta.url), join(root,'electron',file));
    const script = `import './electron/staging-bootstrap.mjs'; import {app} from 'electron'; import * as p from './electron/release-channel.mjs'; import {packageUrlFromDeepLink} from './electron/package-link.mjs'; console.log(JSON.stringify({ paths: app.paths, name: app.name, data:process.env.OMB_DATA_DIR, companion:process.env.OMB_COMPANION_DIR, migration:process.env.OMB_DISABLE_LEGACY_MIGRATION, webhook:process.env.OMB_WEBHOOK_PORT, ports:p.SERVER_PORTS, relay:p.RELAY_PORTS, control:p.CONTROL_PORT, phone:p.COMPANION_PORT, liveLink:packageUrlFromDeepLink('openmausbot://install?url=https://github.com/a/b.md'), stageLink:packageUrlFromDeepLink('bosbot-staging://install?url=https://github.com/a/b.md')}));`;
    writeFileSync(join(root,'test.mjs'),script);
    const result = JSON.parse(execFileSync(process.execPath,[join(root,'test.mjs')],{env:{...process.env,OMB_DATA_DIR:'/live',OMB_COMPANION_DIR:'/live-phone',OMB_WEBHOOK_PORT:'8800'},encoding:'utf8'}));
    assert.equal(result.data,join(root,'.bos-bot-staging'));
    assert.equal(result.companion,join(root,'.bos-bot-staging/companion'));
    assert.equal(result.paths.userData,join(root,'BOS Staging'));
    assert.equal(result.paths.sessionData,result.paths.userData);
    assert.equal(result.name,'BOS Staging');
    assert.equal(result.migration,'1'); assert.equal(result.webhook,undefined);
    assert.deepEqual(result.ports,[38799,48799,58799]);
    assert.deepEqual(result.relay,[38798,48798,58798]);
    assert.equal(result.control,38811); assert.equal(result.phone,38810);
    assert.equal(result.liveLink,null); assert.equal(result.stageLink,'https://github.com/a/b.md');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('provider child home and secrets do not inherit live state', async () => {
  const { stagingServerEnvironment } = await import('./staging-environment.mjs');
  const root=mkdtempSync(join(tmpdir(),'bos-provider-test-'));
  try {
    const env=stagingServerEnvironment({HOME:'/real',CODEX_HOME:'/real/codex',ANTHROPIC_API_KEY:'sentinel',OMB_PORT:'8799',PATH:'/bin'},root);
    assert.equal(env.HOME,join(root,'provider-home'));
    assert.equal(env.CODEX_HOME,join(root,'provider-home/.codex'));
    assert.equal(env.ANTHROPIC_API_KEY,undefined);
    assert.equal(env.OMB_PORT,undefined);
    assert.equal(env.PATH,'/bin');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('staging file saves accept own files and reject live files', async () => {
  const { resolveSavablePath }=await import('./save-file.mjs');
  const root=mkdtempSync(join(tmpdir(),'bos-save-test-'));
  try {
    const dataDir=join(root,'stage');mkdirSync(dataDir);
    const own=join(dataDir,'own.txt'),live=join(root,'live.txt');
    writeFileSync(own,'stage');writeFileSync(live,'live');
    assert.equal(await resolveSavablePath(own,{home:root,dataDir}),realpathSync(own));
    await assert.rejects(resolveSavablePath(live,{home:root,dataDir}),/Only files/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
