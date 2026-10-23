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
 const trial={models:[],default:'gpt-6-luna',left:0.9,cap:1,data:[{id:'gpt-6-luna',label:'GPT-6 Luna · ~450 free messages left'},{id:'claude-opus-5.5',label:'Claude Opus 5.5 · ~11 free messages left'}]};
 const hosted=(model?:string)=>OpenRouterFreeDriver.create({instanceId:'fixture-free',displayName:'BOS AI',enabled:true,config:{key:'bosf_fixture',hosted:true,...(model?{model}:{})},environment:{OPENROUTER_API_KEY:'must-not-use'}});
 it('BOS AI uses the metered trial relay with the install token only',async()=>{
  const fetch=vi.fn(async(url:unknown)=>String(url).endsWith('/models')?response(trial):response({choices:[{message:{content:'ok'}}]}));vi.stubGlobal('fetch',fetch);
  expect(OpenRouterFreeDriver.decodeConfig({key:'bosf_x',hosted:true})).toEqual({model:'gpt-6-luna',hosted:true,key:'bosf_x'});
  expect(()=>OpenRouterFreeDriver.decodeConfig({hosted:'yes'})).toThrow();
  const inst=await hosted('gpt-6-luna');
  expect(inst.models.options.map(x=>x.id)).toEqual(['gpt-6-luna','claude-opus-5.5']);
  expect(inst.models.options[1]!.label).toBe('Claude Opus 5.5 · ~11 free messages left');
  expect(await inst.generateText!('synthetic')).toBe('ok');
  const calls=fetch.mock.calls as unknown as Array<[string,RequestInit]>;
  expect(calls.every(([url])=>url.startsWith('https://bos-free.aihlete.com/api/v1/trial/'))).toBe(true);
  const models=calls.find(x=>x[0].endsWith('/models'))!;expect((models[1].headers as Record<string,string>).Authorization).toBe('Bearer bosf_fixture');
  const body=JSON.parse(String(calls.find(x=>x[0].endsWith('/chat/completions'))![1].body));
  expect(body).toMatchObject({model:'gpt-6-luna',max_tokens:8192});expect(body.provider).toBeUndefined();
  expect(JSON.stringify(calls)).not.toContain('must-not-use');await inst.dispose();
 });
 it('installs from the deepseek relay move to the BOS AI default',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response(trial)));
  const inst=await hosted('bos-free/deepseek-v4-flash:free');
  expect(await inst.snapshot()).toMatchObject({state:'available'});expect(inst.models.default).toBe('gpt-6-luna');await inst.dispose();
 });
 it('turns relay credit codes into a top-up link or connect-your-own, never the raw body',async()=>{
  for(const [status,code,text] of [[402,'no_credit','free AI credit is used up'],[402,'month_full','at capacity this month'],[402,'too_big','too big for the free credit'],[402,'on_hold','on hold'],[429,'busy','already answering'],[401,'','turning on again']] as const){
   vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).endsWith('/models')?response(trial):response({error:{code,message:'synthetic-relay-body'}},status)));
   const inst=await hosted();const failure=inst.generateText!('synthetic');
   await expect(failure).rejects.toThrow(text);await expect(failure).rejects.not.toThrow('synthetic-relay-body');
   if(status===402&&code!=='on_hold'&&code!=='too_big')await expect(failure).rejects.toThrow('https://app.bosbot.my/__bos/offer');
   if(code==='no_credit')await expect(failure).rejects.toThrow('connect your own Claude or ChatGPT');
   await inst.dispose();
  }
 });
});
