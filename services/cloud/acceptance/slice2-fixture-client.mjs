import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localURL, redact, Transport } from './transport.mjs';
import { freezeManifest, Oracle } from './oracle.mjs';
import { CloudDriver, PROTOCOL_COMMIT, frozenOperation, operationEnvelope, recipientMessages } from './protocol.mjs';
import { FrameSchema, SnapshotSchema } from '../../../shared/cloud-protocol/index.ts';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, label, ms = 5000) {
  const deadline = performance.now() + ms;
  do { const value = await fn(); if (value) return value; await pause(15); } while (performance.now() < deadline);
  throw new Error('bounded acceptance deadline: ' + label);
}
export async function connectFixture(serverArg, stateArg, evidenceArg) {
  const server = realpathSync(serverArg), statePath = realpathSync(stateArg), evidence = resolve(evidenceArg);
  assert.ok(statePath.includes('/bos-slice2-') && statePath.endsWith('/state.json'));
  assert.ok(!evidence.startsWith(server + sep), 'oracle must be outside SUT storage');
  mkdirSync(evidence, { recursive: false, mode: 0o700 });
  const git = args => execFileSync('git', args, { cwd: server, encoding: 'utf8' }).trim();
  const source = 'fefeafa7981d9d1c9fad2aa03688a2d5e704affe';
  const protocol = source;
  assert.equal(git(['diff', source, '--', 'services/cloud', ':!services/cloud/acceptance']), '', 'candidate drift');
  assert.equal(git(['status', '--porcelain', '--', 'services/cloud', ':!services/cloud/acceptance']), '', 'dirty SUT');
  assert.equal(git(['diff', protocol, '--', 'shared/cloud-protocol']), '', 'protocol drift');
  const state = JSON.parse(readFileSync(statePath, 'utf8')), base = localURL(state.url);
  assert.equal(realpathSync(state.state_path), statePath);
  assert.ok(state.acceptance_hooks && state.issuer_url && state.local_d1_directory);
  localURL(state.issuer_url); localURL(state.ws_url.replace('ws:', 'http:'));
  assert.equal(git(['diff',source,'--','cloudflare/control-plane']), '', 'issuer drift');
  assert.equal(git(['status','--porcelain','--','cloudflare/control-plane']), '', 'dirty issuer');
  assert.ok(state.hook_secret && state.schema === 1);
  for (const [key, role] of [['database_url','cloud_app'], ['migration_url','cloud_migrator']]) {
    const url = new URL(state[key]);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, role);
    assert.ok(url.pathname.startsWith('/cloud_slice1_'));
  }
  const require = createRequire(server + '/services/cloud/package.json');
  const pg = require('pg'), WebSocket = require('ws').WebSocket;
  const admin = new pg.Client({ connectionString: state.migration_url, query_timeout: 5000 });
  const app = new pg.Client({ connectionString: state.database_url, query_timeout: 5000 });
  await admin.connect(); await app.connect();
  const journal = evidence + '/raw.jsonl'; writeFileSync(journal, '', { flag: 'wx', mode: 0o600 });
  const record = item => appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...redact(item) }) + '\n', { flush: ['case_complete','complete'].includes(item.type) });
  const role = (await app.query('SELECT current_user,current_database(),rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.current_user, 'cloud_app');
  for (const key of ['rolsuper','rolbypassrls','rolinherit']) assert.equal(role[key], false);
  record({ type:'fixture', source, checkout: git(['rev-parse','HEAD']), protocol,
    role, schema: state.schema, url: base.href, fixture_pid:state.fixture_pid, postgres_pid:state.postgres_pid });
  const transport = new Transport(base.href, record);
  const sockets = new Set();
  const c = { server, state, evidence, source, transport, record, admin, app, sockets, WebSocket };
  const issuer = localURL(state.issuer_url);
  c.issuerRequest = async (path, options={}) => fetch(new URL(path,issuer), {...options,redirect:'error',signal:AbortSignal.timeout(5000)});
  c.request = (path, actor, method='GET', body) => transport.request(path, { method, token:actor?.bearer, body });
  c.ok = async (path, actor, method='GET', body) => {
    const r = await c.request(path, actor, method, body); assert.equal(r.status,200,JSON.stringify({path,...r})); return r.data;
  };
  c.hooks = async (action='', body) => {
    const path = '/v2/test/hooks' + (action ? '/' + action : '');
    record({ type:'hook_request', path, body:body ?? null });
    const r = await fetch(new URL(path,base), { method: action ? 'POST':'GET', redirect:'error',
      signal:AbortSignal.timeout(4000), headers:{'X-Cloud-Fixture-Secret':state.hook_secret,'content-type':'application/json'},
      ...(action ? { body:JSON.stringify(body) } : {}) });
    const data = await r.json(); record({ type:'hook_response',path,status:r.status,data });
    assert.equal(r.status,200,JSON.stringify(data)); return data;
  };
  c.actor = async (label, email=`${label.replace(/[^a-z0-9_]/gi,'_')}_${randomUUID()}@example.test`) => {
    const sent=await c.issuerRequest('/api/auth/email-otp/send-verification-otp',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:5199'},body:JSON.stringify({email,type:'sign-in'})});
    assert.equal(sent.status,200,'real issuer otp dispatch');
    const sink=await c.issuerRequest('/__dev/otp?email='+encodeURIComponent(email)); assert.equal(sink.status,200);
    const {otp}=await sink.json();
    const signed=await c.issuerRequest('/api/auth/sign-in/email-otp',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:5199'},body:JSON.stringify({email,otp})});
    assert.equal(signed.status,200,'real issuer otp sign-in');
    const bearer=signed.headers.get('set-auth-token'); assert.ok(bearer);
    const identity=await c.ok('/v2/me',{bearer});
    const me=await c.issuerRequest('/v1/me',{headers:{authorization:'Bearer '+bearer}});assert.equal(me.status,200);
    assert.equal(identity.subject,(await me.json()).user.id);
    record({type:'real_issuer_identity',email,...identity});
    return {...identity,bearer,email};
  };
  const humanCache=new Map();
  c.humans = async (name,role='member') => {
    const key=name+'_'+role;
    if(!humanCache.has(key))humanCache.set(key,[await c.actor(key+'_alice'),await c.actor(key+'_bob')]);
    const [a,b]=humanCache.get(key);
    const w = (await c.ok('/v2/workspaces',a,'POST',{name:'fictional ' + name})).workspace_id;
    const r = await c.ok(`/v2/workspaces/${w}/rooms`,a,'POST',{name:'fictional room'});
    const invite = await c.ok(`/v2/workspaces/${w}/invites`,a,'POST',{role,room_ids:[r.room_id]});
    await c.ok('/v2/invites/redeem',b,'POST',{token:invite.token});
    const h = { a,b,w,r }; h.s = await c.snapshot(h,a); return h;
  };
  c.snapshot = async (h,actor=h.b) => SnapshotSchema.parse(await c.ok(`/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`,actor,'POST',{thread_id:h.r.thread_id}));
  c.plan = async (h,name,count,{actor=h.a,text=i=>`fictional ${name} ${i} 🦊\n\u0000\uD800`,expected='accepted',change}={}) => {
    const win = await c.ok(`/v2/workspaces/${h.w}/operation-windows`,actor,'POST',{});
    const s = await c.snapshot(h,actor);
    const operations = Array.from({length:count},(_,i)=> {
      const envelope = operationEnvelope({window:win,room:{...h.r,policy_revision:s.policy_revision},text:text(i),nonce:randomUUID().replaceAll('-','')});
      if (change) change(envelope,i);
      const op = frozenOperation(envelope); op.expected.state=expected;
      if (expected !== 'accepted') delete op.expected.message;
      return op;
    });
    const path=c.evidence+'/'+name+'.manifest.json';
    freezeManifest(path,{candidate:source,protocol:PROTOCOL_COMMIT,scope:{workspace_id:h.w,room_id:h.r.room_id,thread_id:h.r.thread_id},operations});
    const oracle=new Oracle(path,c.evidence+'/'+name+'.oracle.jsonl');
    return { win,operations,oracle,driver:new CloudDriver(transport,actor.bearer,oracle),actor };
  };
  c.history = async (h,actor=h.b) => {
    let before='9223372036854775807'; const result=[];
    for (;;) {
      const page=await c.ok(`/v2/workspaces/${h.w}/rooms/${h.r.room_id}/history?thread_id=${h.r.thread_id}&before=${before}&limit=100`,actor);
      assert.ok(page.messages.length<=100); result.unshift(...page.messages);
      if (!page.next_before) return result;
      assert.ok(BigInt(page.next_before)<BigInt(before)); before=page.next_before;
    }
  };
  c.verify = async (h,plans,actor=h.b) => {
    const messages=await c.history(h,actor);
    const all=new Map(plans.flatMap(p=>[...p.oracle.receipts]));
    const normalized=recipientMessages(messages,{receipts:all});
    for (const p of plans) {
      p.oracle.assertResolved(); p.oracle.verifyMessages(normalized.filter(m=>p.oracle.intents.has(m.operation_id)));
    }
    assert.equal(normalized.length,[...all.values()].filter(x=>x.state==='accepted').length);
    const rows=(await admin.query('SELECT actor_id,client_operation_id,text,sequence FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 ORDER BY sequence',[h.w,h.r.room_id])).rows;
    assert.deepEqual(rows,messages.map(m=>({actor_id:m.actor_id,client_operation_id:m.client_operation_id,text:m.text,sequence:m.sequence})));
    record({type:'canonical_verified',workspace_id:h.w,messages:messages.length,manifests:plans.map(p=>p.oracle.manifest.manifest_digest)});
    return messages;
  };
  c.gate = async (point,match) => {
    const id=randomUUID(); await c.hooks('arm',{id,point,match});
    return { boundary:'before-protected-admission',
      waitUntilReached:()=>until(async()=> {
        const gate=(await c.hooks()).gates.find(g=>g.id===id);
        if (gate?.entered && gate.waiting===1) {record({type:'admission_barrier',id,point,gate});return true;}
      },'real admission barrier',4000),
      release:async()=> {
        const gate=(await c.hooks()).gates.find(g=>g.id===id);
        assert.ok(gate?.entered && gate.waiting===1,'barrier auto-released or not reached');
        await c.hooks('release',{id});
      }, cleanup:()=>c.hooks('release',{id}) };
  };
  c.socket = async actor => {
    const ws=new WebSocket(state.ws_url); sockets.add(ws);
    const frames=[]; const trace={ws,frames,code:null};
    ws.on('message',raw=> {const frame=FrameSchema.parse(JSON.parse(raw.toString()));frames.push(frame);record({type:'ws_frame',account_id:actor.account_id,frame,bytes:raw.byteLength});});
    ws.on('close',code=> {trace.code=code;record({type:'ws_close',account_id:actor.account_id,code});sockets.delete(ws);});
    ws.on('error',e=>record({type:'ws_error',name:e.name}));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({type:'authenticate',bearer:actor.bearer}));
    await until(()=>frames.some(f=>f.type==='heartbeat'),'socket auth');
    trace.subscribe=(h,s=null)=>ws.send(JSON.stringify({type:'subscribe',workspace_id:h.w,room_id:h.r.room_id,thread_id:h.r.thread_id,cursor:s?.cursor??null,...(s?{snapshot_id:s.snapshot_id}:{})}));
    trace.messages=()=>frames.flatMap(f=>f.type==='event_batch'?f.events.map(e=>e.payload.message).filter(Boolean):f.snapshot?.messages??[]);
    return trace;
  };
  c.close = async()=> {
    for (const ws of sockets) ws.terminate();
    await c.hooks('control',{worker_paused:false,drop_notify:false,worker_fault:'none'});
    await app.end(); await admin.end();
  };
  return c;
}
