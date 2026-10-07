import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const [serverArg,outArg,derivedArg,simulator,previousOwner]=process.argv.slice(2);
const server=resolve(serverArg),out=resolve(outArg),derived=resolve(derivedArg);
const nativeOnly=previousOwner==='--native-only';
assert.ok(simulator && !out.startsWith(server+'/'));
mkdirSync(out,{mode:0o700});
const children=new Set(),results=[];
const save=(name,value)=>writeFileSync(out+'/'+name,JSON.stringify(value,null,2)+'\n',{mode:0o600});
function launch(name,command,args,options={}) {
 const fd=openSync(out+'/'+name+'.private.log','wx',0o600);
 const p=spawn(command,args,{cwd:server,env:process.env,stdio:['ignore',fd,fd],...options});closeSync(fd);children.add(p);
 p.done=new Promise((r,j)=>{p.on('error',j);p.on('exit',(code,signal)=>{children.delete(p);r({name,code,signal});});});
 return p;
}
async function stop(p){if(p && p.exitCode===null && !p.signalCode){p.kill('SIGTERM');await p.done;}}
let fixture,proxy,state;
async function cleanup(){for(const p of [...children])if(p!==fixture && p!==proxy)await stop(p);await stop(proxy);await stop(fixture);save('cleanup.json',{at:new Date().toISOString(),owned_children_remaining:children.size,state_removed:state?!existsSync(state.state_path):null});}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>cleanup().then(()=>process.exit(130)));
async function wait(fn,p,label){for(let n=0;n<1200;n++){const v=fn();if(v)return v;assert.equal(p.exitCode,null,label+' exited');await new Promise(r=>setTimeout(r,100));}throw new Error(label+' startup deadline');}
try {
 fixture=launch('fixture',process.execPath,['--experimental-strip-types','services/cloud/local.ts','--acceptance-hooks']);
 state=await wait(()=>{const lines=readFileSync(out+'/fixture.private.log','utf8').trim().split('\n');for(const l of lines){try{const s=JSON.parse(l);if(s.state_path)return s;}catch{}}},fixture,'fixture');
 save('state-pointer.private.json',{state_path:state.state_path});
 const hooks=await fetch(state.url+'/v2/test/hooks',{headers:{'X-Cloud-Fixture-Secret':state.hook_secret}});
 const stub=await fetch(state.url+'/v2/test/sign-in',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 assert.equal(hooks.status,200);assert.equal(stub.status,404);
 save('preflight.json',{at:new Date().toISOString(),room:state.url,issuer:state.issuer_url,acceptance_hooks:state.acceptance_hooks,hooks_status:hooks.status,stub_status:stub.status,simulator});
 console.log('owned fixture preflight passed');
 const targetPath=out+'/fault-target.private.json';
 proxy=launch('fault-target',process.execPath,['services/cloud/acceptance/launch-slice2-fault-target.mjs',server,state.state_path,targetPath]);
 const target=await wait(()=>existsSync(targetPath)?JSON.parse(readFileSync(targetPath)):null,proxy,'proxy');
 const jobs=[
  ...(!nativeOnly?[
  launch('guest',process.execPath,['services/cloud/acceptance/run-slice2-security.mjs',server,state.state_path,out+'/guest','a13-a07-revocation-races','--roles=guest']),
  launch('invites',process.execPath,['services/cloud/acceptance/run-slice2-security.mjs',server,state.state_path,out+'/invites','a16-invite-races']),
  launch('expiry',process.execPath,['services/cloud/acceptance/run-slice2-invite-expiry.mjs',server,state.state_path,out+'/expiry']),
  ...(!previousOwner?[launch('owner-orphan',process.execPath,['services/cloud/acceptance/run-slice2-owner-orphan.mjs',server,state.state_path,out+'/owner-orphan'])]:[]),
  ]:[]),
  launch('native','xcodebuild',['test-without-building','-project','OpenMausCompanion.xcodeproj','-scheme','OpenMausCompanion','-destination','id='+simulator,'-derivedDataPath',derived,'-only-testing:OpenMausCompanionUITests/CloudRoomsLiveUITests/testRevokedAndUnavailableStates','-parallel-testing-enabled','NO','-resultBundlePath',out+'/native.xcresult'],{cwd:server+'/ios',env:{...process.env,TEST_RUNNER_CLOUD_ISSUER_URL:target.issuer_url,TEST_RUNNER_CLOUD_ROOMS_URL:target.url,TEST_RUNNER_CLOUD_CHECK_SECRET:target.secret}})
 ];
 if(previousOwner && !nativeOnly){const owner=JSON.parse(readFileSync(previousOwner+'/owner-orphan/summary.json'));assert.ok(owner.results.every(x=>x.state==='passed'));save('previous-owner.json',{path:previousOwner,results:owner.results});}
 await Promise.all(jobs.map(async p=>{const r=await p.done;results.push(r);save('job-results.json',results);console.log(JSON.stringify(r));}));
 assert.ok(results.every(r=>r.code===0),'unfinished gate failed; see private logs');
 save('runner-summary.json',{at:new Date().toISOString(),results});
}catch(e){console.error(e.message);process.exitCode=1;}finally{await cleanup();}
