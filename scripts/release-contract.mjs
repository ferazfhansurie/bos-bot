import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
export function validateConfig(c, channel) {
 assert.ok(['live','staging'].includes(channel));
 assert.equal(c.appId, channel === 'live' ? 'ai.bos.bot' : 'ai.bos.bot.staging');
 assert.equal(c.productName, channel === 'live' ? 'BOS Bot' : 'BOS Staging');
 assert.equal(c.directories.output, channel === 'live' ? 'release' : 'release-staging');
 assert.equal(c.artifactName, channel === 'live' ? 'BOS-Bot-${version}-${arch}.${ext}' : 'BOS-Staging-${version}-${arch}.${ext}');
 assert.equal(c.protocols?.[0]?.schemes?.[0], channel === 'live' ? 'bosbot' : 'bosbot-staging');
 assert.equal(c.nsis.artifactName, channel === 'live' ? 'BOS-Bot-${version}-setup.${ext}' : 'BOS-Staging-${version}-setup.${ext}');
 assert.equal(c.dmg.artifactName, channel === 'live' ? 'BOS-Bot-${version}-${arch}.dmg' : 'BOS-Staging-${version}-${arch}.dmg');
 if(channel === 'staging') assert.equal(c.publish,null);
 else assert.deepEqual(c.publish,[{provider:'github',owner:'firazfhansurie',repo:'bos-bot'}]);
}
export function signingPrerequisites(platform, env) {
 const required = platform === 'win' ? ['WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','BOS_WINDOWS_PUBLISHER'] : platform === 'mac' ? ['MAC_CERT_P12_BASE64','MAC_CERT_PASSWORD','APPLE_API_KEY_P8_BASE64','APPLE_API_KEY_ID','APPLE_API_ISSUER_ID'] : [];
 for(const key of required) assert.ok(env[key]?.trim(), `missing release signing prerequisite: ${key}`);
}
export function validatePackaged(pkg, feed, channel, sha) {
 assert.match(sha,/^[a-f0-9]{40}$/);
 assert.equal(pkg.bosSourceCommit,sha,'packaged source commit mismatch');
 assert.equal(pkg.bosChannel,channel);
 assert.equal(pkg.name,channel === 'live' ? 'bos-bot' : 'bos-staging');
 if(channel === 'staging') assert.equal(feed,null,'staging must have no updater');
 else { for(const [k,v] of Object.entries({provider:'github',owner:'firazfhansurie',repo:'bos-bot'})) assert.equal(feed?.[k],v); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const [command,channel,platform,arg] = process.argv.slice(2);
 const base=parse(readFileSync('electron-builder.yml','utf8'));
 const c=channel === 'staging' ? {...base,...parse(readFileSync('electron-builder.staging.yml','utf8'))} : base;
 validateConfig(c,channel);
 if(channel === 'live') assert.match(JSON.parse(readFileSync('package.json','utf8')).version,/^\d+\.\d+\.\d+$/, 'stable release requires a stable semantic version');
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(command === 'check') { if(channel === 'live') { signingPrerequisites(platform,process.env); assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','live packaging requires a clean source commit'); } }
 else if(command === 'package') {
  if(channel === 'live') { signingPrerequisites(platform,process.env); assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','live packaging requires a clean source commit'); }
  const result=spawnSync('pnpm',['exec','electron-builder','--config',channel === 'live' ? 'electron-builder.live.cjs' : 'electron-builder.staging.yml',`--${platform}`,'--publish','never',`--config.extraMetadata.bosSourceCommit=${sha}`],{stdio:'inherit',env:{...process.env,...(channel === 'live' && platform === 'win' ? {CSC_LINK:process.env.WIN_CSC_LINK,CSC_KEY_PASSWORD:process.env.WIN_CSC_KEY_PASSWORD} : {})}});
  process.exit(result.status ?? 1);
 } else if(command === 'packaged') {
  const res=arg;
  const require=createRequire(import.meta.url);
  const builderRequire=createRequire(require.resolve('electron-builder'));
  const asar=JSON.parse(builderRequire('@electron/asar').extractFile(join(res,'app.asar'),'package.json').toString());
  const feedPath=join(res,'app-update.yml');
  const feed=existsSync(feedPath)?parse(readFileSync(feedPath,'utf8')):null;
  validatePackaged(asar,feed,channel,sha);
  if(platform === 'win' && channel === 'live') assert.deepEqual([].concat(feed.publisherName ?? []),[process.env.BOS_WINDOWS_PUBLISHER]);
  writeFileSync(join(c.directories.output,`release-contract-${platform}.json`),JSON.stringify({channel,sha,version:asar.version,appId:c.appId},null,2));
 } else throw new Error('use check|package|packaged channel platform [resources]');
 console.log(`release contract verified: ${command} ${channel} ${platform}`);
}
