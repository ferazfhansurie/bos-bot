import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunStateSchema,RunBindingSchema,AttachmentPrepareSchema,attachmentObjectKey,AttachmentKeySchema,ApprovalDecisionSchema,HostRegistrationSchema} from './index.ts';
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
