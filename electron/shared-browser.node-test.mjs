import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSharedBrowser } from './shared-browser.mjs';
function fixture(sendCommand = async () => ({})) {
 const guest=Object.assign(new EventEmitter(),{id:1,isDestroyed:()=>false,getURL:()=> 'https://example.com',debugger:{isAttached:()=>true,sendCommand}});
 const shared=createSharedBrowser({contentsFromId:id=>id===1?guest:null});
 shared.grant({botId:'bos',threadId:'thread',guestId:1});return {guest,shared};
}
test('only exact granted conversation can access page; revoke is immediate and tools omit raw evaluation',async()=>{
 const {shared}=fixture(async name=>name==='Accessibility.getFullAXTree'?{nodes:[{role:{value:'button'},name:{value:'Continue'},backendDOMNodeId:2}]}:{});
 assert.equal((await shared.rpc('other','thread','tools/list')).tools.length,0);
 await assert.rejects(shared.rpc('other','thread','tools/call',{name:'bos_browser_snapshot'}));
 await assert.rejects(shared.rpc('bos','other','tools/call',{name:'bos_browser_snapshot'}));
 assert.equal(shared.tools().some(t=>/eval|password/.test(t.name)),false);
 shared.revoke(1);await assert.rejects(shared.rpc('bos','thread','tools/call',{name:'bos_browser_snapshot'}));
});
test('snapshot refs become stale on navigation and are single action use',async()=>{
 let clicks=0;const {shared,guest}=fixture(async name=>{if(name==='Accessibility.getFullAXTree')return {nodes:[{role:{value:'button'},name:{value:'Continue'},backendDOMNodeId:2}]};if(name==='DOM.resolveNode')return {object:{objectId:'obj'}};if(name==='Runtime.callFunctionOn'){clicks++;return {result:{value:true}};}return {};});
 const snapshot=await shared.rpc('bos','thread','tools/call',{name:'bos_browser_snapshot'});const ref=snapshot.content[0].text.match(/@b[\w-]+/)[0];
 guest.emit('did-start-navigation');await assert.rejects(shared.rpc('bos','thread','tools/call',{name:'bos_browser_click',arguments:{ref}}));assert.equal(clicks,0);
 const fresh=await shared.rpc('bos','thread','tools/call',{name:'bos_browser_snapshot'});const next=fresh.content[0].text.match(/@b[\w-]+/)[0];await shared.rpc('bos','thread','tools/call',{name:'bos_browser_click',arguments:{ref:next}});assert.equal(clicks,1);await assert.rejects(shared.rpc('bos','thread','tools/call',{name:'bos_browser_click',arguments:{ref:next}}));assert.equal(clicks,1);
});
test('expired dispatch cannot click after slow DOM resolution, and grant is revoked',async()=>{
 let clicked=false;const {shared}=fixture(async name=>{if(name==='Accessibility.getFullAXTree')return {nodes:[{role:{value:'button'},backendDOMNodeId:2}]};if(name==='DOM.resolveNode'){await new Promise(r=>setTimeout(r,40));return {object:{objectId:'obj'}};}if(name==='Runtime.callFunctionOn')clicked=true;return {};});
 const snapshot=await shared.rpc('bos','thread','tools/call',{name:'bos_browser_snapshot'});const ref=snapshot.content[0].text.match(/@b[\w-]+/)[0];
 await assert.rejects(shared.rpc('bos','thread','tools/call',{name:'bos_browser_click',arguments:{ref}},Date.now()+5));await new Promise(r=>setTimeout(r,50));assert.equal(clicked,false);assert.equal(shared.state(1).shared,false);
});
test('taking control while snapshot resolves prevents results escaping the revoked tab',async()=>{
 let complete;const {shared}=fixture(()=>new Promise(r=>{complete=r;}));const pending=shared.rpc('bos','thread','tools/call',{name:'bos_browser_snapshot'});shared.revoke(1);complete({nodes:[]});await assert.rejects(pending);
});
