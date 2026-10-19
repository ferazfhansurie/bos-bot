import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPermission, agentSiteOrigin, authorizeAgentNetwork } from './browser-agent-policy.mjs';
import { createPrimaryBrowserStore } from './primary-browser.mjs';

test('origin matching never grants sibling, credentials, nonweb or malformed rules', () => {
 const rules = {'https://example.com': {browse:'block',upload:'allow',download:'ask'}};
 assert.equal(agentPermission(rules,'https://example.com/path','browse'),'block');
 assert.equal(agentPermission(rules,'https://sub.example.com','upload'),'ask');
 assert.equal(agentPermission(rules,'https://user:pass@example.com','upload'),'block');
 assert.equal(agentPermission(rules,'file:///tmp/file','browse'),'block');
 assert.equal(agentPermission(null,'https://example.com','browse'),'block');
 assert.equal(agentPermission({'https://example.com':null},'https://example.com','browse'),'block');
 assert.throws(()=>agentSiteOrigin('https://example.com/path'));
});
test('rules persist per profile, validate all actions and reset individually', t => {
 const root=mkdtempSync(join(tmpdir(),'bos-site-rules-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=createPrimaryBrowserStore(root);const second=store.create('other');
 store.agentRule('personal','https://EXAMPLE.com',{browse:'block',upload:'ask',download:'allow'});
 assert.equal(agentPermission(createPrimaryBrowserStore(root).read('personal').agentRules,'https://example.com','browse'),'block');
 assert.equal(agentPermission(store.read(second.id).agentRules,'https://example.com','browse'),'allow');
 assert.throws(()=>store.agentRule('personal','https://example.com',{browse:'allow'}));
 store.agentRule('personal','https://example.com',null);
 assert.equal(agentPermission(store.read('personal').agentRules,'https://example.com','upload'),'ask');
});
test('main-frame posts require both browsing and upload permission; downloads check every actual origin', async () => {
 const {authorizeAgentNetwork,authorizeAgentDownload}=await import('./browser-agent-policy.mjs');
 const guest={id:1,getURL:()=> 'https://page.com',isDestroyed:()=>false};let current={key:'thread',scope:'generation-1',profileId:'personal'};const calls=[];
 const deps={guestFromId:()=>guest,agentForGuest:()=>current,authorize:async(_p,_g,url,action)=>{calls.push([url,action]);if(url.startsWith('https://blocked.com'))throw new Error('blocked');}};
 assert.equal(await authorizeAgentNetwork({webContentsId:1,url:'https://page.com/post',resourceType:'mainFrame',uploadData:[{}]},deps),true);assert.deepEqual(calls.map(c=>c[1]),['browse','upload']);
 calls.length=0;const item={getFilename:()=> 'report.pdf',getURL:()=> 'https://final.com/report',getURLChain:()=>['https://blocked.com/redirect']};
 assert.equal(await authorizeAgentDownload(guest,item,deps),false);assert(calls.some(([url])=>url==='https://blocked.com'));
 deps.authorize=async()=>{current={...current,scope:'generation-2'};};current={...current,scope:'generation-1'};
 assert.equal(await authorizeAgentNetwork({webContentsId:1,url:'https://page.com',resourceType:'mainFrame'},deps),false);
 current={...current,scope:'generation-1'};assert.equal(await authorizeAgentDownload(guest,{...item,getURLChain:()=>[]},deps),false);
});


test('unattributed worker uploads fail closed while agent control is active', async () => {
 const deps={guestFromId:()=>null,agentForGuest:()=>null,authorize:async()=>{},hasAgentControl:()=>true};
 assert.equal(await authorizeAgentNetwork({webContentsId:-1,uploadData:[{}]},deps),false);
 assert.equal(await authorizeAgentNetwork({webContentsId:-1,uploadData:[{}]},{...deps,hasAgentControl:()=>false}),true);
});

test('bot-check subframes post without an upload prompt; the page itself still asks', async () => {
 const {isHumanCheckRequest}=await import('./browser-agent-policy.mjs');
 for (const url of ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow','https://site.com/cdn-cgi/challenge-platform/h/g/jsd','https://newassets.hcaptcha.com/captcha/v1','https://www.google.com/recaptcha/api2/reload']) assert.equal(isHumanCheckRequest(url),true,url);
 for (const url of ['http://challenges.cloudflare.com/x','https://evilhcaptcha.com/x','https://www.google.com/search','https://cloudflare.com/','not a url']) assert.equal(isHumanCheckRequest(url),false,url);
 const guest={id:1,getURL:()=> 'https://page.com',isDestroyed:()=>false};const calls=[];
 const deps={guestFromId:()=>guest,agentForGuest:()=>({key:'k',scope:'s',profileId:'personal'}),authorize:async(_p,_g,_u,action)=>{calls.push(action);}};
 assert.equal(await authorizeAgentNetwork({webContentsId:1,url:'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow',resourceType:'xhr',uploadData:[{}]},deps),true);assert.deepEqual(calls,[]);
 calls.length=0;await authorizeAgentNetwork({webContentsId:1,url:'https://page.com/cdn-cgi/challenge-platform/x',resourceType:'mainFrame',uploadData:[{}]},deps);assert.deepEqual(calls,['browse','upload']);
});

test('the controlling conversation full access reaches every network and download check', async () => {
 const {authorizeAgentDownload}=await import('./browser-agent-policy.mjs');
 const guest={id:1,getURL:()=> 'https://page.com',isDestroyed:()=>false};const seen=[];
 let agent={key:'k',scope:'s',profileId:'personal',fullAccess:true};
 const deps={guestFromId:()=>guest,agentForGuest:()=>agent,authorize:async(_p,_g,_u,action,_d,_s,options)=>{seen.push([action,options?.fullAccess]);}};
 await authorizeAgentNetwork({webContentsId:1,url:'https://page.com/post',resourceType:'mainFrame',uploadData:[{}]},deps);
 await authorizeAgentDownload(guest,{getFilename:()=> 'a.pdf',getURL:()=> 'https://page.com/a.pdf'},deps);
 assert.deepEqual(seen,[['browse',true],['upload',true],['download',true]]);
 seen.length=0;agent={key:'k',scope:'s',profileId:'personal'};
 await authorizeAgentNetwork({webContentsId:1,url:'https://page.com/post',resourceType:'mainFrame',uploadData:[{}]},deps);
 assert.deepEqual(seen,[['browse',false],['upload',false]]);
});
