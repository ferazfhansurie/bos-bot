import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlOmb } from '../scripts/control-omb.ts';

async function setup(env: Record<string, string> = {}) {
  const fixture = await launchVerificationServer(env);
  const api = async (method: string, path: string, body?: any, delegated = false) => {
    const res = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url, ...(delegated ? { authorization: `Bearer ${token}`, 'x-bos-grantee-home': 'foreign', 'x-bos-grantee-bot': 'chief' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  let token = '';
  const pairing = await api('POST', '/api/auth/pairing', { scopes: ['peer'] });
  const paired = (await api('POST', '/api/auth/pair', { code: pairing.body.code })).body;
  token = paired.token;
  writeFileSync(join(fixture.info.dataDir, 'delegations.json'), JSON.stringify({ version: 1, delegations: [{ granteeHomeId: 'foreign', granteeBotId: 'chief', peerSessionId: paired.session.id, peerTokenHash: createHash('sha256').update(token).digest('hex'), scopes: ['coordinate','bots:create','bots:configure','bots:delete'], section: '', note: 'fixture only' }] }));
  const reviewer = (await api('GET', '/api/bots')).body.bots[0];
  const target = (await api('POST', '/api/bots', { name: 'Privacytarget', modelSelection: reviewer.modelSelection })).body.bot;
  return { fixture, api, reviewer, target };
}

it('hides private targets from delegated catalogs, mutations, coordination and proposal receipts; rechecks approval', async () => {
  const { fixture, api, target } = await setup();
  try {
    const proposed = await api('PATCH', `/api/delegated/bots/${target.id}`, { reason: 'fixture', fields: { title: 'must not apply' } }, true);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const reviewBot = (await api('GET', '/api/bots')).body.bots.find((b: any) => b.id === proposed.body.reviewBotId);
    const reviewTask = reviewBot.tasks.find((t: any) => t.openedBy?.name === 'Remote Chief setup review');
    expect((await api('PATCH', `/api/bots/${target.id}`, { visibility: 'private' })).status).toBe(200);
    for (const route of ['/api/delegated/roster', '/api/delegated/catalog']) {
      const reply = await api('GET', route, undefined, true);
      expect(reply.status).toBe(200); expect(JSON.stringify(reply.body)).not.toContain(target.id); expect(JSON.stringify(reply.body)).not.toContain('Privacytarget');
    }
    for (const [method,path,body] of [
      ['PATCH', `/api/delegated/bots/${target.id}`, { reason:'fixture', fields:{title:'denied'} }],
      ['DELETE', `/api/delegated/bots/${target.id}`, { reason:'fixture' }],
      ['POST', '/api/delegated/setup', { plan:{reason:'fixture',operations:[{action:'update',botId:target.id,fields:{title:'denied'}}]} }],
      ['POST','/api/delegated/coordinate',{botId:target.id,requestKey:'private',message:'do not start'}],
      ['GET', `/api/delegated/proposals/${proposed.body.requestId}`, undefined],
    ] as const) {
      const result = await api(method,path,body,true); expect([403,404]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain('Privacytarget');
    }
    const approved = await api('POST', `/api/threads/${reviewTask.threadId}/respond`, { requestId: proposed.body.requestId, behavior:'allow' });
    expect(approved.body.result.state).toBe('cancelled');
    expect((await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===target.id).title).toBe(target.title);
    await api('PATCH', `/api/bots/${target.id}`, {visibility:'shared'});
    expect((await api('PATCH', `/api/delegated/bots/${target.id}`, { reason:'fixture',fields:{visibility:'private'} }, true)).status).toBe(403);
  } finally { await fixture.close(); }
},60000);

it('does not dispatch a queued job after its target turns private', async () => {
  const dir = mkdtempSync(join(tmpdir(),'privacy-queue-')); const gate = join(dir,'finish');
  const { fixture, api, target } = await setup({ FAKE_CLAUDE_MODE:'slow', FAKE_CLAUDE_SLOW_FINISH_GATE:gate });
  try {
    await runControlOmb(['send','--bot',target.id,'--task',target.threadId,'--text','fixture hold','--url',fixture.info.url]);
    await expect.poll(async ()=>(await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===target.id).busy,{timeout:15000}).toBe(true);
    const job = await api('POST','/api/delegated/coordinate',{botId:target.id,requestKey:'queued-private',message:'never dispatch'},true);
    expect(job.status).toBe(200);
    await api('PATCH',`/api/bots/${target.id}`,{visibility:'private'});
    writeFileSync(gate,'finish');
    await expect.poll(()=>JSON.parse(readFileSync(join(fixture.info.dataDir,'delegated-jobs.json'),'utf8')).find((j:any)=>j.id===job.body.requestId).status,{timeout:20000}).toBe('failed');
    const current = (await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===target.id);
    expect(current.tasks.some((t:any)=>t.openedBy?.name==='Remote Chief')).toBe(false);
    expect((await api('GET',`/api/delegated/coordinate/${job.body.requestId}`,undefined,true)).status).toBe(404);
  } finally { await fixture.close(); rmSync(dir,{recursive:true,force:true}); }
},60000);

it('hides a completed result after privacy toggles and denies duplicate enqueue retrieval',async()=>{
  const {fixture,api,target}=await setup();
  try{
    const body={botId:target.id,requestKey:'finished-private',message:'fixture only'};
    const job=await api('POST','/api/delegated/coordinate',body,true);
    await expect.poll(async()=>(await api('GET',`/api/delegated/coordinate/${job.body.requestId}`,undefined,true)).body.status,{timeout:30000}).toBe('completed');
    await api('PATCH',`/api/bots/${target.id}`,{visibility:'private'});
    expect((await api('GET',`/api/delegated/coordinate/${job.body.requestId}`,undefined,true)).status).toBe(404);
    expect((await api('POST','/api/delegated/coordinate',body,true)).status).toBe(403);
  }finally{await fixture.close();}
},60000);

it('does not retain a result completed while the delegated target is private',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'privacy-running-')); const gate=join(dir,'finish');
  const {fixture,api,target}=await setup({FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_SLOW_FINISH_GATE:gate});
  try{
    const job=await api('POST','/api/delegated/coordinate',{botId:target.id,requestKey:'running-private',message:'fixture delayed reply'},true);
    const saved=()=>JSON.parse(readFileSync(join(fixture.info.dataDir,'delegated-jobs.json'),'utf8')).find((j:any)=>j.id===job.body.requestId);
    await expect.poll(()=>saved().status,{timeout:20000}).toBe('running');
    await api('PATCH',`/api/bots/${target.id}`,{visibility:'private'});
    writeFileSync(gate,'finish');
    await expect.poll(()=>saved().status,{timeout:20000}).toBe('failed');
    expect(saved().result).toBe('Delegated target unavailable');
    expect((await api('GET',`/api/delegated/coordinate/${job.body.requestId}`,undefined,true)).status).toBe(404);
  }finally{await fixture.close();rmSync(dir,{recursive:true,force:true});}
},60000);
