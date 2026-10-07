import assert from 'node:assert/strict';
import {createServer,request as upstreamRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dispatchOTP} from './dispatch-otp.mjs';
const [server,statePath,out]=process.argv.slice(2),state=JSON.parse(readFileSync(statePath));
assert.ok(state.acceptance_hooks && new URL(state.url).hostname==='127.0.0.1');
let mode='normal';const sessions=new Map(),secret=randomUUID(),pending=new Set();
const proxy=createServer(async(req,res)=>{
 try {
  let body='';for await(const b of req)body+=b;
  if(req.url.startsWith('/__check/')) {
   assert.equal(req.headers['x-check-secret'],secret);
   const data=JSON.parse(body||'{}');
   if(req.url==='/__check/otp-slot'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({at_ms:Date.now()}));return;}
   if(req.url==='/__check/mode'){assert.ok(['normal','5xx','stall','timeout'].includes(data.mode));mode=data.mode;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({mode}));return;}
   if(req.url==='/__check/revoke'){const bearer=sessions.get(data.email);assert.ok(bearer);const r=await fetch(state.issuer_url+'/api/auth/sign-out',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json',origin:'http://127.0.0.1:5199'},body:'{}'});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());return;}
   res.writeHead(404);res.end();return;
  }
  if(req.url==='/v1/me'&&mode!=='normal'){
   if(mode==='5xx'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"injected_issuer_failure"}');return;}
   pending.add(res);res.on('close',()=>pending.delete(res));return;
  }
  const headers={};for(const [k,v]of Object.entries(req.headers))if(!['host','connection','content-length'].includes(k)&&v)headers[k]=v;
  // Preserve native request metadata. fetch() synthesizes Sec-Fetch-Mode: cors,
  // which correctly activates Better Auth's browser-origin CSRF validation.
  const forward=()=>new Promise((resolve,reject)=>{const up=upstreamRequest(state.issuer_url+req.url,{method:req.method,headers},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));response.on('error',reject);});up.on('error',reject);up.end(body||undefined);});
  const r=await (req.url==='/api/auth/email-otp/send-verification-otp'?dispatchOTP(statePath,forward):forward());
  appendFileSync(out+'.wire.jsonl',JSON.stringify({at:new Date().toISOString(),path:req.url.split('?')[0],method:req.method,has_origin:!!req.headers.origin,fetch_mode:req.headers['sec-fetch-mode']??null,status:r.status})+'\n',{mode:0o600});
  if(req.url==='/api/auth/sign-in/email-otp'&&r.status===200){const email=JSON.parse(body).email,bearer=r.headers['set-auth-token'];if(bearer)sessions.set(email,bearer);}
  const responseHeaders={};for(const[k,v]of Object.entries(r.headers))if(!['connection','transfer-encoding'].includes(k))responseHeaders[k]=v;
  res.writeHead(r.status,responseHeaders);res.end(r.body);
 }catch{if(!res.headersSent)res.writeHead(500);res.end();}
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const issuer='http://127.0.0.1:'+proxy.address().port;
const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const room='http://127.0.0.1:'+allocator.address().port;await new Promise(r=>allocator.close(r));
const child=spawn(process.execPath,['--experimental-strip-types','services/cloud/app.ts'],{cwd:server,env:{...process.env,CLOUD_DATABASE_URL:state.database_url,CLOUD_ISSUER_URL:issuer,CLOUD_SERVICE_URL:room,CLOUD_ALLOWED_ORIGINS:'http://127.0.0.1:5199'},stdio:['ignore','pipe','pipe']});
let ready=false;child.stdout.on('data',()=>ready=true);child.stderr.on('data',()=>{});
for(let i=0;!ready&&i<100;i++){assert.equal(child.exitCode,null);await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
writeFileSync(out,JSON.stringify({issuer_url:issuer,url:room,ws_url:room.replace('http:','ws:')+'/v2/realtime',secret,pid:process.pid,app_pid:child.pid}),{flag:'wx',mode:0o600});
console.log(JSON.stringify({issuer_url:issuer,url:room,pid:process.pid,app_pid:child.pid}));
let stopping=false;for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{if(stopping)return;stopping=true;for(const r of pending)r.destroy();const exited=new Promise(r=>child.exitCode!==null?r():child.once('exit',r));child.kill('SIGTERM');await exited;proxy.closeAllConnections();await new Promise(r=>proxy.close(r));process.exit(0);});
