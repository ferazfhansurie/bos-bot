import test from 'node:test';
import assert from 'node:assert/strict';
import * as recovery from './slice34-service-recovery.mjs';
const h={w:'fictional-workspace',r:{room_id:'fictional-room'}};
const body=Object.freeze({thread_id:'fictional-thread',cursor:'original-signed-cursor'});
function context(responses){
 const calls=[],logs=[],waits=[];
 return {calls,logs,waits,
  request:async (...args)=>{calls.push(structuredClone(args));return responses.shift();},
  log:item=>logs.push(item),pause:async ms=>waits.push(ms)};
}
test('recovery replay retries real identity-unavailable read with unchanged cursor',async()=>{
 assert.equal(typeof recovery.recoveryReplay,'function','read recovery helper required');
 const frame={type:'event_batch',events:[],cursor:'fresh-signed-cursor'};
 const c=context([{status:503,data:{error:'identity_unavailable',retry_after:1}},{status:200,data:frame}]);
 assert.deepEqual(await recovery.recoveryReplay(c,h,{bearer:'fictional'},body),frame);
 assert.equal(c.calls.length,2);assert.deepEqual(c.calls[0],c.calls[1]);assert.deepEqual(c.calls[0][3],body);
 assert.deepEqual(c.waits,[1000]);assert.equal(c.logs.length,1);
});
test('recovery replay never retries revoked or invalid identity',async()=>{
 assert.equal(typeof recovery.recoveryReplay,'function','read recovery helper required');
 for(const status of [401,403]){
  const c=context([{status,data:{error:status===401?'session_invalid':'forbidden'}}]);
  await assert.rejects(()=>recovery.recoveryReplay(c,h,{},body));assert.equal(c.calls.length,1);assert.equal(c.waits.length,0);
 }
});
test('persistent identity outage fails after three actual reads',async()=>{
 assert.equal(typeof recovery.recoveryReplay,'function','read recovery helper required');
 const c=context(Array.from({length:3},()=>({status:503,data:{error:'identity_unavailable',retry_after:1}})));
 await assert.rejects(()=>recovery.recoveryReplay(c,h,{},body));assert.equal(c.calls.length,3);assert.deepEqual(c.waits,[1000,1000]);
});
