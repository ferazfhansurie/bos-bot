import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('local real OTP issuer: cookie/native room chat, primary session logout, socket cutoff and immediate PG removal', {timeout:120000}, async()=>{
 const child=spawn(process.execPath,['--experimental-strip-types',new URL('../local.ts',import.meta.url).pathname],{stdio:['ignore','pipe','pipe']});
 let logs='';let state:any;
 child.stdout.on('data',v=>{logs+=v;for(const line of logs.split('\n')){try{const s=JSON.parse(line);if(s.issuer_url)state=s;}catch{}}});
 child.stderr.on('data',v=>logs+=v);
 const sockets: WebSocket[]=[];
 try {
   for(let n=0;!state&&n<400;n++){if(child.exitCode!==null)throw new Error('local launcher failed: '+logs);await pause(100);}
   assert.ok(state,'local launcher did not become ready');
   const issuer=state.issuer_url,service=state.url,origin='http://127.0.0.1:5199';
   async function call(base:string,path:string,method='GET',body?:unknown,headers:Record<string,string>={}) {
     const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
     return {status:response.status,headers:response.headers,body:await response.json() as any};
   }
   async function signin(email:string){
     const sent=await call(issuer,'/api/auth/email-otp/send-verification-otp','POST',{email,type:'sign-in'},{origin});assert.equal(sent.status,200);
     const sink=await call(issuer,'/__dev/otp?email='+encodeURIComponent(email));assert.equal(sink.status,200);assert.equal(sink.body.type,'sign-in');
     const signed=await call(issuer,'/api/auth/sign-in/email-otp','POST',{email,otp:sink.body.otp},{origin});assert.equal(signed.status,200);
     const bearer=signed.headers.get('set-auth-token')!;assert.ok(bearer);
     const cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
     return {bearer,cookie};
   }
   const alice=await signin('alice@example.test'),bob=await signin('bob@example.test');
   const web={cookie:alice.cookie,origin},native={authorization:'Bearer '+bob.bearer};
   const a=await call(service,'/v2/me','GET',undefined,web),b=await call(service,'/v2/me','GET',undefined,native);
   assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.body.issuer,issuer);assert.notEqual(a.body.subject,b.body.subject);
   assert.equal((await call(service,'/v2/test/sign-in','POST',{subject:'fictional_alice'})).status,404);
   assert.equal((await call(issuer,'/__dev/otp?email=alice@example.test','GET',undefined,{origin})).status,403);
   assert.equal((await call(issuer,'/api/auth/email-otp/send-verification-otp','POST',{email:'not-fictional@example.com',type:'sign-in'},{origin})).status,400);
   assert.equal((await call(service,'/v2/workspaces','POST',{name:'csrf'}, {cookie:alice.cookie})).status,403);
   const w=(await call(service,'/v2/workspaces','POST',{name:'fictional slice 2'},web)).body.workspace_id;assert.ok(w);
   const room=(await call(service,`/v2/workspaces/${w}/rooms`,'POST',{name:'fictional room'},web)).body;assert.ok(room.room_id);
   const invite=await call(service,`/v2/workspaces/${w}/invites`,'POST',{role:'member',room_ids:[room.room_id]},web);assert.equal(invite.status,200);
   assert.equal((await call(service,'/v2/invites/redeem','POST',{token:invite.body.token},native)).status,200);
   const snapshot=(await call(service,`/v2/workspaces/${w}/rooms/${room.room_id}/snapshot`,'POST',{thread_id:room.thread_id},web)).body;
   const windowA=(await call(service,`/v2/workspaces/${w}/operation-windows`,'POST',{},web)).body;
   const windowB=(await call(service,`/v2/workspaces/${w}/operation-windows`,'POST',{},native)).body;
   const messages:any[]=[];
   const ws=new WebSocket(state.ws_url,{headers:{cookie:alice.cookie,origin}});sockets.push(ws);
   ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
   await new Promise<void>((r,j)=>{ws.once('open',r);ws.once('error',j);});
   ws.send(JSON.stringify({type:'authenticate'}));
   for(let n=0;!messages.some(v=>v.type==='heartbeat')&&n<50;n++)await pause(100);
   assert.ok(messages.some(v=>v.type==='heartbeat'),'cookie websocket authentication failed');
   ws.send(JSON.stringify({type:'subscribe',workspace_id:w,room_id:room.room_id,thread_id:room.thread_id,cursor:null}));
   for(let n=0;!messages.some(v=>v.type==='reset_required'||v.type==='event_batch')&&n<50;n++)await pause(100);
   assert.ok(messages.some(v=>v.type==='reset_required'||v.type==='event_batch'),'initial live projection missing');
   async function send(headers:Record<string,string>,window:any,text:string){
      const e={kind:'message.send',namespace:window.namespace,client_operation_id:window.window_id+'.'+randomBytes(18).toString('base64url'),window_token:window.window_token,room_id:room.room_id,thread_id:room.thread_id,text,mentions:[],attachment_ids:[],reply_to_message_id:null,expected_policy_revision:snapshot.policy_revision};
      return call(service,`/v2/workspaces/${w}/messages`,'POST',e,headers);
   }
   const sentA=await send(web,windowA,'fictional cookie hello');assert.equal(sentA.status,200);assert.equal(sentA.body.status,'accepted');
   const sentB=await send(native,windowB,'fictional native hello');assert.equal(sentB.status,200);assert.equal(sentB.body.status,'accepted');
   for(let n=0;!messages.some(v=>v.events?.some((e:any)=>e.kind==='message.created'))&&n<50;n++)await pause(100);
   assert.ok(messages.some(v=>v.events?.some((e:any)=>e.kind==='message.created')),'live room publication missing');
   let closedAt=0;ws.once('close',()=>closedAt=Date.now());
   const logoutAt=Date.now();
   assert.equal((await call(issuer,'/api/auth/sign-out','POST',{}, {cookie:alice.cookie,origin})).status,200);
   const revoked=await send(web,windowA,'must be refused');assert.equal(revoked.status,401);assert.equal(revoked.body.error,'session_invalid');
   const writeCutoff=Date.now()-logoutAt;assert.ok(writeCutoff<=15000);
   assert.equal((await call(service,'/v2/me','GET',undefined,{authorization:'Bearer '+alice.bearer})).status,401);
   for(let n=0;!closedAt&&n<150;n++)await pause(100);
   assert.ok(closedAt&&closedAt-logoutAt<=15000,'revoked socket exceeded deadline');
   // A newly issued session restores identity but cannot restore removed PG membership.
   const aliceAgain=await signin('alice@example.test');const owner={cookie:aliceAgain.cookie,origin};
   const restored=await call(service,'/v2/me','GET',undefined,owner);assert.equal(restored.body.account_id,a.body.account_id);
   assert.equal((await call(service,`/v2/workspaces/${w}/members/${b.body.account_id}`,'DELETE',undefined,owner)).status,200);
   const removed=await send(native,windowB,'must be removed immediately');assert.equal(removed.status,403);
   assert.equal((await call(service,'/v2/discovery/sync','GET',undefined,native)).body.workspaces.length,0);
   const bobAgain=await signin('bob@example.test');const restoredNative={authorization:'Bearer '+bobAgain.bearer};
   assert.equal((await call(service,'/v2/me','GET',undefined,restoredNative)).body.account_id,b.body.account_id);
   assert.equal((await call(service,'/v2/me','GET',undefined,{authorization:'Bearer '+alice.bearer})).status,401);
   const noRestore=await call(service,`/v2/workspaces/${w}/operation-windows`,'POST',{},restoredNative);assert.equal(noRestore.status,403);
   console.log(JSON.stringify({proof:'real-local-issuer',logout_write_cutoff_ms:writeCutoff,socket_cutoff_ms:closedAt-logoutAt,pg_removal:'immediate',stub_signin:404,fictional_only:true}));
 } finally {
   for(const ws of sockets)ws.terminate();
   if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}
   if(state) {
     await assert.rejects(access(state.fixture_directory));
     await assert.rejects(access(state.local_d1_directory));
   }
 }
});
