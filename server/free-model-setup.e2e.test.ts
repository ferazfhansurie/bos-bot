// Real HTTP boundary with a disposable home and synthetic provider responses.
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SessionRegistry } from './sessions.ts';
import { removeTempDir, waitForExit } from './testing/cleanup.ts';
import { freePortBlock } from './testing/ports.ts';
const serverDir=dirname(fileURLToPath(import.meta.url));
let home:string,dataDir:string,base:string,clientToken:string,adminToken:string,adminSessionId:string,child:ChildProcess,stderr='';
const endpoint='/api/onboarding/free-model';
const key='synthetic-free-key-canary';
async function api(method:string,path:string,body?:unknown,headers:Record<string,string>={}){
 const response=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 return {status:response.status,body:await response.json() as any};
}
const saved=()=>JSON.parse(readFileSync(join(dataDir,'config.json'),'utf8'));
const freeInstance=(body:any)=>body.instances.find((x:any)=>x.instanceId==='bos-free');
beforeAll(async()=>{
 home=mkdtempSync(join(tmpdir(),'bos-free-setup-'));dataDir=join(home,'.bos-fixture');mkdirSync(dataDir);
 const cli=join(home,'fixture-claude.mjs');
 writeFileSync(cli,`#!/usr/bin/env node
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
process.env.FAKE_CLAUDE_MODE='hang';process.env.FAKE_CLAUDE_DUMP=${JSON.stringify(join(home,'claude-spawn.json'))};
await import(${JSON.stringify(pathToFileURL(join(serverDir,'testing/fake-claude-cli.ts')).href)});
`,{mode:0o755});
 writeFileSync(join(dataDir,'config.json'),JSON.stringify({instances:{ghost:{driver:'not-a-real-driver',displayName:'Keep sibling'},codex:{driver:'not-a-real-driver'},claude:{driver:'claudeAgent',config:{cli}}}}));
 const sessions=new SessionRegistry({file:join(dataDir,'sessions.json')});const paired=sessions.exchange({code:sessions.openPairing({scopes:['client']}).code,label:'read-only fixture',source:'fixture'});if(!paired.ok)throw Error('pair failed');clientToken=paired.token;
 const admin=sessions.exchange({code:sessions.openPairing({scopes:['admin','client']}).code,label:'revocation fixture',source:'fixture'});if(!admin.ok)throw Error('admin pair failed');adminToken=admin.token;adminSessionId=admin.session.id;
 const prelude=join(home,'offline.mjs');writeFileSync(prelude,`
import {existsSync,writeFileSync} from 'node:fs';
const root=${JSON.stringify(home)};
globalThis.fetch=async(url,init={})=>{
 const path=String(url);const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
 if(path==='https://openrouter.ai/api/v1/key'){
  const auth=init.headers?.Authorization;
  if(auth==='Bearer slow-fixture'||auth==='Bearer revoked-fixture'){writeFileSync(root+'/auth-waiting','yes');while(!existsSync(root+'/auth-release'))await new Promise(r=>setTimeout(r,10));}
  return auth==='Bearer bad-fixture'?json({error:'synthetic-private-response'},401):json({data:{limit_remaining:0}});
 }
 if(path==='https://openrouter.ai/api/v1/models')return json({data:[{id:'openrouter/free',pricing:{prompt:existsSync(root+'/catalog-bad')?'1':'0',completion:'0'},supported_parameters:['tools']}]});
 if(path==='https://openrouter.ai/api/v1/chat/completions'){
  writeFileSync(root+'/free-turn-active','yes');
  return await new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('Fixture aborted','AbortError'));if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});});
 }
 return json({error:'offline fixture'},503);
};`);
 const port=await freePortBlock([0,1]);base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,['--import',pathToFileURL(prelude).href,join(serverDir,'index.ts')],{cwd:join(serverDir,'..'),env:{PATH:process.env.PATH,...(process.env.PATHEXT?{PATHEXT:process.env.PATHEXT}:{}),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),HOME:home,USERPROFILE:home,OMB_DATA_DIR:dataDir,OMB_PORT:String(port),OMB_WEBHOOK_PORT:String(port+1)},stdio:['ignore','pipe','pipe']});
 child.stdout?.resume();child.stderr?.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);});
 const deadline=Date.now()+20000;
 for(;;){if(child.exitCode!==null)throw Error(stderr);try{if((await api('GET','/api/health')).body.pid===child.pid)break;}catch{}if(Date.now()>deadline)throw Error('fixture start timeout: '+stderr);await new Promise(resolve=>setTimeout(resolve,100));}
},30000);
afterAll(async()=>{if(child)await waitForExit(child,{signal:'SIGTERM'});if(home)await removeTempDir(home);});
it('requires admin and JSON, validates key without leaking provider failures',async()=>{
 expect((await api('POST',endpoint,{key},{authorization:`Bearer ${clientToken}`})).status).toBe(403);
 expect((await api('POST',endpoint,{key},{origin:'https://untrusted.example.invalid'})).status).toBe(403);
 expect((await api('POST',endpoint,{key},{'content-type':'text/plain'})).status).toBe(415);
 for(const value of ['', 'bad-fixture']){const result=await api('POST',endpoint,{key:value});expect(result.status).toBe(400);expect(JSON.stringify(result.body)).not.toContain('synthetic-private-response');}
 expect(saved().instances['bos-free']).toBeUndefined();
});
it('persists only the free instance; does not expose credentials in public responses',async()=>{
 const before=saved().instances;const result=await api('POST',endpoint,{key});expect(result.status,JSON.stringify(result.body)).toBe(200);
 expect(freeInstance(result.body)).toMatchObject({driverKind:'openrouter-free',snapshot:{state:'available'}});
 const after=saved().instances;for(const id of Object.keys(before))expect(after[id]).toEqual(before[id]);
 expect(after['bos-free'].config).toEqual({key,model:'openrouter/free'});
 for(const path of ['/api/instances','/api/config'])expect(JSON.stringify((await api('GET',path)).body)).not.toContain(key);
 expect(JSON.stringify(result.body)).not.toContain(key);expect(stderr).not.toContain(key);
});
it('reports unavailable rather than ready when catalog becomes paid',async()=>{
 writeFileSync(join(home,'catalog-bad'),'yes');
 try{const result=await api('POST',endpoint,{key});expect(result.status).toBe(200);expect(freeInstance(result.body).snapshot.state).toBe('unavailable');expect(freeInstance(result.body).models.options).toEqual([]);}finally{unlinkSync(join(home,'catalog-bad'));}
 expect((await api('POST',endpoint,{key})).status).toBe(200);
});
it('serializes a delayed request body against a provider update already verifying',async()=>{
 const made=await api('POST','/api/bots',{name:'Fixture during reconnect',modelSelection:{instanceId:'bos-free',model:'openrouter/free'},requireAvailableModel:true});expect(made.status).toBe(201);
 let settle!:(value:{status:number,body:string})=>void;const firstResult=new Promise<{status:number,body:string}>(resolve=>{settle=resolve;});
 const first=request(base+endpoint,{method:'POST',headers:{'content-type':'application/json'}},response=>{let body='';response.on('data',c=>body+=c);response.on('end',()=>settle({status:response.statusCode!,body}));});
 first.write('{"key":');
 const second=api('POST',endpoint,{key:'slow-fixture'});
 try{
  await expect.poll(()=>existsSync(join(home,'auth-waiting')),{timeout:5000}).toBe(true);
  expect((await api('POST',`/api/bots/${made.body.bot.id}/messages`,{text:'must wait for reconnect'})).status).toBe(409);
  first.end('"another-fixture"}');const early=await firstResult;expect(early.status,early.body).toBe(409);
 }finally{first.destroy();writeFileSync(join(home,'auth-release'),'yes');}
 expect((await second).status).toBe(200);expect(saved().instances['bos-free'].config.key).toBe('slow-fixture');
});
it('does not persist credentials if the initiating admin is revoked during verification',async()=>{
 for(const name of ['auth-waiting','auth-release'])if(existsSync(join(home,name)))unlinkSync(join(home,name));
 const before=saved().instances;
 const pending=api('POST',endpoint,{key:'revoked-fixture'},{authorization:`Bearer ${adminToken}`});
 try{
  await expect.poll(()=>existsSync(join(home,'auth-waiting')),{timeout:5000}).toBe(true);
  expect((await api('DELETE',`/api/auth/sessions/${adminSessionId}`)).status).toBe(200);
 }finally{writeFileSync(join(home,'auth-release'),'yes');}
 const result=await pending;
 expect(result.status,JSON.stringify(result.body)).toBe(401);
 expect(saved().instances).toEqual(before);
 // The rejected request releases its provider lock and keeps the old runtime usable.
 expect((await api('POST',endpoint,{key})).status).toBe(200);
 expect(JSON.stringify(result.body)).not.toContain('revoked-fixture');
});
it('preserves a running sibling task and refuses replacement of an active free task',async()=>{
 const add=async(instanceId:string,model:string)=>(await api('POST','/api/bots',{name:`Fixture ${instanceId}`,modelSelection:{instanceId,model},requireAvailableModel:true}));
 const other=await add('claude','claude-sonnet-5');expect(other.status,JSON.stringify(other.body)).toBe(201);const bot=other.body.bot;
 expect((await api('POST',`/api/bots/${bot.id}/messages`,{text:'remain active'})).status).toBe(202);
 await expect.poll(()=>existsSync(join(home,'claude-spawn.json'))).toBe(true);const pid=JSON.parse(readFileSync(join(home,'claude-spawn.json'),'utf8')).pid;
 let freeBot:any;
 try{
  expect((await api('POST',endpoint,{key})).status).toBe(200);
  expect((await api('GET','/api/bots')).body.bots.find((x:any)=>x.id===bot.id).busy).toBe(true);expect(()=>process.kill(pid,0)).not.toThrow();
  expect(JSON.parse(readFileSync(join(home,'claude-spawn.json'),'utf8')).pid).toBe(pid);
  const free=await add('bos-free','openrouter/free');expect(free.status,JSON.stringify(free.body)).toBe(201);freeBot=free.body.bot;
  expect((await api('POST',`/api/bots/${freeBot.id}/messages`,{text:'synthetic free turn'})).status).toBe(202);
  await expect.poll(()=>existsSync(join(home,'free-turn-active'))).toBe(true);
  expect((await api('POST',endpoint,{key:'replacement-fixture'})).status).toBe(409);expect(saved().instances['bos-free'].config.key).toBe(key);
 }finally{if(freeBot)await api('POST',`/api/bots/${freeBot.id}/interrupt`,{});await api('POST',`/api/bots/${bot.id}/interrupt`,{});}
},20000);
