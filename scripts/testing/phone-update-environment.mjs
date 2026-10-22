// Real isolated HTTP fixture using the verification launcher environment.
// The longer readiness budget accommodates concurrent native lane builds.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,openSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {verificationServerEnvironment} from '../control-omb.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const data=mkdtempSync(join(tmpdir(),'bos213-env-fixture-'));
const logPath=join(tmpdir(),'bos213-environment-server.log');
let child;
try {
  mkdirSync(join(data,'tmp'));
  writeFileSync(join(data,'config.json'),JSON.stringify({instances:{claude:{driver:'claudeAgent',displayName:'Fixture',config:{cli:join(root,'server/testing/fake-claude-cli.ts')}}}}));
  const probe=createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const log=openSync(logPath,'w',0o600);
  child=spawn(process.execPath,['--experimental-strip-types',join(root,'server/index.ts')],{cwd:root,env:verificationServerEnvironment({BOS_WELCOME_STUB:'1'},data,port),stdio:['ignore',log,log]}); closeSync(log);
  const url=`http://127.0.0.1:${port}`;
  const deadline=Date.now()+120_000;
  while(true){
    assert.equal(child.exitCode,null,'fixture exited before readiness; '+logPath);
    try{const health=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});if(health.ok)break;}catch{}
    assert.ok(Date.now()<deadline,'fixture timeout; '+logPath);await new Promise(r=>setTimeout(r,200));
  }
  const res=await fetch(url+'/.well-known/openmausbot/environment'); assert.equal(res.status,200);const body=await res.json();
  assert.equal(body.minPhoneVersion,'2.1.3');assert.equal(body.phoneUpdateUrls.ios,'https://bosbot.my/get');assert.equal(body.phoneUpdateUrls.android,'https://bosbot.my/updates/android.json');
  console.log(JSON.stringify({checks:4,url,pid:child.pid,minPhoneVersion:body.minPhoneVersion,phoneUpdateUrls:body.phoneUpdateUrls,logPath}));
} finally {
  if(child && child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}
  rmSync(data,{recursive:true,force:true});
}
