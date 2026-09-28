import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterFreeDriver, isFreeToolModel } from './openrouter-free.ts';
const row={id:'openrouter/free',name:'Free',pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const create=(key?:string)=>OpenRouterFreeDriver.create({instanceId:'fixture-free',displayName:'Free fixture',enabled:true,config:{key,model:'openrouter/free'},environment:{OPENROUTER_API_KEY:'must-not-use'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('OpenRouter free driver',()=>{
 it('accepts only zero-price tool-capable free model rows',()=>{
  expect(isFreeToolModel(row)).toBe(true);
  for(const bad of [{...row,id:'vendor/paid'},{...row,pricing:{prompt:'0'}},{...row,pricing:{prompt:'',completion:'0'}},{...row,pricing:{...row.pricing,request:'0.01'}},{...row,supported_parameters:[]}])expect(isFreeToolModel(bad)).toBe(false);
 });
 it('rejects paid models and endpoint or environment overrides',()=>{
  expect(OpenRouterFreeDriver.defaultConfig()).toEqual({model:'openrouter/free'});
  for(const config of [{model:'vendor/paid'},{url:'https://evil.invalid'},{apiKeyEnv:'OTHER_KEY'}])expect(()=>OpenRouterFreeDriver.decodeConfig(config)).toThrow();
 });
 it('does not inherit environment credentials or call network without key',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const inst=await create();
  expect((await inst.snapshot()).state).toBe('unavailable');
  await expect(inst.generateText!('synthetic')).rejects.toThrow('key');expect(fetch).not.toHaveBeenCalled();await inst.dispose();
 });
 it('revalidates and fixes zero-price request routing',async()=>{
  const fetch=vi.fn(async(url:unknown)=>String(url).endsWith('/models')?response({data:[row]}):response({choices:[{message:{content:'ok'}}]}));vi.stubGlobal('fetch',fetch);
  const inst=await create('fixture-key');expect(await inst.generateText!('synthetic')).toBe('ok');
  expect(fetch.mock.calls.filter(x=>String(x[0]).endsWith('/models')).length).toBe(2);
  const calls=fetch.mock.calls as unknown as Array<[string,RequestInit]>;const completion=calls.find(x=>x[0].endsWith('/chat/completions'))!;
  expect(completion[0]).toBe('https://openrouter.ai/api/v1/chat/completions');expect(completion[1].redirect).toBe('error');
  expect(JSON.parse(String(completion[1].body)).provider).toEqual({allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}});
  expect(inst.adapter.capabilities).toMatchObject({agentsMcp:true,customMcp:true});await inst.dispose();
 });
 it('fails closed after catalog price changes without completion',async()=>{
  let count=0;const fetch=vi.fn(async()=>response({data:[++count===1?row:{...row,pricing:{prompt:'1',completion:'0'}}]}));vi.stubGlobal('fetch',fetch);
  const inst=await create('fixture-key');await expect(inst.generateText!('synthetic')).rejects.toThrow('not currently');expect(count).toBe(2);await inst.dispose();
 });
 it('suppresses provider error bodies and never retries quota errors',async()=>{
  const key='synthetic-secret';const fetch=vi.fn(async(url:unknown)=>String(url).endsWith('/models')?response({data:[row]}):response({error:key},429));vi.stubGlobal('fetch',fetch);
  const inst=await create(key);await expect(inst.generateText!('synthetic')).rejects.toThrow('HTTP 429');expect(fetch.mock.calls.length).toBe(3);await inst.dispose();
 });
});
