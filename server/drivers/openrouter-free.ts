import { compatEnv } from "../../electron/branding-env.cjs";
// Explicit, tool-capable zero-price OpenRouter connection. Never inherits keys.
import type { ModelCatalog, ProviderDriver } from '../contracts.ts';
import { createOpenAIChatRuntime } from './openai-chat.ts';
const API='https://openrouter.ai/api/v1';
// BOS AI: firaz's relay keeps the OpenRouter key server-side. An install holds a
// per-person token that spends a $1 free credit, then the person's bosbot credit.
export const BOS_FREE_API=compatEnv.BOS_FREE_URL||'https://bos-free.aihlete.com/api/v1';
export const BOS_AI_URL=`${BOS_FREE_API}/trial`;
export const BOS_AI_MODEL='gpt-6-luna';
export const BOS_AI_NAME='BOS AI';
export const BOS_AI_TOPUP='https://app.bosbot.my/__bos/offer';
const DEFAULT_MODEL='openrouter/free';
const isRelayId=(id:unknown):id is string=>typeof id==='string'&&/^[a-z0-9][a-z0-9.-]{1,60}$/.test(id);
const isFreeId=(id:unknown):id is string=>typeof id==='string'&&(id===DEFAULT_MODEL||/^[a-zA-Z0-9_./-]+:free$/.test(id));
const zero=(value:unknown)=>((typeof value==='string'&&value.trim()!=='')||typeof value==='number')&&Number.isFinite(Number(value))&&Number(value)===0;
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function isFreeToolModel(value:unknown):boolean{
 const row=record(value);const pricing=record(row?.pricing);
 return !!row&&isFreeId(row.id)&&!!pricing&&zero(pricing.prompt)&&zero(pricing.completion)&&Object.values(pricing).every(zero)&&Array.isArray(row.supported_parameters)&&row.supported_parameters.includes('tools');
}
export interface OpenRouterFreeConfig {key?:string;model?:string;hosted?:boolean;}
function decodeConfig(raw:unknown):OpenRouterFreeConfig{
 const config=record(raw??{});if(!config)throw new Error('OpenRouter free config must be an object');
 if(Object.keys(config).some(key=>!['key','model','hosted'].includes(key)))throw new Error('OpenRouter free config accepts only key, model and hosted');
 if(config.hosted!==undefined&&typeof config.hosted!=='boolean')throw new Error('OpenRouter free hosted must be a boolean');
 if(config.key!==undefined&&typeof config.key!=='string')throw new Error('OpenRouter free key must be a string');
 // hosted installs from before BOS AI keep a retired :free id; the relay's default replaces it
 let model:string;
 if(config.hosted)model=isRelayId(config.model)?config.model:BOS_AI_MODEL;
 else{const raw=config.model??DEFAULT_MODEL;if(!isFreeId(raw))throw new Error('OpenRouter free requires openrouter/free or an explicit :free model');model=raw;}
 return {model,...(config.hosted?{hosted:true}:{}),...(typeof config.key==='string'&&config.key.trim()?{key:config.key.trim()}:{})};
}
const OWN=' Or connect your own Claude or ChatGPT in Settings → Engines.';
/** The relay's 402/429 bodies carry a code; the message is written here so it never depends on a cut body. */
export const hostedError=(value:unknown):Error=>{
 const error=value instanceof Error?value:new Error('');
 if(error.name==='AbortError'||error.name==='TimeoutError')return new Error('BOS AI request interrupted or timed out');
 const status=error.message.match(/HTTP (\d{3})/);
 const code=error.message.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1];
 if(status?.[1]==='402'){
  if(code==='too_big')return new Error(`This message is too big for the free credit you have left. Pick a cheaper model like GPT-6 Luna, start a new chat, or add credit: ${BOS_AI_TOPUP}`);
  if(code==='on_hold')return new Error(`Your BOS credit is on hold while a payment is reviewed, so AI is paused. Details: ${BOS_AI_TOPUP}`);
  if(code==='month_full')return new Error(`Free AI is at capacity this month. Add credit to keep going: ${BOS_AI_TOPUP} , then press Use my bosbot credit in Settings → Engines.${OWN}`);
  return new Error(`Your free AI credit is used up. Add credit to keep going: ${BOS_AI_TOPUP} , then press Use my bosbot credit in Settings → Engines.${OWN}`);
 }
 if(status?.[1]==='429')return new Error(code==='busy'?'BOS AI is already answering a few messages for you. Try again in a moment (HTTP 429).':'BOS AI is busy right now. Try again in a moment (HTTP 429).');
 if(status?.[1]==='503'&&code==='wallet_unavailable')return new Error('BOS could not check your credit just now. Try again in a minute (HTTP 503).');
 if(status?.[1]==='401'||status?.[1]==='403')return new Error(`BOS AI needs turning on again: Settings → Engines → BOS AI (HTTP ${status[1]}).`);
 if(status)return new Error(`BOS AI couldn't answer this time. Try again in a moment (HTTP ${status[1]}).`);
 if(['OpenRouter free key required','OpenRouter free catalog unavailable'].includes(error.message))return new Error(error.message.replace('OpenRouter free','BOS AI'));
 return new Error('BOS AI couldn\'t answer this time. Try again in a moment.');
};
const safeError=(value:unknown):Error=>{
 const error=value instanceof Error?value:new Error('');
 if(error.name==='AbortError'||error.name==='TimeoutError')return new Error('OpenRouter free request interrupted or timed out');
 const status=error.message.match(/HTTP (\d{3})/);
 if(status?.[1]==='429')return new Error('Free models are busy or today\'s free limit is used up. Availability may be limited until the quota resets. Retry when available; no paid model is used (HTTP 429).');
 if(status?.[1]==='401')return new Error('The free connection needs reconnecting: Settings → Engines → Reconnect (HTTP 401).');
 if(status)return new Error(`The free models couldn't answer this time. Try again in a moment; no paid model is used (HTTP ${status[1]}).`);
 if(['OpenRouter free key required','OpenRouter free model is not currently verified zero-price and tool-capable','OpenRouter free catalog unavailable'].includes(error.message))return new Error(error.message);
 return new Error('The free models couldn\'t answer this time. Try again in a moment; no paid model is used.');
};
export const OpenRouterFreeDriver:ProviderDriver<OpenRouterFreeConfig>={
 driverKind:'openrouter-free',
 metadata:{displayName:'OpenRouter Free',supportsMultipleInstances:true,access:'custom'},
 models:{default:DEFAULT_MODEL,options:[]},
 install:{docsUrl:'https://openrouter.ai/keys',signInCommand:'Connect an OpenRouter API key in BOS Free setup.'},
 decodeConfig,defaultConfig:()=>decodeConfig({}),
 async create(input){
  const config=decodeConfig(input.config);const apiKey=config.key??'';const apiUrl=config.hosted?BOS_AI_URL:API;
  let catalog:ModelCatalog={default:config.model??DEFAULT_MODEL,options:[]};
  let catalogError='OpenRouter free catalog unavailable';
  const refresh=async(signal?:AbortSignal)=>{
   try{
    const response=await fetch(`${apiUrl}/models`,{redirect:'error',...(config.hosted?{headers:{Authorization:`Bearer ${apiKey}`}}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('catalog unavailable');
    const json=await response.json() as {data?:unknown};if(!Array.isArray(json.data))throw new Error('catalog unavailable');
    const seen=new Set<string>();const options:ModelCatalog['options']=[];
    for(const value of json.data){
     // BOS AI lists its curated models cheap → best, each label saying how many messages are left
     if(config.hosted){const row=record(value);if(!row||!isRelayId(row.id)||seen.has(row.id))continue;seen.add(row.id);options.push({id:row.id,label:typeof row.label==='string'?row.label.slice(0,80):row.id,custom:true});continue;}
     if(!isFreeToolModel(value))continue;const row=value as {id:string;name?:unknown};if(seen.has(row.id))continue;seen.add(row.id);options.push({id:row.id,label:typeof row.name==='string'?row.name:row.id,custom:true});
    }
    const model=config.model??DEFAULT_MODEL;
    const relayDefault=typeof (json as {default?:unknown}).default==='string'?String((json as {default?:unknown}).default):BOS_AI_MODEL;
    catalog={default:config.hosted&&!options.some(option=>option.id===model)?(options.find(option=>option.id===relayDefault)??options[0])?.id??model:model,options};catalogError='';
   }catch{
    catalog={default:config.model??DEFAULT_MODEL,options:[]};catalogError='OpenRouter free catalog unavailable';throw new Error(catalogError);
   }
  };
  if(apiKey)await refresh().catch(()=>{});
  const runtime=createOpenAIChatRuntime({
   input,driverKind:'openrouter-free',apiKey,apiUrl,tools:true,models:()=>catalog,
   refreshModels:async()=>{if(apiKey)await refresh();},
   beforeRequest:async(model,signal)=>{
    if(!apiKey)throw new Error('OpenRouter free key required');
    if(config.hosted?!isRelayId(model):!isFreeId(model))throw new Error('OpenRouter free model is not currently verified zero-price and tool-capable');
    await refresh(signal);
    if(!catalog.options.some(option=>option.id===model))throw new Error('OpenRouter free model is not currently verified zero-price and tool-capable');
   },
   sanitizeError:config.hosted?hostedError:safeError,redirect:'error',
   // BOS AI meters each call on the relay, which sets the provider and price caps itself
   requestBody:(model,messages,stream)=>config.hosted?{model,messages,stream,max_tokens:8192,stream_options:stream?{include_usage:true}:undefined}:{model,messages,stream,max_tokens:4096,stream_options:stream?{include_usage:true}:undefined,provider:{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}}},
   httpErrorLabel:config.hosted?'BOS AI':'OpenRouter free',missingKeyError:'OpenRouter free key required',unavailableReason:'OpenRouter free key required',timeoutMs:60_000,reasoning:true,includeUsageInCompleted:true,
   nativeLog:{source:'openrouter-free.chat.completions',outgoing:(_turn,messages,model)=>({model,messageCount:messages.length}),incoming:({text,usage})=>({textLength:text.length,usage})},
  });
  // Catalog health and configured credentials are not an authenticated inference claim.
  runtime.snapshot=async()=>!apiKey?{state:'unavailable',reason:'OpenRouter free key required'}:catalogError||!catalog.options.some(x=>x.id===catalog.default)?{state:'unavailable',reason:catalogError||'Selected free model is unavailable'}:{state:'available',version:null};
  return runtime;
 },
};
