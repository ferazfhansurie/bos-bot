import { expect, it, vi } from "vitest";
import { startFirstAssignment } from "./first-assignment";
import type { FirstAssignment } from "../../shared/bos-onboarding";

const proposed: FirstAssignment={botId:"bos",threadId:"original-thread",sendId:"onboarding_original-thread",text:"Build a website for my bakery",selection:{instanceId:"fixture",model:"model"}};
it("recovers the exact durable request after reload and an uncertain response",async()=>{
  let config:any={onboarding:{}};
  let fail=true;
  const sends:any[]=[];
  const request=vi.fn(async(path:string,options?:any)=>{
    if(path==="/api/config"){
      if(options?.method==="PUT")config={onboarding:{...config.onboarding,...JSON.parse(options.body).onboarding}};
      return structuredClone(config);
    }
    if(options.method==="PATCH")return {};
    sends.push(JSON.parse(options.body));
    if(fail){fail=false;throw new Error("response lost after acceptance");}
    return {message:{id:"same-receipt"}};
  });
  await expect(startFirstAssignment(request,proposed)).rejects.toThrow("response lost");
  expect(config.onboarding.firstAssignment).toEqual({...proposed,prepared:true});
  const result=await startFirstAssignment(request,{...proposed,threadId:"different-thread",text:"different request",selection:{instanceId:"other",model:"other"}});
  expect(sends).toHaveLength(2);expect(sends[1]).toEqual(sends[0]);
  expect(sends[1].threadId).toBe("original-thread");
  expect(request.mock.calls.filter(([,options])=>options?.method==="PATCH").map(([path])=>path)).toEqual(["/api/bots/bos/tasks/original-thread"]);
  expect(result.config.onboarding.completedAt).toBeTruthy();
});
it("does not send or change the model if durable intent cannot be saved",async()=>{
  const request=vi.fn(async(_path:string,options?:any)=>{
    if(!options)return {onboarding:{}};
    throw new Error("disk full");
  });
  await expect(startFirstAssignment(request,proposed)).rejects.toThrow("disk full");
  expect(request.mock.calls.every(([path])=>path==="/api/config")).toBe(true);
});
it("retries completion only through the same accepted send id without changing a busy task model",async()=>{
  let config:any={onboarding:{firstAssignment:{...proposed,prepared:true}}};
  const request=vi.fn(async(path:string,options?:any)=>{
    if(path==="/api/config" && !options)return config;
    if(path.endsWith("/messages"))return {message:{id:"existing"}};
    config={onboarding:{...config.onboarding,...JSON.parse(options.body).onboarding}};
    return config;
  });
  await startFirstAssignment(request,proposed);
  expect(request.mock.calls.some(([,options])=>options?.method==="PATCH")).toBe(false);
});
