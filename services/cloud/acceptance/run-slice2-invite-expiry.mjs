import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {connectFixture,pause,until} from './slice2-fixture-client.mjs';
const [server,state,evidence]=process.argv.slice(2),c=await connectFixture(server,state,evidence);
try {
const h=await c.humans('invite_expiry_lock'),expiryActor=await c.actor('invite_expiry');
for(const order of ['admission-before-expiry','expiry-before-admission'])for(let i=0;i<100;i++){
 const x=expiryActor,inv=await c.ok(`/v2/workspaces/${h.w}/invites`,h.a,'POST',{role:'guest',room_ids:[h.r.room_id]});
 // Independent expected access is journaled before any redemption.
 c.record({type:'invite_intent',order,iteration:i,workspace_id:h.w,actor_id:x.account_id,invite_id:inv.invite_id,expected_member:order==='admission-before-expiry',role:'guest'});
 if(order==='admission-before-expiry'){
 const gate=await c.gate('http.publication.before_admission',{workspace_id:h.w,account_id:x.account_id}),pending=c.request('/v2/invites/redeem',x,'POST',{token:inv.token});pending.catch(()=>{});try{await gate.waitUntilReached();assert.equal((await c.admin.query('SELECT role FROM cloud.members WHERE workspace_id=$1 AND account_id=$2',[h.w,x.account_id])).rows[0].role,'guest');c.record({type:'membership_committed_before_expiry_response_held',workspace_id:h.w,account_id:x.account_id});await c.admin.query("UPDATE cloud.invites SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND invite_id=$2",[h.w,inv.invite_id]);await gate.release();assert.equal((await pending).status,200);}finally{await gate.cleanup();await pending.catch(()=>{});}
 }else{
 const blockerPid=(await c.admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;await c.admin.query('BEGIN');let pending;try{await c.admin.query('SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1 FOR UPDATE',[h.w]);await c.admin.query("UPDATE cloud.invites SET expires_at=clock_timestamp()+interval '120 milliseconds' WHERE workspace_id=$1 AND invite_id=$2",[h.w,inv.invite_id]);pending=c.request('/v2/invites/redeem',x,'POST',{token:inv.token});pending.catch(()=>{});await until(async()=>Number((await c.app.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='cloud_app' AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[blockerPid])).rows[0].count)>0,'invite real authority lock wait');await pause(140);await c.admin.query('COMMIT');const r=await pending;assert.equal(r.data.error,'invite_expired');}catch(e){await c.admin.query('ROLLBACK');await pending?.catch(()=>{});throw e;}
 }
 const members=(await c.admin.query('SELECT role FROM cloud.members WHERE workspace_id=$1 AND account_id=$2',[h.w,x.account_id])).rows;assert.deepEqual(members,order==='admission-before-expiry'?[{role:'guest'}]:[]);assert.equal((await c.request('/v2/invites/redeem',x,'POST',{token:inv.token})).status,403);const discovery=await c.ok('/v2/discovery/sync',x);assert.equal(discovery.workspaces.some(w=>w.workspace_id===h.w),order==='admission-before-expiry');if(order==='admission-before-expiry')assert.equal((await c.request(`/v2/workspaces/${h.w}/members/${x.account_id}`,h.a,'DELETE')).status,200);
 c.record({type:'race',name:'a16-invite-expiry',order,iteration:i,state:'passed'});
}
c.record({type:'case_complete',name:'a16-invite-expiry',state:'passed',races:200});writeFileSync(evidence+'/summary.json',JSON.stringify({source:c.source,results:[{name:'a16-invite-expiry',state:'passed',races:200}]},null,2)+'\n',{flag:'wx',mode:0o600});console.log('a16-invite-expiry 200/200 passed');
}catch(e){console.error(e);process.exitCode=1;}finally{await c.close();}
