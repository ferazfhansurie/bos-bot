// Explicit, tool-capable zero-price OpenRouter connection. Never inherits keys.
import type { ModelCatalog, ProviderDriver } from '../contracts.ts';
import { createOpenAIChatRuntime } from './openai-chat.ts';
const API='https://openrouter.ai/api/v1';
// BOS-hosted relay: owner key stays server-side; installs hold a capped per-install token.
export const BOS_FREE_API=process.env.BOS_FREE_URL||'https://bos-free.aihlete.com/api/v1';
const DEFAULT_MODEL='openrouter/free';
// the hosted relay serves one model; its id keeps the :free shape older installs accept
export const BOS_FREE_MODEL='bos-free/deepseek-v4-flash:free';
export const BOS_FREE_NAME='BOS Free · DeepSeek V4 Flash';
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
 const model=config.model??DEFAULT_MODEL;if(!isFreeId(model))throw new Error('OpenRouter free requires openrouter/free or an explicit :free model');
 return {model,...(config.hosted?{hosted:true}:{}),...(typeof config.key==='string'&&config.key.trim()?{key:config.key.trim()}:{})};
}
const hostedError=(value:unknown):Error=>{
 const error=value instanceof Error?value:new Error('');
 if(error.name==='AbortError'||error.name==='TimeoutError')return new Error('BOS Free request interrupted or timed out');
 const status=error.message.match(/HTTP (\d{3})/);
 if(status?.[1]==='429')return new Error('BOS Free is busy or today\'s limit for this install is used up. Try again in a minute (HTTP 429).');
 if(status?.[1]==='401')return new Error('The free connection needs reconnecting: Settings → Engines → Reconnect (HTTP 401).');
 if(status)return new Error(`BOS Free couldn't answer this time. Try again in a moment (HTTP ${status[1]}).`);
 if(['OpenRouter free key required','OpenRouter free catalog unavailable'].includes(error.message))return new Error(error.message.replace('OpenRouter free','BOS Free'));
 return new Error('BOS Free couldn\'t answer this time. Try again in a moment.');
};
const safeError=(value:unknown):Error=>{
 const error=value instanceof Error?value:new Error('');
 if(error.name==='AbortError'||error.name==='TimeoutError')return new Error('OpenRouter free request interrupted or timed out');
 const status=error.message.match(/HTTP (\d{3})/);
 if(status?.[1]==='429')return new Error('Free models are busy or today\'s free limit is used up. Try again in a minute; no paid model is used (HTTP 429).');
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
  const config=decodeConfig(input.config);const apiKey=config.key??'';const apiUrl=config.hosted?BOS_FREE_API:API;
  let catalog:ModelCatalog={default:config.model??DEFAULT_MODEL,options:[]};
  let catalogError='OpenRouter free catalog unavailable';
  const refresh=async(signal?:AbortSignal)=>{
   try{
    const response=await fetch(`${apiUrl}/models`,{redirect:'error',...(config.hosted?{headers:{Authorization:`Bearer ${apiKey}`}}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('catalog unavailable');
    const json=await response.json() as {data?:unknown};if(!Array.isArray(json.data))throw new Error('catalog unavailable');
    const seen=new Set<string>();const options:ModelCatalog['options']=[];
    for(const value of json.data){if(!isFreeToolModel(value))continue;const row=value as {id:string;name?:unknown};if(seen.has(row.id))continue;seen.add(row.id);options.push({id:row.id,label:typeof row.name==='string'?row.name:row.id,custom:true});}
    // hosted installs set up before the relay moved to Luna keep an old id; the relay serves them with its own model
    const model=config.model??DEFAULT_MODEL;
    catalog={default:config.hosted&&!options.some(option=>option.id===model)&&options[0]?options[0].id:model,options};catalogError='';
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
    if(!isFreeId(model))throw new Error('OpenRouter free model is not currently verified zero-price and tool-capable');
    await refresh(signal);
    if(!config.hosted&&!catalog.options.some(option=>option.id===model))throw new Error('OpenRouter free model is not currently verified zero-price and tool-capable');
   },
   sanitizeError:config.hosted?hostedError:safeError,redirect:'error',
   requestBody:(model,messages,stream)=>({model,messages,stream,max_tokens:4096,stream_options:stream?{include_usage:true}:undefined,provider:{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}}}),
   httpErrorLabel:config.hosted?'BOS Free':'OpenRouter free',missingKeyError:'OpenRouter free key required',unavailableReason:'OpenRouter free key required',timeoutMs:60_000,reasoning:true,includeUsageInCompleted:true,
   nativeLog:{source:'openrouter-free.chat.completions',outgoing:(_turn,messages,model)=>({model,messageCount:messages.length}),incoming:({text,usage})=>({textLength:text.length,usage})},
  });
  // Catalog health and configured credentials are not an authenticated inference claim.
  runtime.snapshot=async()=>!apiKey?{state:'unavailable',reason:'OpenRouter free key required'}:catalogError||!catalog.options.some(x=>x.id===catalog.default)?{state:'unavailable',reason:catalogError||'Selected free model is unavailable'}:{state:'available',version:null};
  return runtime;
 },
};
