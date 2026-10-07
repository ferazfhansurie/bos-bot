import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunStateSchema,RunBindingSchema,AttachmentPrepareSchema,attachmentObjectKey,AttachmentKeySchema,ApprovalDecisionSchema,HostRegistrationSchema,HostAppendSchema,AttachmentSchema} from './index.ts';
test('run gates and non-lossy generations are frozen',()=>{
 for(const state of ['queued','leased','running','waiting_for_human','held','completed','failed','cancelled']) RunStateSchema.parse(state);
 assert.equal(RunStateSchema.safeParse('stopped').success,false);
 RunBindingSchema.parse({invocation_id:'i',attempt:1,fence_gen:'9007199254740993'});
 assert.equal(RunBindingSchema.safeParse({invocation_id:'i',attempt:1,fence_gen:2}).success,false);
});
test('attachment namespace rejects client paths and fixes size/type/checksum limits',()=>{
 assert.equal(attachmentObjectKey('w','r','a'),'w|r|a');
 assert.throws(()=>attachmentObjectKey('w','../r','a'));
 assert.equal(AttachmentKeySchema.safeParse('w/r/a').success,false);
 const prepare={room_id:'r',thread_id:'t',name:'a',size:1,type:'text/plain',checksum:'a'.repeat(64)};
 AttachmentPrepareSchema.parse(prepare);
 for(const changed of [{size:10485761},{type:'text/html'},{checksum:'x'},{object_key:'other|room|a'}]) assert.equal(AttachmentPrepareSchema.safeParse({...prepare,...changed}).success,false);
});
test('decision binds exact actor-independent card identity and run generation',()=>{
 const d={invocation_id:'i',attempt:1,fence_gen:'1',version:1,effect_id:'e',digest:'a'.repeat(64),decision:'approve'};
 ApprovalDecisionSchema.parse(d);
 for(const changed of [{version:0},{digest:'bad'},{fence_gen:1},{decision:'yes'},{actor_id:'forged'}]) assert.equal(ApprovalDecisionSchema.safeParse({...d,...changed}).success,false);
});
test('no consequential host capability in slices 3/4',()=>{
 assert.equal(HostRegistrationSchema.safeParse({name:'h',bot_ids:['b'],capabilities:['strict_effects']}).success,false);
});
const binding={invocation_id:'i',attempt:1,fence_gen:'1'};
const approval={actor_id:'source',effect_id:'e',digest:'a'.repeat(64),title:'fictional gate',expires_in_seconds:60};
for(const event of [
 {kind:'stream.delta',text:'x'}, {kind:'stream.delta',delta_id:'d'},
 {kind:'final.commit'}, {kind:'stop.observed'}, {kind:'checkpoint'},
 {kind:'checkpoint',replay_safe:true}, {kind:'approval.create',approval:{}},
 {kind:'approval.create',approval:{...approval,junk:true}},
 {kind:'final.commit',text:'x',delta_id:'d'},
 {kind:'stream.delta',delta_id:'d',text:'🦊'.repeat(16385)},
]) test('host append rejects invalid payload '+JSON.stringify(event).slice(0,100),()=>{
 assert.equal(HostAppendSchema.safeParse({...binding,...event}).success,false);
});
test('host append accepts every complete strict event variant',()=>{
 for(const event of [{kind:'stream.delta',delta_id:'d',text:'x'},{kind:'final.commit',text:'x'},{kind:'stop.observed',control_revision:'1'},{kind:'checkpoint',replay_safe:false},{kind:'approval.create',approval}]) HostAppendSchema.parse({...binding,...event});
});
test('attachment readers reject unsupported content type and malformed checksum',()=>{
 const attachment={attachment_id:'a',workspace_id:'w',room_id:'r',thread_id:'t',owner_id:'source',object_key:'w|r|a',name:'fictional',size:1,type:'text/plain',checksum:'a'.repeat(64),state:'ready',expires_at:'2026-10-07T00:00:00Z'};
 AttachmentSchema.parse(attachment);
 for(const changed of [{type:'text/html'},{checksum:'x'},{checksum:'g'.repeat(64)}]) assert.equal(AttachmentSchema.safeParse({...attachment,...changed}).success,false);
});
