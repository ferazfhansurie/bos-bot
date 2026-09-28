import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { eligible, requestBody, score, tasks, main } from './bos-free-benchmark.mjs';
import { validate } from './bos-release-readiness.mjs';
const free = {id:'example/model:free', pricing:{prompt:'0',completion:'0',request:'0',image:'0'}};
test('only explicit free IDs with all known costs zero pass',()=>{
 assert.equal(eligible(free),true);
 for(const m of [{...free,id:'paid/model'}, {...free,pricing:{prompt:'0'}}, {...free,pricing:{...free.pricing,web_search:'0.01'}}, {...free,pricing:{...free.pricing,prompt:''}}, {...free,pricing:{...free.pricing,completion:'NaN'}}]) assert.equal(eligible(m),false);
});
test('request cannot fall back or pay for prompt/output',()=>{
 const b=requestBody(free.id,tasks[0]);
 assert.equal(b.provider.allow_fallbacks,false);
 assert.deepEqual(b.provider.max_price,{prompt:0,completion:0});
 assert.equal(b.max_tokens,900); assert.equal(b.tools,undefined);
});
test('scoring requires valid structured correct answers',()=>{
 assert.equal(score('dashboard',JSON.stringify({revenue:130,conversionRate:0.25})),2);
 assert.equal(score('dashboard','revenue 130'),0);
 assert.equal(score('dashboard',JSON.stringify({revenue:130,conversionRate:25})),1);
});
test('empty manifest cannot imply verified release',()=>{
 const errors=validate({});
 assert.ok(errors.some(x=>x.includes('source')));
 for(const p of ['macos','ios','windows','android']) assert.ok(errors.some(x=>x.includes(p)));
});
test('live identity cannot equal staging identity',()=>{
 assert.ok(validate({source:{commit:'a'.repeat(40),clean:true},identity:{staging:'ai.bos.staging',live:'ai.bos.staging'}}).some(x=>x.includes('distinct')));
});

test('public inference stops globally at first auth failure without credentials or retry',async()=>{
 const saved=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return url.endsWith('/models')?{ok:true,text:async()=>JSON.stringify({data:[free]})}:{ok:false,status:401};};
 try{const report=await main(['--run-public']);assert.equal(report.status,'blocked');assert.equal(report.blocker,'HTTP 401');assert.equal(report.winner,null);assert.equal(calls.length,3);assert.equal(calls[2].options.headers.Authorization,undefined);}
 finally{globalThis.fetch=saved;}
});
test('price change closes circuit before inference request',async()=>{
 const saved=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({data:[++calls===1?free:{...free,pricing:{prompt:'1',completion:'0'}}]})});
 try{const report=await main(['--run-public']);assert.equal(report.blocker,'zero-price gate failed');assert.equal(calls,2);assert.equal(report.results.length,0);}
 finally{globalThis.fetch=saved;}
});

test('release artifact tampering is caught independently of manifest claims',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bos-release-test-'));
 try{
  writeFileSync(join(dir,'artifact'),'original');writeFileSync(join(dir,'evidence'),'synthetic test evidence');
  const commit='a'.repeat(40);const platform={sourceCommit:commit,built:true,version:'0.1.0-alpha.1',artifact:'artifact',sha256:createHash('sha256').update('original').digest('hex'),buildEvidence:'evidence',signingEvidence:'evidence',installed:true,deviceVerified:true,deviceEvidence:'evidence'};
  const m={source:{commit,clean:true,evidence:'evidence'},identity:{staging:'test.staging',live:'test.live'},channel:{name:'controlled-alpha',ownerVerified:true,endpoint:'https://example.invalid',evidence:'evidence'},tests:{passed:true,evidence:'evidence'},review:{approved:true,evidence:'evidence'},platforms:Object.fromEntries(['macos','ios','windows','android'].map(x=>[x,{...platform}])),recovery:{checkpoint:'evidence',rollback:'evidence',owner:'test'},approval:{evidence:'evidence'}};
  assert.deepEqual(validate(m,dir),[]);
  writeFileSync(join(dir,'artifact'),'tampered');
  assert.equal(validate(m,dir).filter(x=>x.includes('SHA-256 mismatch')).length,4);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('authenticated run requires designated key before any request',async()=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
 try{const r=await main(['--run','--models=example/model:free'],{OPENROUTER_API_KEY:''});assert.equal(r.blocker,'OPENROUTER_API_KEY is required');assert.equal(calls,0);}finally{globalThis.fetch=saved;}
});
test('authenticated request uses designated key without reporting it',async()=>{
 const secret='synthetic-test-key';const saved=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return url.endsWith('/models')?{ok:true,text:async()=>JSON.stringify({data:[free]})}:{ok:false,status:401};};
 try{const r=await main(['--run','--models=example/model:free'],{OPENROUTER_API_KEY:secret});assert.equal(calls[2].options.headers.Authorization,`Bearer ${secret}`);assert.equal(r.blocker,'HTTP 401');assert.equal(JSON.stringify(r).includes(secret),false);}finally{globalThis.fetch=saved;}
});
test('shortlist is explicit, bounded and free-only before network',async()=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
 try{for(const args of [['--run'],['--run','--models=paid/model'],['--run','--models=a:free,b:free,c:free,d:free']])await assert.rejects(main(args,{OPENROUTER_API_KEY:'synthetic'}));assert.equal(calls,0);}finally{globalThis.fetch=saved;}
});
test('website smoke requires actual self-contained semantic html',()=>{
 assert.equal(score('website','{"sections":["hero","products","contact"]}'),0);
 assert.equal(score('website','<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{color:black}</style></head><body><main><h1>Sunrise Bakery</h1><section id="products">Bread Croissant Cake</section><a href="#contact">Order</a><section id="contact">hello@example.invalid</section></main></body></html>'),2);
});
