import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFirstAssignment } from "../src/lib/first-assignment.ts";
import { firstAssignment } from "../shared/bos-onboarding.ts";

it("starts the first business assignment on its pinned task and reconciles a lost response",async()=>{
  const fixture=await launchVerificationServer({...process.env,FAKE_CLAUDE_REPLIES:JSON.stringify(["Here is the synthetic result. What revision would you like?"]),FAKE_CLAUDE_TOOL_CALLS:"[]"});
  const api=async(path:string,options?:{method?:string;body?:string;timeoutMs?:number})=>{
    const response=await fetch(fixture.info.url+path,{method:options?.method??"GET",body:options?.body,headers:{"content-type":"application/json",origin:fixture.info.url},signal:AbortSignal.timeout(20000)});
    const data=await response.json() as any;
    if(!response.ok)throw new Error(`${response.status}: ${data.error}`);
    return data;
  };
  try{
    const bots=(await api("/api/bots")).bots;
    const bos=bots.find((bot:any)=>bot.name==="BOS");
    expect(bos).toMatchObject({chiefOfStaff:true});
    const text=firstAssignment({business:"Fixture bakery",customers:"Local families",outcome:"website",approach:"bos"});
    const proposed={botId:bos.id,threadId:bos.threadId,sendId:`onboarding_${bos.threadId}`,text,selection:{instanceId:"claude",model:"claude-sonnet-5"}};
    let lost=false;
    await expect(startFirstAssignment(async(path,options)=>{
      const result=await api(path,options);
      if(path.endsWith("/messages") && options?.method==="POST" && !lost){lost=true;throw new Error("synthetic response loss");}
      return result;
    },proposed)).rejects.toThrow("synthetic response loss");
    await expect.poll(async()=>{
      const row=(await api("/api/bots")).bots.find((bot:any)=>bot.id===bos.id);
      return row.busy;
    },{timeout:15000,interval:100}).toBe(false);
    const result=await startFirstAssignment(api); // reload recovery needs no current provider selection
    expect(result.assignment.threadId).toBe(bos.threadId);
    const rows=(await api(`/api/threads/${bos.threadId}/messages`)).messages;
    expect(rows.filter((row:any)=>row.sendId===proposed.sendId)).toHaveLength(1);
    expect(rows.filter((row:any)=>row.text===text)).toHaveLength(1);
    expect(rows.some((row:any)=>row.text.includes("synthetic result"))).toBe(true);
    expect(result.config.onboarding.completedAt).toBeTruthy();
    const pairing=await api("/api/auth/pairing",{method:"POST",body:JSON.stringify({scopes:["client"]})});
    const client=await api("/api/auth/pair",{method:"POST",body:JSON.stringify({code:pairing.code,label:"onboarding read-only fixture"})});
    const visible=await (await fetch(fixture.info.url+"/api/config",{headers:{authorization:`Bearer ${client.token}`}})).json() as any;
    expect(visible.onboarding.completedAt).toBeTruthy();
    expect(visible.onboarding).not.toHaveProperty("firstAssignment");
    expect(visible.onboarding).not.toHaveProperty("businessBrief");
  }finally{await fixture.close();}
},40000);

it("keeps owner-supplied first bot identity and scopes idempotent coordinator setup to admins",async()=>{
  const fixture=await launchVerificationServer();
  const api=async(method:string,path:string,body?:unknown,token?:string)=>{
    const response=await fetch(fixture.info.url+path,{method,headers:{"content-type":"application/json",origin:fixture.info.url,...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    return {status:response.status,body:await response.json() as any};
  };
  try{
    const before=(await api("GET","/api/bots")).body.bots;
    for(const bot of before)expect((await api("DELETE",`/api/bots/${bot.id}`)).status).toBe(200);
    expect((await api("GET","/api/bots")).body.bots).toHaveLength(0);
    const created=await api("POST","/api/bots",{name:"My analyst",soul:"Only analyse my synthetic fixture reports.",description:"Fixture-owned analyst",modelSelection:{instanceId:"claude",model:"claude-sonnet-5"},requireAvailableModel:true});
    expect(created.status).toBe(201);
    expect(created.body.bot).toMatchObject({name:"My analyst",soul:"Only analyse my synthetic fixture reports.",description:"Fixture-owned analyst"});
    expect(created.body.bot.chiefOfStaff).not.toBe(true);
    const pairing=(await api("POST","/api/auth/pairing",{scopes:["client"]})).body;
    const client=(await api("POST","/api/auth/pair",{code:pairing.code,label:"read-only onboarding fixture"})).body;
    expect((await api("POST","/api/onboarding/chief",{},client.token)).status).toBe(403);
    expect((await api("GET","/api/bots")).body.bots).toHaveLength(1);
    const chief=await api("POST","/api/onboarding/chief",{});
    expect(chief.status).toBe(200);expect(chief.body.bot).toMatchObject({name:"BOS",chiefOfStaff:true});
    const repeated=await api("POST","/api/onboarding/chief",{});
    expect(repeated.status).toBe(200);expect(repeated.body.bot.id).toBe(chief.body.bot.id);
    const after=(await api("GET","/api/bots")).body.bots;
    expect(after).toHaveLength(2);
    expect(after.find((bot:any)=>bot.id===created.body.bot.id)).toMatchObject({name:"My analyst",soul:"Only analyse my synthetic fixture reports.",description:"Fixture-owned analyst"});
    await api("PATCH",`/api/bots/${chief.body.bot.id}`,{name:"Jarvis",soul:"Keep this established coordinator."});
    const existing=(await api("POST","/api/onboarding/chief",{})).body.bot;
    expect(existing).toMatchObject({id:chief.body.bot.id,name:"Jarvis",soul:"Keep this established coordinator.",chiefOfStaff:true});
  }finally{await fixture.close();}
},40000);
