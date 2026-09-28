#!/usr/bin/env node
// Synthetic data only. Explicit environment key only; no credential-store lookup, tools, paid fallback, or retries.
import { pathToFileURL } from 'node:url';
const API='https://openrouter.ai/api/v1';
export const tasks=[
 {id:'website',prompt:'Return only a complete self-contained HTML document, no markdown. Build a compact responsive Sunrise Bakery landing page with inline CSS, viewport metadata, semantic main and h1, products section id=products listing Bread, Croissant and Cake, contact section id=contact with hello@example.invalid, and an Order link to #contact. No JavaScript, external URLs, remote images or dependencies. Keep it under 600 words.'},
 {id:'dashboard',prompt:'Return JSON only with revenue and conversionRate. Synthetic dashboard: orders [{amount:80,status:"paid"},{amount:50,status:"paid"},{amount:40,status:"refunded"}]; sessions=8; conversions=2. Revenue excludes refunds. conversionRate is a fraction, not percent.'},
 {id:'onboarding',prompt:'Return JSON only: steps (array), requiresPayment (boolean), retryOn401 (boolean). Design free-model onboarding: choose provider, connect key, choose a verified zero-price model, send a synthetic test. Do not require billing. A 401 must return to credentials, never repeatedly retry. Use exactly these step IDs in order: provider, credentials, free-model, test.'},
];
const zero=x=>(typeof x==='string'&&x.trim()!==''||typeof x==='number')&&Number.isFinite(Number(x))&&Number(x)===0;
export function eligible(m){
 return typeof m?.id==='string' && m.id.endsWith(':free') && m.pricing && zero(m.pricing.prompt)&&zero(m.pricing.completion)&&Object.values(m.pricing).every(zero);
}
export function requestBody(model,task){
 return {model,messages:[{role:'user',content:task.prompt}],temperature:0,max_tokens:900,stream:false,provider:{allow_fallbacks:false,max_price:{prompt:0,completion:0}}};
}
export function score(id,content){
 if(typeof content!=='string')return 0;
 if(id==='website'){
  const structure=/<html\b/i.test(content)&&/<main\b/i.test(content)&&/<h1\b/i.test(content)&&/name=[\"']viewport[\"']/i.test(content)&&/<style\b/i.test(content)&&/<\/html>/i.test(content);
  const complete=['Sunrise Bakery','Bread','Croissant','Cake','hello@example.invalid'].every(x=>content.includes(x))&&/id=[\"']products[\"']/i.test(content)&&/id=[\"']contact[\"']/i.test(content)&&/href=[\"']#contact[\"']/i.test(content)&&!/<script\b|https?:\/\//i.test(content);
  return Number(structure)+Number(structure&&complete);
 }
 let a; try{a=JSON.parse(content);}catch{return 0;}
 if(!a||typeof a!=='object')return 0;
 if(id==='dashboard')return Number(a.revenue===130)+Number(a.conversionRate===0.25);
 if(id==='onboarding')return Number(JSON.stringify(a.steps)===JSON.stringify(['provider','credentials','free-model','test']))+Number(a.requiresPayment===false&&a.retryOn401===false);
 return 0;
}
async function jsonFetch(url,options={}){
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error(`HTTP ${r.status}`);
 const body=await r.text(); if(body.length>5_000_000)throw new Error('response too large');
 return JSON.parse(body);
}
export async function main(args=process.argv.slice(2),env=process.env){
 if(args.some(x=>!['--catalog','--run-public','--run'].includes(x)&&!x.startsWith('--models=')))throw new Error('invalid arguments');
 const run=args.includes('--run');
 const shortlist=args.find(x=>x.startsWith('--models='))?.slice(9).split(',')??[];
 if(run&&(args.includes('--catalog')||args.includes('--run-public')||shortlist.length<1||shortlist.length>3||new Set(shortlist).size!==shortlist.length||shortlist.some(x=>!/^[-a-zA-Z0-9_./]+:free$/.test(x))))throw new Error('use --run --models=one:free,two:free with 1-3 unique free IDs');
 if(!run&&shortlist.length)throw new Error('--models requires --run');
 const apiKey=run?env.OPENROUTER_API_KEY:undefined;
 if(run&&!(typeof apiKey==='string'&&apiKey.trim()))return {status:'blocked',winner:null,blocker:'OPENROUTER_API_KEY is required'};
 if(!args.length)return {status:'offline-ready',tasks:tasks.map(x=>x.id),winner:null,blocker:'Live inference not run. Official provider onboarding requires a key; provide OPENROUTER_API_KEY explicitly with --run and a free-model shortlist.'};
 const catalog=await jsonFetch(`${API}/models`);
 const candidates=(catalog.data??[]).filter(eligible).sort((a,b)=>a.id.localeCompare(b.id));
 const report={observedAt:new Date().toISOString(),source:`${API}/models`,status:'catalog-only',candidates:candidates.map(x=>({id:x.id,pricing:x.pricing})),results:[],winner:null};
 if(!run&&!args.includes('--run-public'))return report;
 const selected=run?shortlist.map(id=>candidates.find(x=>x.id===id)):candidates.slice(0,3);
 if(selected.some(x=>!x))return {...report,status:'blocked',blocker:'shortlist model missing or not zero-price'};
 report.status=run?'authenticated-inference':'public-inference';
 // Explicit deterministic shortlist; never silently compare changing automatic routers.
 for(const model of selected)for(const task of tasks){
  if(report.results.length)await new Promise(r=>setTimeout(r,3100));
  const started=Date.now();
  try{
   // Revalidate before each request; stale/unknown pricing closes the circuit.
   const latest=await jsonFetch(`${API}/models`);
   if(!eligible(latest.data?.find(x=>x.id===model.id)))throw new Error('zero-price gate failed');
   const answer=await jsonFetch(`${API}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})},body:JSON.stringify(requestBody(model.id,task))});
   if(answer.usage?.cost!=null&&!zero(answer.usage.cost))throw new Error('nonzero reported cost');
   const rawContent=answer.choices?.[0]?.message?.content;
   const content=typeof rawContent==='string'?(apiKey?rawContent.replaceAll(apiKey,'[redacted]'):rawContent):'';
   report.results.push({model:model.id,task:task.id,elapsedMs:Date.now()-started,score:score(task.id,content),outOf:2,content});
  }catch(e){report.status='blocked';report.blocker=safeError(e);return report;}
 }
 report.status='smoke-complete';report.limitation='Three synthetic deliverable/structured-output probes per model are not a coding or intelligence ranking. Review generated UI and run repeated tasks before selecting a default.';
 return report;
}
function safeError(e){return /^HTTP \d{3}$/.test(e.message)||['zero-price gate failed','nonzero reported cost','response too large'].includes(e.message)?e.message:'request failed or invalid arguments';}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(JSON.stringify({status:'blocked',reason:safeError(e),winner:null}));process.exitCode=1;});
}
