#!/usr/bin/env node
// Evidence gate only: never installs, publishes, restarts or contacts a live app.
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function validate(m,base='.'){
 const errors=[]; const need=(ok,message)=>{if(!ok)errors.push(message);};
 const mode=m.mode ?? 'controlled-alpha';
 const privatePilot=mode==='private-pilot';
 need(mode==='controlled-alpha'||privatePilot,'mode: expected controlled-alpha or explicit private-pilot');
 need(/^[a-f0-9]{40}$/.test(m.source?.commit??'')&&m.source?.clean===true,'source: immutable full commit and clean tree required');
 need(m.identity?.staging&&m.identity?.live&&m.identity.staging!==m.identity.live,'identity: distinct staging and live app identities required');
 if(privatePilot){
  need(m.channel?.name==='private-pilot'&&m.channel?.ownerVerified===true&&typeof m.channel?.owner==='string'&&m.channel.owner.trim()&&m.channel?.distribution==='local-install','channel: private-pilot local-install distribution and verified owner required');
  for(const platform of ['windows','android']) need(m.platforms?.[platform]?.supported===false,`${platform}: private-pilot must explicitly declare unsupported`);
 }else{
  need(m.channel?.name==='controlled-alpha'&&m.channel?.ownerVerified===true&&m.channel?.endpoint?.startsWith('https://'),'channel: controlled-alpha ownership and HTTPS endpoint evidence required');
 }
 const evidence=(value,label)=>need(typeof value==='string'&&value.length>0&&existsSync(resolve(base,value)),`${label}: existing evidence file required`);
 evidence(m.source?.evidence,'source'); evidence(m.channel?.evidence,'channel');
 evidence(m.tests?.evidence,'tests');need(m.tests?.passed===true,'tests: passing result required');
 evidence(m.review?.evidence,'independent review');need(m.review?.approved===true,'independent review: approved required');
 for(const platform of privatePilot ? ['macos','ios'] : ['macos','ios','windows','android']){
  const p=m.platforms?.[platform];
  need(p?.sourceCommit===m.source?.commit&&p?.sourceCommit,`${platform}: artifact source must match candidate`);
  need(p?.built===true,`${platform}: build unverified`);
  evidence(p?.buildEvidence,`${platform} build`);evidence(p?.signingEvidence,`${platform} signing`);
  need(typeof p?.version==='string'&&p.version.trim(),`${platform}: version missing`);
  if(typeof p?.artifact==='string'&&existsSync(resolve(base,p.artifact))){
   const actual=createHash('sha256').update(readFileSync(resolve(base,p.artifact))).digest('hex');
   need(actual===p.sha256,`${platform}: artifact SHA-256 mismatch`);
  }else errors.push(`${platform}: artifact missing`);
  need(p?.installed===true&&p?.deviceVerified===true,`${platform}: installed/device verification pending`);
  evidence(p?.deviceEvidence,`${platform} device`);
 }
 evidence(m.recovery?.checkpoint,'recovery checkpoint'); evidence(m.recovery?.rollback,'rollback');
 need(typeof m.recovery?.owner==='string'&&m.recovery.owner.trim(),'recovery: single owner required');
 evidence(m.approval?.evidence,'candidate approval');
 return errors;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
 const file=resolve(process.argv[2]??'docs/releases/controlled-alpha.manifest.json');
 const m=JSON.parse(readFileSync(file,'utf8'));const gaps=validate(m,dirname(file));
 console.log(JSON.stringify({candidate:m.candidate,status:gaps.length?'blocked':'evidence-complete',gaps,notice:'Evidence checks do not authorize installation or publication; independently verify recorded claims.'},null,2));
 if(gaps.length)process.exitCode=1;
 }catch(e){console.error(e.message);process.exitCode=1;}
}
