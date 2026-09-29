import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
test('BOS Linux fixture and packaged identity match including spaced install paths',()=>{
 const builder=parse(readFileSync('electron-builder.yml','utf8'));
 const pkg=JSON.parse(readFileSync('package.json'));
 assert.equal(pkg.desktopName,'ai.bos.bot.desktop');
 assert.equal(builder.linux.desktop.entry.Name,'BOS Bot');
 const hook=readFileSync('build/linux-after-install.sh','utf8');
 assert.ok(hook.includes('APP_ROOT="/opt/BOS Bot"'));
 const policy=readFileSync('build/linux-openmausbot-browser.apparmor','utf8');
 assert.ok(policy.includes('profile bos-bot-browser "/opt/BOS Bot/resources/browser-engine/'));
 const remove=readFileSync('build/linux-after-remove.sh','utf8');
 assert.ok(remove.includes('--remove bos-bot "/opt/BOS Bot/bos-bot"'));
 const verify=readFileSync('scripts/verify-linux-package.mjs','utf8');
 for(const expected of ['Package: bos-bot','ai.bos.bot.desktop','Icon=bos-bot','StartupWMClass=ai.bos.bot','Exec=\\"/opt/BOS Bot/bos-bot\\" %U']) assert.ok(verify.includes(expected),expected);
 assert.ok(!readFileSync('.github/workflows/release.yml','utf8').includes('Block pending BOS'));
});
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacyBosFixture } from './linux-upgrade-fixture.mjs';
test('synthetic BOS upgrade reproduces unsafe ancestors without installing a package',()=>{
 const root=mkdtempSync(join(tmpdir(),'bos-upgrade-fixture-'));
 try {
  const fixture=createLegacyBosFixture(root);
  assert.equal(statSync(fixture.appRoot).mode & 0o777,0o775);
  assert.equal(statSync(fixture.resources).mode & 0o777,0o775);
  assert.match(readFileSync(join(fixture.controlRoot,'control'),'utf8'),/^Package: bos-bot\n/);
  assert.equal(readFileSync(join(fixture.resources,'legacy-upgrade-fixture'),'utf8'),'0.1.7\n');
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('staging DEB hooks and exact AppArmor attachment never use live installation paths',()=>{
 const stage=parse(readFileSync('electron-builder.staging.yml','utf8'));
 assert.equal(stage.deb.afterInstall,'build/linux-after-install.staging.sh');
 assert.equal(stage.deb.afterRemove,'build/linux-after-remove.staging.sh');
 for(const hook of [stage.deb.afterInstall,stage.deb.afterRemove]) {
  const text=readFileSync(hook,'utf8');
  assert.ok(text.includes('/opt/BOS Staging'));
  assert.ok(!text.includes('/opt/BOS Bot'));
  assert.ok(!text.includes('bos-bot-browser') && !text.includes('/usr/bin/bos-bot'));
 }
 const profile=stage.linux.extraResources.find(r=>r.to==='bos-staging-browser.apparmor');
 assert.ok(profile);
 const text=readFileSync(profile.from,'utf8');
 assert.ok(text.includes('profile bos-staging-browser "/opt/BOS Staging/resources/'));
 assert.ok(!text.includes('/opt/BOS Bot'));
 assert.equal(stage.linux.extraResources.length,parse(readFileSync('electron-builder.yml','utf8')).linux.extraResources.length);
});
test('staging hooks preserve every live safety check through exact identity substitution',()=>{
 for(const name of ['linux-after-install','linux-after-remove']) {
  const live=readFileSync(`build/${name}.sh`,'utf8');
  const stage=readFileSync(`build/${name}.staging.sh`,'utf8');
  assert.equal(stage,live.replaceAll('/opt/BOS Bot','/opt/BOS Staging').replaceAll('bos-bot','bos-staging'));
 }
});
