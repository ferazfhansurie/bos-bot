import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {connectFixture} from './fixture-client.mjs';
const [server,state,evidence]=process.argv.slice(2),c=await connectFixture(server,state,evidence);
try{
const h=await c.humans('boundaries'),outside=await c.actor('outside'),plans=[];
for(const [name,reason,change] of [
 ['policy','policy_changed',e=>e.expected_policy_revision='999'],
 ['bot','invalid_mention',e=>{e.text='@bot';e.mentions=[{kind:'bot',id:'fictional_bot',start:0,end:4}];}],
 ['human','invalid_mention',e=>{e.text='@outside';e.mentions=[{kind:'human',id:outside.account_id,start:0,end:8}];}],
 ['attachment','unsupported_attachment',e=>e.attachment_ids=['fictional_private_attachment']],
 ['reply','invalid_reply',e=>e.reply_to_message_id='fictional_missing_message']]){
const p=await c.plan(h,'boundary-'+name,1,{expected:'rejected',change});plans.push(p);const r=await p.driver.operation(p.operations[0].id);assert.equal(r.status,'rejected');assert.equal(r.reason,reason);assert.deepEqual(await p.driver.operation(p.operations[0].id,{mode:'lookup'}),r);assert.deepEqual(await p.driver.operation(p.operations[0].id,{mode:'seal'}),r);c.record({type:'boundary',name,reason,state:'passed'});
}
await c.verify(h,plans);
const guest=await c.humans('guest_scope','guest'),extra=await c.ok(`/v2/workspaces/${guest.w}/rooms`,guest.a,'POST',{name:'fictional excluded room'});for(const action of ['snapshot','replay','read']){const r=await c.request(`/v2/workspaces/${guest.w}/rooms/${extra.room_id}/`+action,guest.b,'POST',{thread_id:extra.thread_id,...(action==='read'?{intervals:[]}:action==='replay'?{cursor:null}:{})});assert.equal(r.status,403);}assert.deepEqual((await c.ok('/v2/discovery/sync',guest.b)).workspaces[0].rooms.map(x=>x.room_id),[guest.r.room_id]);
const s=await c.snapshot(guest,guest.a);await c.ok(`/v2/workspaces/${guest.w}/members/${guest.b.account_id}`,guest.a,'DELETE');assert.equal((await c.request(`/v2/workspaces/${guest.w}/rooms/${guest.r.room_id}/snapshots/${s.snapshot_id}`,guest.a)).data.error,'visibility_changed');const reset=await c.ok(`/v2/workspaces/${guest.w}/rooms/${guest.r.room_id}/replay`,guest.a,'POST',{thread_id:guest.r.thread_id,cursor:s.cursor,snapshot_id:s.snapshot_id});assert.equal(reset.type,'reset_required');assert.equal(reset.reason,'visibility_changed');assert.ok(!reset.snapshot.members.some(m=>m.account_id===guest.b.account_id));
assert.equal((await c.request('/v2/test/hooks')).status,403);c.record({type:'case_complete',name:'a04-a07-guest-boundaries',state:'passed'});writeFileSync(evidence+'/summary.json',JSON.stringify({source:c.source,results:[{name:'a04-a07-guest-boundaries',state:'passed'}]},null,2)+'\n',{flag:'wx',mode:0o600});console.log('a04-a07-guest-boundaries passed');
}catch(e){console.error(e);process.exitCode=1;}finally{await c.close();}
