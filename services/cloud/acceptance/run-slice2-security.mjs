import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {connectFixture,pause,until} from './slice2-fixture-client.mjs';
import {bothOrders} from './schedules.mjs';
import {digest} from './oracle.mjs';
const [server,state,evidence,...selected]=process.argv.slice(2);
const c=await connectFixture(server,state,evidence),results=[];
const root=h=>`/v2/workspaces/${h.w}`,room=h=>`${root(h)}/rooms/${h.r.room_id}`;
async function scenario(name,fn){if(selected.length&&!selected.includes(name))return;const start=performance.now();c.record({type:'case_start',name});try{await fn();const r={name,state:'passed',duration_ms:performance.now()-start};results.push(r);c.record({type:'case_complete',...r});console.log(JSON.stringify(r));}catch(e){c.record({type:'case_complete',name,state:'failed',error:e.message});throw e;}}
const send=(p,mode='submit')=>p.driver.operation(p.operations[0].id,{mode});
try {
await scenario('a04-changed-envelope-races',async()=>{
 for(const mode of ['submit','seal'])await bothOrders({name:'a04-changed-'+mode,record:c.record,
 prepare:async({order,iteration})=>{const h=await c.humans('changed'),p=await c.plan(h,`changed-${mode}-${order}-${iteration}-first`,1,{expected:order==='first-before-second'?'accepted':'conflict'}),q=await c.plan(h,`changed-${mode}-${order}-${iteration}-second`,1,{expected:order==='second-before-first'?(mode==='seal'?'rejected':'accepted'):'conflict',change:e=>Object.assign(e,p.operations[0].envelope,{text:'fictional competing envelope'})});let gate;return{h,p,q,pauseBeforeAdmission:async side=>gate=await c.gate((side==='second'&&mode==='seal'?'operation.seal':'message.send')+'.before_admission',{workspace_id:h.w,account_id:h.a.account_id,client_operation_id:p.operations[0].id,digest:digest((side==='first'?p:q).operations[0].envelope)}),cleanup:async()=>{if(gate)await gate.cleanup();}};},
 first:f=>send(f.p),second:f=>send(f.q,mode),inspect:async({fixture:f,order,resultA,resultB})=>{assert.equal(resultA.status,order==='first-before-second'?'accepted':mode==='seal'?'rejected':'accepted');assert.equal(resultB.error,'operation_conflict');assert.equal(resultB.http_status,409);const winner=order==='first-before-second'?f.p:f.q,loser=order==='first-before-second'?f.q:f.p;assert.equal((await send(loser)).error,'operation_conflict');await c.verify(f.h,[winner]);c.record({type:'conflict_retained',id:loser.operations[0].id,digest:digest(loser.operations[0].envelope)});}});
});
await scenario('a04-expiry-lock-races',async()=>{
 for(const mode of ['submit','seal'])for(const order of ['admission-before-expiry','expiry-before-admission'])for(let i=0;i<100;i++){
  const h=await c.humans('expiry'),p=await c.plan(h,`expiry-${mode}-${order}-${i}`,1,{expected:order==='admission-before-expiry'&&mode==='submit'?'accepted':'rejected'});
  if(order==='admission-before-expiry'){const r=await send(p,mode);assert.equal(r.status,mode==='submit'?'accepted':'rejected');await c.hooks('expire-window',{workspace_id:h.w,account_id:h.a.account_id,window_id:p.win.window_id});assert.deepEqual(await send(p,mode),r);}
  else {await c.hooks('expire-window',{workspace_id:h.w,account_id:h.a.account_id,window_id:p.win.window_id,after_ms:250});const gate=await c.gate('read.after_admission',{workspace_id:h.w,account_id:h.a.account_id});const blocker=c.request(room(h)+'/read',h.a,'POST',{thread_id:h.r.thread_id,intervals:[]});await gate.waitUntilReached();const pending=send(p,mode);pending.catch(()=>{});try{await until(async()=>Number((await c.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='cloud_app' AND wait_event_type='Lock'")).rows[0].count)>0,'actual admission row lock wait');await pause(260);await gate.release();assert.equal((await blocker).status,200);const r=await pending;assert.equal(r.status,'rejected');assert.equal(r.reason,'operation_expired');}finally{await gate.cleanup();await pending.catch(()=>{});}}
  await c.verify(h,[p]);c.record({type:'race',name:'a04-expiry-'+mode,order,iteration:i,state:'passed'});
 }
});
await scenario('a13-a07-revocation-races',async()=>{
 for(const role of ['member','guest'])for(const action of ['message.send','read','replay','snapshot.page','http.publication','realtime.publication'])await bothOrders({name:'a13-'+role+'-'+action,record:c.record,
 prepare:async({order,iteration})=>{
 const h=await c.humans('revocation',role),p=await c.plan(h,`revoke-${role}-${action}-${order}-${iteration}`,1,{actor:action==='message.send'?h.b:h.a,expected:action==='message.send'&&order==='first-before-second'?'denied':'accepted'});
 if(action!=='message.send')assert.equal((await send(p)).status,'accepted');const s=await c.snapshot(h);let gate,socket;
 if(action==='realtime.publication')socket=await c.socket(h.b);
 return{h,p,s,socket,pauseBeforeAdmission:async side=>gate=await c.gate((side==='first'?'member.remove':action)+'.before_admission',{workspace_id:h.w,account_id:side==='first'?h.a.account_id:h.b.account_id,...(side==='first'?{target_id:h.b.account_id}:{})}),cleanup:async()=>{if(gate)await gate.cleanup();socket?.ws.terminate();}};
 },first:f=>c.request(root(f.h)+'/members/'+f.h.b.account_id,f.h.a,'DELETE'),second:async f=>{
 if(action==='message.send')return send(f.p);
 if(action==='read')return c.request(room(f.h)+'/read',f.h.b,'POST',{thread_id:f.h.r.thread_id,intervals:[]});
 if(action==='replay')return c.request(room(f.h)+'/replay',f.h.b,'POST',{thread_id:f.h.r.thread_id,cursor:f.s.cursor,snapshot_id:f.s.snapshot_id});
 if(action==='snapshot.page')return c.request(room(f.h)+'/snapshots/'+f.s.snapshot_id,f.h.b);
 if(action==='http.publication')return c.request(room(f.h)+'/history?thread_id='+f.h.r.thread_id,f.h.b);
 f.socket.subscribe(f.h);await until(()=>f.socket.code!==null||f.socket.frames.some(v=>v.type==='reset_required'&&v.snapshot),'publication or denied socket');return {status:f.socket.frames.some(v=>v.type==='reset_required'&&v.snapshot)?200:403};
 },inspect:async({fixture:f,order,resultA,resultB})=>{
 const protectedResult=order==='first-before-second'?resultB:resultA,removed=order==='first-before-second'?resultA:resultB;assert.equal(removed.status,200);
 if(action==='message.send'){assert.equal(protectedResult[order==='first-before-second'?'http_status':'status'],order==='first-before-second'?403:'accepted');const rows=(await c.admin.query('SELECT text,actor_id,client_operation_id FROM cloud.messages WHERE workspace_id=$1',[f.h.w])).rows;assert.equal(rows.length,order==='first-before-second'?0:1);if(rows.length){assert.equal(rows[0].text,f.p.operations[0].envelope.text);assert.equal(rows[0].actor_id,f.h.b.account_id);}}
 else {assert.equal(protectedResult.status,order==='first-before-second'?403:200);await c.verify(f.h,[f.p],f.h.a);}
 assert.equal((await c.request(room(f.h)+'/snapshot',f.h.b,'POST',{thread_id:f.h.r.thread_id})).status,403);const discovery=await c.ok('/v2/discovery/sync',f.h.b);assert.ok(!discovery.workspaces.some(w=>w.workspace_id===f.h.w));assert.equal((await c.admin.query('SELECT 1 FROM cloud.members WHERE workspace_id=$1 AND account_id=$2',[f.h.w,f.h.b.account_id])).rowCount,0);
 }});
});
await scenario('a16-invite-races',async()=>{
 for(const kind of ['redeem-revoke','double-redeem'])await bothOrders({name:'a16-'+kind,record:c.record,
 prepare:async()=>{const h=await c.humans('invite'),x=await c.actor('invite_x'),y=await c.actor('invite_y'),inv=await c.ok(root(h)+'/invites',h.a,'POST',{role:'guest',room_ids:[h.r.room_id]});let gate;return{h,x,y,inv,pauseBeforeAdmission:async side=>gate=await c.gate((kind==='redeem-revoke'&&side==='second'?'invite.revoke':'invite.redeem')+'.before_admission',{workspace_id:h.w,account_id:side==='first'?x.account_id:kind==='redeem-revoke'?h.a.account_id:y.account_id,...(kind==='redeem-revoke'&&side==='second'?{invite_id:inv.invite_id}:{token_hash:createHash('sha256').update(inv.token).digest('hex')})}),cleanup:async()=>{if(gate)await gate.cleanup();}};},
 first:f=>c.request('/v2/invites/redeem',f.x,'POST',{token:f.inv.token}),second:f=>kind==='redeem-revoke'?c.request(root(f.h)+'/invites/'+f.inv.invite_id,f.h.a,'DELETE'):c.request('/v2/invites/redeem',f.y,'POST',{token:f.inv.token}),
 inspect:async({fixture:f,order,resultA,resultB})=>{assert.equal(resultA.status,200);const rows=(await c.admin.query('SELECT account_id,role FROM cloud.members WHERE workspace_id=$1 AND account_id=ANY($2::text[])',[f.h.w,[f.x.account_id,f.y.account_id]])).rows;if(kind==='double-redeem'){assert.equal(resultB.data.error,'invite_used');assert.deepEqual(rows,[{account_id:order==='first-before-second'?f.x.account_id:f.y.account_id,role:'guest'}]);}else{const redeem=order==='first-before-second'?resultA:resultB;assert.equal(redeem.status,order==='first-before-second'?200:403);if(order==='second-before-first')assert.equal(redeem.data.error,'invite_revoked');assert.equal(rows.length,order==='first-before-second'?1:0);}assert.equal((await c.request('/v2/invites/redeem',f.y,'POST',{token:f.inv.token})).status,403);}
 });
 const h=await c.humans('invite_expiry'),x=await c.actor('expired'),inv=await c.ok(root(h)+'/invites',h.a,'POST',{role:'owner',room_ids:[h.r.room_id],expires_in_seconds:1});await pause(1100);for(const route of ['preview','redeem']){const r=await c.request('/v2/invites/'+route,x,'POST',{token:inv.token});assert.equal(r.data.error,'invite_expired');}assert.equal((await c.admin.query('SELECT 1 FROM cloud.members WHERE workspace_id=$1 AND account_id=$2',[h.w,x.account_id])).rowCount,0);
});
writeFileSync(evidence+'/summary.json',JSON.stringify({source:c.source,results},null,2)+'\n',{flag:'wx',mode:0o600});
}catch(e){console.error(e);process.exitCode=1;}finally{await c.close();}
