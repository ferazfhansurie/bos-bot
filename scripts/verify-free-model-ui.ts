// Isolated full renderer; connection responses are intercepted before any server/provider request.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runControlOmb } from './control-omb.ts';
const handle=process.argv[2];if(!handle)throw Error('Pass an isolated control-omb ui.json handle');
const ui=(verb:string,...args:string[])=>runControlOmb(['ui',verb,'--ui',handle,...args]) as Promise<Record<string,any>>;
const evaluate=async(js:string)=>(await ui('eval','--js',js)).result;
const snapshot=async()=>(await ui('snapshot')).snapshot as string;
const click=async(name:string)=>{await delay(250);if((await snapshot()).includes('Skip tour'))await ui('click','--name','Skip tour');console.log('click:',name);await ui('click','--name',name);};
const visible=async(text:string)=>{const until=Date.now()+20000;let s='';do{s=await snapshot();if(s.includes(text))return s;await delay(150);}while(Date.now()<until);throw Error(`Missing ${text}: ${s}`);};
const request=(method:string,path:string,body?:unknown)=>evaluate(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error('fixture request failed '+r.status);return data})`);
const evidence=resolve('.omb-scratch/verify-evidence/free-model-ui');mkdirSync(evidence,{recursive:true});
await request('PUT','/api/config',{profile:{name:'Free UI fixture',email:'free-ui@example.test'},onboarding:{completedAt:'2026-09-28T00:00:00.000Z',version:1}});
await evaluate('setTimeout(()=>location.reload(),0);true');await visible('Message Pepper');
await evaluate(`(()=>{
 const original=window.fetch.bind(window);const state={attempts:0,connected:false,bodyWasSynthetic:true,externalRequests:0};window.__freeUi=state;
 const model={instanceId:'bos-free',driverKind:'openrouter-free',displayName:'BOS Free · OpenRouter',access:'custom',snapshot:{state:'available'},models:{default:'openrouter/free',options:[{id:'openrouter/free',label:'Free models router',custom:true}]}};
 window.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin){state.externalRequests++;throw new Error('External requests disabled in free UI fixture');}
  if(url.pathname==='/api/onboarding/free-model'){
   state.attempts++;const body=JSON.parse(init?.body??'{}');state.bodyWasSynthetic=state.bodyWasSynthetic&&body.key==='synthetic-ui-key';
   if(state.attempts===1)return new Response(JSON.stringify({error:'Synthetic provider unavailable'}),{status:502,headers:{'content-type':'application/json'}});
   state.connected=true;const live=await(await original('/api/instances')).json();return new Response(JSON.stringify({instances:[...live.instances.filter(x=>x.instanceId!=='bos-free'),model]}),{headers:{'content-type':'application/json'}});
  }
  if(url.pathname==='/api/instances'&&state.connected){const live=await(await original(input,init)).json();return new Response(JSON.stringify({instances:[...live.instances.filter(x=>x.instanceId!=='bos-free'),model]}),{headers:{'content-type':'application/json'}});}
  return original(input,init);
 };
 return true;
})()`);
console.log('synthetic connection boundary installed');
await click('Free UI fixture');await click('Settings');await click('Engines');await visible('Start free');await click('Connect free models');
const field=await evaluate(`(()=>{const input=document.querySelector('section[aria-label="Free models"] input');return {type:input?.type,autocomplete:input?.autocomplete,value:input?.value};})()`);
assert.equal(field.type,'password');assert.equal(field.autocomplete,'off');assert.equal(field.value,'');
await ui('type','--name','OpenRouter API key','--text','synthetic-ui-key');await click('Connect and continue free');await visible('Could not connect.');
assert.equal(await evaluate(`document.querySelector('section[aria-label="Free models"] button[type="submit"]').disabled`),false);
await ui('screenshot','--out',resolve(evidence,'settings-retry.png'));
await click('Connect and continue free');await visible('Reconnect OpenRouter');await ui('screenshot','--out',resolve(evidence,'settings-connected.png'));
await click('Reconnect OpenRouter');assert.equal(await evaluate(`document.querySelector('section[aria-label="Free models"] input').value`),'');await click('Cancel');
await click('Close settings');await click('Claude Sonnet 5');await visible('BOS Free · OpenRouter');await click('BOS Free · OpenRouter');await visible('Free models router');
const picker=await snapshot();assert.match(picker,/cloud/i);assert.ok(!picker.includes('Local (API key)'));
const rowVisibility=await evaluate(`(()=>{const row=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Free models router'));if(!row)return null;const box=row.getBoundingClientRect();let top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);for(let p=row.parentElement;p;p=p.parentElement){if(/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)){const rect=p.getBoundingClientRect();top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}}return {height:box.height,visibleHeight:Math.max(0,bottom-top)};})()`);
assert.ok(rowVisibility&&rowVisibility.height>0&&rowVisibility.visibleHeight>=rowVisibility.height-1,'model row must be fully visible, not only in accessibility text');

await ui('screenshot','--out',resolve(evidence,'picker-cloud.png'));await ui('press','--keys','Escape');
console.log('settings retry, connected inventory, cleared field and cloud picker verified');
await click('Free UI fixture');await click('Settings');await click('General');await click('Set up my AI team');await visible('What does your business do?');
await ui('type','--name','What does your business do?','--text','Synthetic bakery');await ui('type','--name','Who do you help?','--text','Synthetic local families');await click('Find my first teammate');await visible('Your brief is saved');await visible('Start free');
await click('Reconnect OpenRouter');await ui('type','--name','OpenRouter API key','--text','synthetic-ui-key');await click('Connect and continue free');await visible('Reconnect OpenRouter');
await ui('screenshot','--out',resolve(evidence,'onboarding-connected.png'));await click('Reconnect OpenRouter');assert.equal(await evaluate(`document.querySelector('section[aria-label="Free models"] input').value`),'');await click('Cancel');
const checks=await evaluate(`Promise.all([fetch('/api/bots?messages=100').then(r=>r.json()),fetch('/api/config').then(r=>r.json())]).then(([bots,config])=>({attempts:window.__freeUi.attempts,bodyWasSynthetic:window.__freeUi.bodyWasSynthetic,externalRequests:window.__freeUi.externalRequests,keyInStorage:JSON.stringify({...localStorage}).includes('synthetic-ui-key'),keyInChat:JSON.stringify(bots).includes('synthetic-ui-key'),keyInConfig:JSON.stringify(config).includes('synthetic-ui-key'),keyInVisibleText:document.body.innerText.includes('synthetic-ui-key')}))`);
assert.equal(checks.attempts,3);assert.equal(checks.bodyWasSynthetic,true);assert.equal(checks.externalRequests,0);for(const name of ['keyInStorage','keyInChat','keyInConfig','keyInVisibleText'])assert.equal(checks[name],false);
const consoleResult=await ui('console');const consoleErrors=(consoleResult.messages??[]).filter((row:any)=>row.type==='error');assert.equal(consoleErrors.length,0);
const finalSnapshot=await snapshot();writeFileSync(resolve(evidence,'result.json'),JSON.stringify({handle,checks,field,picker,rowVisibility,finalSnapshot,consoleErrorCount:consoleErrors.length,limitation:'Renderer connection boundary intercepted with synthetic responses. Actual HTTP save/auth/locking are separately exercised by free-model-setup.e2e.test.ts; no live provider auth or inference.'},null,2));
console.log(`PASS free model settings/onboarding smoke; evidence: ${evidence}`);
