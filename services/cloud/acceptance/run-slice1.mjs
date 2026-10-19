import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connectFixture, pause, until } from './fixture-client.mjs';
import { bothOrders, deliverySchedule } from './schedules.mjs';
import { recipientMessages } from './protocol.mjs';
import { digest } from './oracle.mjs';
import { FrameSchema } from '../../../shared/cloud-protocol/index.ts';

const [server,state,evidence,...selected]=process.argv.slice(2);
assert.ok(server && state && evidence,'usage: node --experimental-strip-types run-slice1.mjs SERVER STATE NEW_EVIDENCE_DIR [CASES]');
const c=await connectFixture(server,state,evidence);
const results=[];
async function scenario(name,fn) {
  if(selected.length && !selected.includes(name)) return;
  const started=performance.now(); c.record({type:'case_start',name});
  try {await fn();const result={name,state:'passed',duration_ms:performance.now()-started};results.push(result);c.record({type:'case_complete',...result});console.log(JSON.stringify(result));}
  catch(error){c.record({type:'case_complete',name,state:'failed',error:error.message});throw error;}
}
const send=(h,p,i,options)=>p.driver.operation(p.operations[i].id,options);
async function replay(h,actor,s) {
  return FrameSchema.parse(await c.ok(`/v2/workspaces/${h.w}/rooms/${h.r.room_id}/replay`,actor,'POST',{thread_id:h.r.thread_id,cursor:s.cursor,...(s.snapshot_id?{snapshot_id:s.snapshot_id}:{})}));
}
async function waitForMessages(socket,ids) {
  await until(()=>ids.every(id=>socket.messages().some(m=>m.client_operation_id===id)),'recipient logical operations',10000);
}
try {
  await scenario('a01',async()=> {
    const h=await c.humans('a01'),a=await c.socket(h.a),b=await c.socket(h.b);
    try {
      a.subscribe(h);b.subscribe(h);
      await until(()=>a.frames.some(f=>f.type==='reset_required')&&b.frames.some(f=>f.type==='reset_required'),'two resets');
      const p=await c.plan(h,'a01-alice',1),q=await c.plan(h,'a01-bob',1,{actor:h.b,text:()=> 'fictional bob\nاللغة 😀 e\u0301 \u0000\uD800'});
      assert.equal((await send(h,p,0)).status,'accepted'); assert.equal((await send(h,q,0)).status,'accepted');
      await waitForMessages(a,[p.operations[0].id,q.operations[0].id]);await waitForMessages(b,[p.operations[0].id,q.operations[0].id]);
      for (const socket of [a,b]) {
        const byId=new Map(socket.messages().map(m=>[m.client_operation_id,m]));
        for (const plan of [p,q]) plan.oracle.verifyMessages(recipientMessages([byId.get(plan.operations[0].id)],plan.oracle));
      }
      await c.verify(h,[p,q]);await c.verify(h,[p,q],h.a);
    } finally {a.ws.terminate();b.ws.terminate();}
  });
  for (const mode of ['before-dispatch','after-commit']) await scenario('a03-'+mode,async()=> {
    const h=await c.humans('a03_'+mode.replaceAll('-','_')),p=await c.plan(h,'a03-'+mode,1000);
    await deliverySchedule({name:'a03-'+mode,record:c.record,
      operation:async i=> {
        const id=p.operations[i].id;
        if(mode==='before-dispatch') {
          // Cut the sender before any network dispatch. Lookup is the authoritative observation.
          p.oracle.submitted(id,p.operations[i].envelope);p.oracle.record({type:'sender_cut',id,point:'before_dispatch'});
          assert.equal((await p.driver.operation(id,{mode:'lookup'})).status,'not_found');
        } else assert.equal((await send(h,p,i,{discardResponse:true})).status,'transport_unknown');
        const receipt=await p.driver.operation(id,{mode:'lookup'});
        assert.equal(receipt.status,mode==='before-dispatch'?'not_found':'accepted');
        assert.equal((await send(h,p,i)).status,'accepted');
        assert.equal((await send(h,p,i)).status,'accepted');
      },verify:()=>c.verify(h,[p])});
  });
  await scenario('a04',async()=> {
    await bothOrders({name:'a04-send-seal',record:c.record,
      prepare:async({order,iteration})=> {
        const h=await c.humans('a04_'+iteration),p=await c.plan(h,`a04-${order}-${iteration}`,1,{expected:order==='first-before-second'?'accepted':'rejected'});
        let gate;
        return {h,p,pauseBeforeAdmission:async side=>gate=await c.gate((side==='first'?'message.send':'operation.seal')+'.before_admission',{workspace_id:h.w,account_id:h.a.account_id,client_operation_id:p.operations[0].id}),cleanup:async()=>{if(gate)await gate.cleanup();}};
      },first:f=>send(f.h,f.p,0),second:f=>send(f.h,f.p,0,{mode:'seal'}),
      inspect:async({fixture:f,order,resultA,resultB})=> {
        const expected=order==='first-before-second'?'accepted':'rejected';
        assert.equal(resultA.status,expected);assert.deepEqual(resultA,resultB);
        assert.equal((await send(f.h,f.p,0)).status,expected);await c.verify(f.h,[f.p]);
        const conflict=await c.request(`/v2/workspaces/${f.h.w}/messages`,f.h.a,'POST',{...f.p.operations[0].envelope,text:'fictional changed envelope'});
        assert.equal(conflict.status,409);assert.equal(conflict.data.error,'operation_conflict');
      }});
    const h=await c.humans('a04_boundaries'),p=await c.plan(h,'a04-expired',1,{expected:'rejected'});
    await c.hooks('expire-window',{workspace_id:h.w,account_id:h.a.account_id,window_id:p.win.window_id});
    assert.equal((await send(h,p,0)).reason,'operation_expired');await c.verify(h,[p]);
    const accepted=await c.plan(h,'a04-retained',1);assert.equal((await send(h,accepted,0)).status,'accepted');
    await c.hooks('expire-window',{workspace_id:h.w,account_id:h.a.account_id,window_id:accepted.win.window_id});
    assert.equal((await send(h,accepted,0)).status,'accepted');
    const other=await c.ok(`/v2/workspaces/${h.w}/operation-windows`,h.a,'POST',{});
    const swap=await c.request(`/v2/workspaces/${h.w}/messages`,h.a,'POST',{...p.operations[0].envelope,window_token:other.window_token});
    assert.equal(swap.status,409);
    const missing=await c.plan(h,'a04-missing',1);
    await c.hooks('rotate-epoch',{workspace_id:h.w});
    for(const mode of ['lookup','submit','seal'])assert.equal((await missing.driver.operation(missing.operations[0].id,{mode})).status,'recovery_unknown');
    c.record({type:'unknown_retained',id:missing.operations[0].id,state:'recovery_unknown',replacement_submitted:false});
  });
  for(const fault of ['paused','before_complete','after_commit','lost-notify'])await scenario('a05-'+fault,async()=> {
    const h=await c.humans('a05_'+fault.replaceAll('-','_')),p=await c.plan(h,'a05-'+fault,1000);
    await c.hooks('control',{worker_paused:true,drop_notify:true,worker_fault:fault==='before_complete'||fault==='after_commit'?fault:'none'});
    const baseline=new Set((await c.hooks('queue-state',{workspace_id:h.w})).map(q=>q.event_id));
    const socket=await c.socket(h.b);socket.subscribe(h);
    try {
      await deliverySchedule({name:'a05-'+fault,record:c.record,operation:async i=>assert.equal((await send(h,p,i)).status,'accepted'),verify:async()=> {
        const queue=await c.hooks('queue-state',{workspace_id:h.w});const added=queue.filter(q=>!baseline.has(q.event_id));assert.equal(added.length,1000);assert.ok(added.every(q=>baseline.has(q.event_id)||q.completed_at===null));
        const counts=(await c.admin.query(`SELECT (SELECT count(*)::int FROM cloud.messages WHERE workspace_id=$1) messages,(SELECT count(*)::int FROM cloud.operations WHERE workspace_id=$1) operations,(SELECT count(*)::int FROM cloud.room_events WHERE workspace_id=$1) events,(SELECT count(*)::int FROM cloud.outbox WHERE workspace_id=$1) outbox,(SELECT count(*)::int FROM cloud.work_queue WHERE workspace_id=$1) queue`,[h.w])).rows[0];
        assert.equal(counts.messages,1000);assert.equal(counts.operations,1000);assert.equal(counts.events,counts.outbox);assert.equal(counts.outbox,counts.queue);c.record({type:'durable_atomic_ledger',fault,counts});
        await waitForMessages(socket,p.operations.map(x=>x.id));
        await c.hooks('control',{worker_paused:false});
        if(fault==='before_complete') {
          await pause(450);assert.ok((await c.hooks('queue-state',{workspace_id:h.w})).every(q=>baseline.has(q.event_id)||q.completed_at===null));
        }
        await c.hooks('control',{worker_fault:'none'});
        await until(async()=> (await c.hooks('queue-state',{workspace_id:h.w})).every(q=>q.completed_at!==null),'automatic durable worker',30000);
        for(const row of queue)await c.hooks('redeliver',{workspace_id:h.w,room_id:row.room_id,event_id:row.event_id});
        await until(async()=> (await c.hooks('queue-state',{workspace_id:h.w})).every(q=>q.completed_at!==null),'duplicate delivery drain',30000);
        assert.equal((await c.hooks('queue-state',{workspace_id:h.w})).length,queue.length);
        await c.verify(h,[p]);
      }});
    } finally {socket.ws.terminate();await c.hooks('control',{worker_paused:false,drop_notify:false,worker_fault:'none'});}
  });
  await scenario('a06-a07',async()=> {
    const h=await c.humans('a06_a07'),p=await c.plan(h,'a06-a07',1020);
    for(let i=0;i<10;i++)assert.equal((await send(h,p,i)).status,'accepted');
    const snapshot=await c.snapshot(h);const H=snapshot.watermark;
    for(let i=10;i<1000;i++)assert.equal((await send(h,p,i)).status,'accepted');
    assert.deepEqual(await c.ok(`/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshots/${snapshot.snapshot_id}`,h.b),snapshot);
    let f=await replay(h,h.b,snapshot);assert.equal(f.type,'event_batch');assert.equal(f.live,false);const B=f.frontier;
    for(let i=1000;i<1020;i++)assert.equal((await send(h,p,i)).status,'accepted');
    const batches=[];
    for(let pages=0;;pages++) {
      assert.equal(f.frontier,B,'catch-up frontier moved');assert.ok(f.events.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(f))<=1048576);
      assert.ok(f.events.every(e=>BigInt(e.sequence)>BigInt(H)&&BigInt(e.sequence)<=BigInt(B)));batches.push(f);
      if(f.live) {assert.equal(f.scanned_sequence,B);break;}
      assert.ok(pages<20);f=await replay(h,h.b,{cursor:f.cursor,snapshot_id:snapshot.snapshot_id});
    }
    const later=await replay(h,h.b,{cursor:f.cursor});assert.equal(later.live,true);assert.equal(later.events.length,20);
    const events=[...batches,later].flatMap(f=>f.events);const expected=await c.verify(h,[p]);
    const initial=snapshot.messages;
    const messages=events.map(e=>e.payload.message).filter(Boolean);
    // Deliberate loss/reorder/duplication and crash cuts are applied outside the service.
    for(const schedule of ['drop','reverse','duplicate','crash-before-checkpoint','crash-after-checkpoint']) {
      const offered=schedule==='drop'?messages.filter((_,i)=>i%7):schedule==='reverse'?[...messages].reverse():schedule==='duplicate'?[...messages,...messages]:messages;
      let projection=new Map(initial.map(m=>[m.message_id,m]));
      const checkpoint=new Map(projection);
      for(const m of offered)projection.set(m.message_id,m);
      if(schedule==='crash-before-checkpoint')projection=new Map(checkpoint);
      // Resume the unchanged authoritative cursor; duplicates do not become logical messages.
      for(const m of messages)projection.set(m.message_id,m);
      assert.deepEqual([...projection.values()].sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1),expected);
      c.record({type:'delivery_schedule',name:'a06-'+schedule,count:1020,state:'passed',projection_digest:digest(expected)});
    }
    const reset=await replay(h,h.b,{cursor:'fictional_corrupt_cache'});assert.equal(reset.type,'reset_required');assert.equal(reset.reason,'cursor_invalid');
    assert.equal(reset.snapshot.messages.length,50);
    await c.hooks('expire-snapshot',{workspace_id:h.w,account_id:h.b.account_id,snapshot_id:snapshot.snapshot_id});
    const expired=await replay(h,h.b,snapshot);assert.equal(expired.type,'reset_required');assert.equal(expired.reason,'snapshot_expired');
    c.record({type:'pinned_frontier',H,B,after:later.frontier,catchup_events:events.length,state:'passed'});
  });
  await scenario('a08',async()=> {
    const h=await c.humans('a08'),p=await c.plan(h,'a08-overflow',1000,{text:i=>i<20?`${i} `+'x'.repeat(65520):'fictional overflow '+i});
    for(let i=0;i<1000;i++)assert.equal((await send(h,p,i)).status,'accepted');
    // Put 20 large messages into the newest 50 using unchanged-key retry is insufficient;
    // the manifest freezes these additional intended writes before dispatch.
    const q=await c.plan(h,'a08-large-snapshot',20,{text:i=>`${i} `+'x'.repeat(65520)});
    for(let i=0;i<20;i++)assert.equal((await send(h,q,i)).status,'accepted');
    const socket=await c.socket(h.b);socket.subscribe(h);
    try {await until(()=>socket.code!==null,'recoverable socket overflow',10000);assert.equal(socket.code,1013);assert.ok(socket.frames.some(f=>f.type==='reset_required'&&f.reason==='overflow'));}
    finally{socket.ws.terminate();}
    const s=await c.snapshot(h);assert.equal(s.messages.length,50);
    const recovered=await c.socket(h.b);recovered.subscribe(h,s);
    try {await until(()=>recovered.frames.some(f=>f.type==='event_batch'&&f.live),'http snapshot to socket recovery');}
    finally{recovered.ws.terminate();}
    await c.verify(h,[p,q]);
    await c.hooks('control',{issuer_stall_ms:2000});
    const ws=new c.WebSocket(c.state.ws_url);const frames=[];let code;
    ws.on('message',raw=>frames.push(JSON.parse(raw.toString())));ws.on('close',v=>code=v);ws.on('error',()=>{});
    await new Promise(resolve=>ws.once('open',resolve));
    ws.send(JSON.stringify({type:'authenticate',bearer:h.b.bearer}));
    for(let i=0;i<1002;i++)ws.send(JSON.stringify({type:'authenticate',bearer:h.b.bearer}));
    try {await until(()=>code!==undefined,'1000 queued inbound frame limit');assert.equal(code,1013);c.record({type:'socket_inbound_bound',offered:1003,code,state:'passed'});}
    finally{ws.terminate();await c.hooks('control',{issuer_stall_ms:0});}
    // Required unknown schema handling belongs to real UI/mobile reducers, not this server.
    c.record({type:'scope_exclusion',name:'unknown-required-schema-client-reducer',owners:['ui','mobile'],server_result:'not_applicable'});
  });
  await scenario('a14',async()=> {
    const h=await c.humans('a14'),p=await c.plan(h,'a14-outage',1),s=await c.snapshot(h),socket=await c.socket(h.b);socket.subscribe(h,s);
    try {
      await until(()=>socket.frames.some(f=>f.type==='event_batch'),'established protected stream');
      const started=performance.now();await c.hooks('control',{issuer_unavailable:true});
      const r=await send(h,p,0);assert.equal(r.error,'identity_unavailable');
      await until(()=>socket.code!==null,'issuer outage stops protected publication');assert.equal(socket.code,1008);
      assert.ok(performance.now()-started<15000);c.record({type:'identity_deadline',duration_ms:performance.now()-started,bound_ms:15000,state:'passed'});
      await c.hooks('control',{issuer_unavailable:false});
      assert.equal((await send(h,p,0)).status,'accepted');await c.verify(h,[p]);
      const stalled=await c.plan(h,'a14-stalled',1);await c.hooks('control',{issuer_stall_ms:16000});
      const before=performance.now();assert.equal((await send(h,stalled,0)).error,'identity_unavailable');
      assert.ok(performance.now()-before<5000);await c.hooks('control',{issuer_stall_ms:0});
      assert.equal((await stalled.driver.operation(stalled.operations[0].id,{mode:'lookup'})).status,'not_found');
      assert.equal((await send(h,stalled,0)).status,'accepted');await c.verify(h,[p,stalled]);
      await c.hooks('control',{revoke_bearer:h.a.bearer});
      assert.equal((await c.request('/v2/me',h.a)).status,401);
      assert.equal((await c.request(`/v2/workspaces/${h.w}/operations/${p.operations[0].id}`,h.a)).status,401);
    } finally{socket.ws.terminate();await c.hooks('control',{issuer_unavailable:false,issuer_stall_ms:0});}
  });
  await scenario('a04-changed-envelope-hook',async()=> {
    const h=await c.humans('a04_hook'),p=await c.plan(h,'a04-hook-probe',1);
    const id=randomUUID(),envelope=p.operations[0].envelope;
    await c.hooks('arm',{id,point:'message.send.before_admission',match:{workspace_id:h.w,account_id:h.a.account_id,client_operation_id:envelope.client_operation_id,digest:digest(envelope)}});
    try {
      const pending=send(h,p,0);pending.catch(()=>{});
      const reached=await Promise.race([
        until(async()=> (await c.hooks()).gates.some(g=>g.id===id&&g.entered&&g.waiting===1),'digest-matched admission',4000).then(()=>true),
        pending.then(()=>false),
      ]);
      const gates=await c.hooks();
      c.record({type:'same_key_race_hook_probe',digest:digest(envelope),supported:reached,gate:gates.gates.find(g=>g.id===id)});
      await c.hooks('release',{id});await pending;
      assert.ok(reached,'same-key changed-envelope race cannot select its losing request: digest is absent from admission-hook details');
    }finally{await c.hooks('release',{id});}
  });
  writeFileSync(evidence+'/summary.json',JSON.stringify({source:c.source,results},null,2)+'\n',{flag:'wx',mode:0o600});
} catch(error) {console.error(error);process.exitCode=1;}
finally {await c.close();}
