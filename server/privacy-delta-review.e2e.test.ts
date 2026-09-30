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
    expect((await api('GET',`/api/delegated/coordinate/${job.body.requestId}`,undefined,true)).status).toBe(403);
  } finally { await fixture.close(); rmSync(dir,{recursive:true,force:true}); }
},60000);

it('cancels a pending delegated proposal when its reviewer becomes private',async()=>{
  const {fixture,api,reviewer:victim}=await setup();
  try{
    const proposal=await api('PATCH',`/api/delegated/bots/${victim.id}`,{reason:'fixture only',fields:{title:'must not apply'}},true);
    expect(proposal.status,JSON.stringify(proposal.body)).toBe(201);
    expect(proposal.body.reviewBotId).not.toBe(victim.id);
    const reviewBot=(await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===proposal.body.reviewBotId);
    const task=reviewBot.tasks.find((t:any)=>t.openedBy?.name==='Remote Chief setup review');
    expect((await api('PATCH',`/api/bots/${reviewBot.id}`,{visibility:'private'})).status).toBe(200);
    expect((await api('GET',`/api/delegated/proposals/${proposal.body.requestId}`,undefined,true)).status).toBe(404);
    const approved=await api('POST',`/api/threads/${task.threadId}/respond`,{requestId:proposal.body.requestId,behavior:'allow'});
    expect(approved.status,JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.result.state).toBe('cancelled');
    expect((await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===victim.id).title).toBe(victim.title);
  }finally{await fixture.close();}
},60000);

it('hides an applied proposal result when its target becomes private but its reviewer remains public',async()=>{
  const {fixture,api,reviewer:victim}=await setup();
  try{
    const proposal=await api('PATCH',`/api/delegated/bots/${victim.id}`,{reason:'fixture only',fields:{title:'applied fixture'}},true);
    expect(proposal.status,JSON.stringify(proposal.body)).toBe(201);
    expect(proposal.body.reviewBotId).not.toBe(victim.id);
    const reviewBot=(await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===proposal.body.reviewBotId);
    const task=reviewBot.tasks.find((t:any)=>t.openedBy?.name==='Remote Chief setup review');
    const approved=await api('POST',`/api/threads/${task.threadId}/respond`,{requestId:proposal.body.requestId,behavior:'allow'});
    expect(approved.body.result.state).toBe('applied');
    expect((await api('PATCH',`/api/bots/${victim.id}`,{visibility:'private'})).status).toBe(200);
    const response=await api('GET',`/api/delegated/proposals/${proposal.body.requestId}`,undefined,true);
    console.log('proposal target privacy evidence',JSON.stringify({reviewerRemainsPublic:true,targetPrivate:true,status:response.status,body:response.body}));
    expect(response.status,'private target result must not remain readable through a public reviewer').toBe(404);
  }finally{await fixture.close();}
},60000);
