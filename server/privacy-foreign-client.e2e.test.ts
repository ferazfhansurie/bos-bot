import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-omb.ts';
import { basename } from 'node:path';
it('foreign actor-bound client must not inherit owner-private bot visibility', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method:string,path:string,body?:any,token?:string)=>{
    const res=await fetch(fixture.info.url+path,{method,headers:{'content-type':'application/json',origin:fixture.info.url,...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,body:await res.json() as any};
  };
  const streamAbort = new AbortController();
  let readStream: Promise<void> | undefined;
  try {
    const bot=(await api('GET','/api/bots')).body.bots[0];
    const image=await fetch(fixture.info.url+'/api/attachments',{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64')});
    expect(image.status).toBe(201);
    const avatar='/api/attachments/'+basename((await image.json() as any).path);
    expect((await api('PATCH',`/api/bots/${bot.id}`,{avatarUrl:avatar})).status).toBe(200);
    await api('PATCH',`/api/bots/${bot.id}`,{visibility:'private',name:'Owner-private sentinel'});
    const pair=(await api('POST','/api/auth/pairing',{scopes:['client']})).body;
    const guest=(await api('POST','/api/auth/pair',{code:pair.code,label:'Other person device'})).body;
    const stream=await fetch(fixture.info.url+'/api/events',{headers:{authorization:`Bearer ${guest.token}`},signal:streamAbort.signal});
    expect(stream.status).toBe(200);
    let streamEnded=false;
    readStream=(async()=>{const reader=stream.body!.getReader();try{for(;;){const item=await reader.read();if(item.done){streamEnded=true;break;}}}finally{reader.releaseLock();}})();
    expect((await api('POST','/api/multiplayer/actor-bindings',{sessionId:guest.session.id,personId:'other-home:person:owner',name:'Other owner'})).status).toBe(200);
    expect((await api('PATCH',`/api/bots/${bot.id}`,{name:'Owner-private sentinel updated'})).status).toBe(200);
    await expect.poll(()=>streamEnded,{timeout:1500}).toBe(true);
    const contacts=await api('GET','/api/multiplayer/contacts',undefined,guest.token);
    expect(JSON.stringify(contacts.body)).not.toContain('Owner-private sentinel');
    const roster=await api('GET','/api/bots',undefined,guest.token);
    const toggle=await api('PATCH',`/api/bots/${bot.id}`,{visibility:'shared'},guest.token);
    const ownerState=(await api('GET','/api/bots')).body.bots.find((b:any)=>b.id===bot.id).visibility;
    console.log('foreign-client evidence',JSON.stringify({rosterStatus:roster.status,privateBotListed:roster.body.bots?.some((b:any)=>b.id===bot.id),contactsHidePrivate:!JSON.stringify(contacts.body).includes('Owner-private sentinel'),foreignVisibilityToggleStatus:toggle.status,ownerReadbackVisibility:ownerState}));
    expect(roster.body.bots?.some((b:any)=>b.id===bot.id)).toBe(false);
    expect(toggle.status).toBe(404);
    expect(ownerState).toBe('private');
    for (const path of [`/api/threads/${bot.threadId}/messages`, `/api/threads/${bot.threadId}/export`, `/api/threads/${bot.threadId}/messages/missing/image`]) {
      expect((await fetch(fixture.info.url+path,{headers:{authorization:`Bearer ${guest.token}`}})).status,path).toBe(404);
    }
    for (const path of ['/api/search?q=Owner-private', '/api/events', '/api/events?since=old:1']) {
      expect((await fetch(fixture.info.url+path,{headers:{authorization:`Bearer ${guest.token}`}})).status,path).toBe(403);
    }
    const ownerPair=(await api('POST','/api/auth/pairing',{scopes:['client']})).body;
    const ownerPhone=(await api('POST','/api/auth/pair',{code:ownerPair.code,label:'Owner phone fixture'})).body;
    expect((await api('GET','/api/bots',undefined,ownerPhone.token)).body.bots.some((b:any)=>b.id===bot.id)).toBe(true);
    expect((await fetch(fixture.info.url+avatar,{headers:{authorization:`Bearer ${guest.token}`}})).status).toBe(404);
    expect((await fetch(fixture.info.url+avatar,{headers:{authorization:`Bearer ${ownerPhone.token}`}})).status).toBe(200);
  }finally{streamAbort.abort();await readStream?.catch(()=>{});await fixture.close();}
},45000);
