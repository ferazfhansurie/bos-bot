/** Owned throwaway PG + wrangler local D1. No production configuration or secrets. */
import { spawn } from 'node:child_process';
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { realFixture } from './fixture.ts';
const cp = resolve(new URL('../../cloudflare/control-plane/',import.meta.url).pathname);
// Use the worker package's declared pin. A root/symlinked older binary can
// silently run a workerd that cannot honor the frozen compatibility date.
const requiredWrangler = JSON.parse(await readFile(resolve(cp,'package.json'),'utf8')).devDependencies.wrangler;
let installedWrangler: string | undefined;
try { installedWrangler = JSON.parse(await readFile(resolve(cp,'node_modules/wrangler/package.json'),'utf8')).version; } catch {}
if(requiredWrangler!=='4.125.0'||installedWrangler!==requiredWrangler)
  throw new Error('local issuer requires control-plane Wrangler 4.125.0; restore its pinned workspace dependencies');
const root = await mkdtemp(resolve(tmpdir(),'bos-slice2-'));
const wrangler = resolve(cp,'node_modules/wrangler/bin/wrangler.js');
const net = createServer();
await new Promise<void>(r=>net.listen(0,'127.0.0.1',r));
const port = (net.address() as any).port;
await new Promise<void>(r=>net.close(()=>r()));
const issuer = 'http://127.0.0.1:'+port;
const origins = process.env.CLOUD_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5199';
let worker: ReturnType<typeof spawn>|undefined;
let fixture: Awaited<ReturnType<typeof realFixture>>|undefined;
let migrating: ReturnType<typeof spawn>|undefined;
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
  if(stopping)return;stopping=true;void cleanup().then(()=>process.exit(0));
});
async function run(args: string[]) {
  const child=spawn(process.execPath,[wrangler,...args],{cwd:cp,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  migrating=child;
  let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
  const code=await new Promise<number|null>((r,j)=>{child.on('exit',r);child.on('error',j);});
  migrating=undefined;
  if(code!==0) throw new Error('local d1 migration failed: '+logs);
}
async function cleanup() {
  if(migrating){const p=migrating;migrating=undefined;const exited=new Promise<void>(r=>p.exitCode!==null?r():p.once('exit',()=>r()));p.kill('SIGTERM');await exited;}
  if(fixture){await fixture.stop();fixture=undefined;}
  if(worker){const p=worker;worker=undefined;const exited=new Promise<void>(r=>p.exitCode!==null?r():p.once('exit',()=>r()));p.kill('SIGTERM');await exited;}
  await rm(root,{recursive:true,force:true});
}
try {
  // Share the launch budget between migration and worker startup, leaving
  // time for PostgreSQL before the caller's existing 40-second readiness gate.
  const startupDeadline=Date.now()+35000;
  // One local D1 execution preserves migration order without paying Wrangler's
  // process/workerd startup cost once for each file in this throwaway database.
  const names=['0001_better_auth_1_7_1.sql','0002_installations.sql','0003_otp_recipient_rate_limits.sql','0004_managed_companion_endpoints.sql','0005_endpoint_cleanup_backoff.sql'];
  const sql=await Promise.all(names.map(name=>readFile(resolve(cp,'migrations',name),'utf8')));
  const migrationFile=resolve(root,'migrations.sql');
  await writeFile(migrationFile,sql.join('\n'),{mode:0o600});
  await run(['d1','execute','bos-slice2-local','--local','--config','wrangler.local.jsonc','--persist-to',root+'/d1','--file',migrationFile]);
  worker=spawn(process.execPath,[wrangler,'dev','--local','--config','wrangler.local.jsonc','--persist-to',root+'/d1','--ip','127.0.0.1','--port',String(port),'--var','BETTER_AUTH_URL:'+issuer,'--var','ALLOWED_ORIGINS:'+origins],{cwd:cp,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  let logs='';worker.stdout!.on('data',v=>logs+=v);worker.stderr!.on('data',v=>logs+=v);
  worker.on('error',()=>{});
  let ready=false;
  while(Date.now()<startupDeadline) {
    if(worker.exitCode!==null) throw new Error('local issuer exited: '+logs);
    try {const r=await fetch(issuer+'/healthz',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}} catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!ready) throw new Error('local issuer startup timed out: '+logs);
  fixture=await realFixture(issuer,process.argv.includes('--acceptance-hooks'));
  const state={...Object.fromEntries(Object.entries(fixture).filter(([key])=>!['service','issuer','hooks','app','stop'].includes(key))),issuer_url:issuer,otp_url:issuer+'/__dev/otp',local_d1_directory:root+'/d1',issuer_pid:worker.pid,state_path:root+'/state.json',acceptance_hooks:process.argv.includes('--acceptance-hooks')};
  await writeFile(root+'/state.json',JSON.stringify(state,null,2),{mode:0o600});
  console.log(JSON.stringify(state));

} catch(e) {await cleanup();throw e;}
