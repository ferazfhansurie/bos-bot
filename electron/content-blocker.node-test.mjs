import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createContentBlocker} from './content-blocker.mjs';import {configureToolsBrowserSession,attachToolsBrowserGuest,noteBrowserKeyInput} from './tools-browser.mjs';
test('network filters, exceptions, per-site/profile persistence and static cosmetics',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bos-blocker-'));let url='https://site.example.test/';let styles='';const guest={id:7,getURL:()=>url,isDestroyed:()=>false,insertCSS:async s=>{styles=s;return 'css-key';},removeInsertedCSS:async()=>{styles='';}};
 const options={root,filters:'||ads.example.test^\n@@||ads.example.test/allowed.js\nsite.example.test##.sponsor',contentsFromId:()=>guest};const blocker=createContentBlocker(options);const request={id:1,url:'https://ads.example.test/a.js',resourceType:'script',webContentsId:7};
 try{
 assert.equal(blocker.shouldBlock('personal',request),true);assert.equal(blocker.shouldBlock('personal',{...request,url:'https://ads.example.test/allowed.js'}),false);assert.equal(blocker.shouldBlock('personal',{...request,resourceType:'mainFrame'}),false);
 await blocker.apply('personal',guest);assert.match(styles,/sponsor/);assert.equal(blocker.status('personal',guest).blocked,1);
 await blocker.toggle('personal',guest,{enabled:false,siteOnly:true});assert.equal(styles,'');assert.equal(blocker.shouldBlock('personal',request),false);assert.equal(blocker.shouldBlock('work',request),true);
 const restored=createContentBlocker(options);assert.equal(restored.shouldBlock('personal',request),false);url='https://other.example.test';assert.equal(restored.shouldBlock('personal',request),true);
 await restored.toggle('personal',guest,{enabled:false});assert.equal(restored.shouldBlock('personal',request),false);assert.equal(restored.shouldBlock('work',request),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('ad blocking composes with hard app-origin denial even if filter throws',()=>{
 let handler;const ses={setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(fn){handler=fn;}}};configureToolsBrowserSession(ses,{appOrigins:['http://127.0.0.1:8799'],shouldBlockRequest:()=>{throw Error('filter failure');}});
 let calls=0;handler({url:'http://127.0.0.1:8799/api/settings'},result=>{calls++;assert.equal(result.cancel,true);});handler({url:'https://ordinary.example'},result=>{calls++;assert.equal(result.cancel,false);});assert.equal(calls,2);
});
test('tab gestures route into tabs, native auth windows retain opener',()=>{
 let handler;const popups=[];const events={};const guest={session:{},setWindowOpenHandler(fn){handler=fn;},on(name,fn){events[name]=fn;}};
 attachToolsBrowserGuest(guest,{nativePopups:true,appOrigins:['http://127.0.0.1:8799'],onPopup:(...args)=>popups.push(args)});
 assert.equal(handler({url:'https://site.example',disposition:'background-tab'}).action,'deny');assert.deepEqual(popups[0],['https://site.example',{background:true}]);events['before-mouse-event']({}, {type:'mouseUp',button:'left',modifiers:['meta','shift']});assert.equal(handler({url:'https://site.example',disposition:'foreground-tab'}).action,'deny');assert.equal(popups[1][1].background,false);
 assert.equal(handler({url:'https://auth.example',disposition:'new-window'}).action,'allow');assert.equal(handler({url:'http://127.0.0.1:8799',disposition:'background-tab'}).action,'deny');assert.equal(popups.length,2);noteBrowserKeyInput({meta:true});noteBrowserKeyInput({meta:false});events['before-mouse-event']({}, {type:'mouseDown',button:'left'});assert.equal(handler({url:'https://auth.example',disposition:'foreground-tab'}).action,'allow');assert.equal(handler({url:'https://auth.example',disposition:'foreground-tab',postBody:{data:[]}}).action,'allow');
});
