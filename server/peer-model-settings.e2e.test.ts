import {expect,it} from 'vitest';
import {launchVerificationServer} from '../scripts/control-omb.ts';
it('changes only a peer-owned conversation using the actual host catalog',async()=>{
 const fixture=await launchVerificationServer();
 const api=async(method:string,path:string,body?:unknown,token?:string)=>{const res=await fetch(fixture.info.url+path,{method,headers:{'content-type':'application/json',origin:fixture.info.url,...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json() as any};};
 try{
  const created=await api('POST','/api/bots',{name:'Peer model fixture',modelSelection:{instanceId:'claude',model:'claude-sonnet-5'},requireAvailableModel:true});expect(created.status).toBe(201);const bot=created.body.bot;
  const code=(await api('POST','/api/auth/pairing',{scopes:['peer']})).body.code;
  const token=(await api('POST','/api/auth/pair',{code,label:'Scoped model fixture'})).body.token;
  expect(token).toBeTruthy();
  const catalog=await api('GET',`/api/bots/${bot.id}/model-catalog`,undefined,token);expect(catalog.status).toBe(200);
  const claude=catalog.body.instances.find((i:any)=>i.instanceId==='claude');expect(claude).toBeTruthy();expect(claude).not.toHaveProperty('install');expect(claude).not.toHaveProperty('cli');expect(claude.snapshot).not.toHaveProperty('account');
  const own=(await api('POST',`/api/bots/${bot.id}/tasks`,{title:'Peer conversation'},token)).body.task;expect(own).toBeTruthy();
  const selection={instanceId:'claude',model:claude.models.options.find((m:any)=>m.id!==bot.modelSelection.model).id};
  const path=`/api/bots/${bot.id}/tasks/${own.threadId}`;
  const changed=await api('PATCH',path,{modelSelection:selection,requireAvailableModel:true},token);expect(changed.status).toBe(200);expect(changed.body.task.modelSelection.model).toBe(selection.model);expect(changed.body.bot).not.toHaveProperty('cwd');expect(changed.body.bot).not.toHaveProperty('soul');
  const ownerTask=(await api('POST',`/api/bots/${bot.id}/tasks`,{title:'Private owner task'})).body.task;
  expect((await api('PATCH',`/api/bots/${bot.id}/tasks/${ownerTask.threadId}`,{modelSelection:selection},token)).status).toBe(403);
  for(const body of [{modelSelection:selection,updateBotDefault:true},{approvalMode:'full'},{autoApprove:true},{projectId:'owner'},{surface:'local'}])expect((await api('PATCH',path,body,token)).status).toBe(403);
  expect((await api('PATCH',path,{modelSelection:{instanceId:'mac-only-account',model:'sonnet'},requireAvailableModel:false},token)).status).toBe(400);
  const read=await api('GET','/api/bots?messages=0');expect(read.body.bots.find((b:any)=>b.id===bot.id).modelSelection).toEqual(bot.modelSelection);
  expect((await api('GET','/api/instances',undefined,token)).status).toBe(403);
 }finally{await fixture.close();}
},40000);
