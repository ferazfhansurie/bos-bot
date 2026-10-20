import {test} from 'node:test';import assert from 'node:assert/strict';import {browserCommand} from './browser-keybindings.mjs';import {registerBrowserApp} from './default-browser.mjs';
test('browser shortcuts agree for DOM and native guest input',()=>{
 for(const [key,flags,result] of [['t',{},'new-tab'],['t',{shift:true},'reopen-tab'],['w',{},'close-tab'],['l',{},'address'],['[',{},'back'],[']',{},'forward'],['r',{shift:true},'hard-reload'],['g',{shift:true},'find-previous'],['=',{},'zoom-in'],['0',{},'zoom-reset'],['9',{},'tab-9'],['ArrowRight',{alt:true},'next-tab'],['i',{alt:true},'developer-tools'],['j',{shift:true},'downloads'],['d',{},'bookmark']]) {
  assert.equal(browserCommand({key,meta:true,...flags}),result);
  assert.equal(browserCommand({key,metaKey:true,shiftKey:flags.shift,altKey:flags.alt}),result);
 }
 assert.equal(browserCommand({key:'Tab',control:true}),'next-tab');assert.equal(browserCommand({key:'Tab',ctrlKey:true,shiftKey:true}),'previous-tab');
 assert.equal(browserCommand({key:'j',ctrlKey:true,platform:'win32'}),'downloads');assert.equal(browserCommand({key:'h',ctrlKey:true,platform:'win32'}),'history');assert.equal(browserCommand({key:'ArrowLeft',altKey:true,platform:'win32'}),'back');assert.equal(browserCommand({key:'PageDown',ctrlKey:true}),'next-tab');assert.equal(browserCommand({key:'p',metaKey:true}),'print');
 assert.equal(browserCommand({key:'t'}),null);assert.equal(browserCommand({key:'w',meta:true,shift:true}),null);assert.equal(browserCommand({key:'c',meta:true}),null);assert.equal(browserCommand({key:'b',meta:true}),null);
});
test('registration only registers own packaged app, never changes default',async()=>{
 const calls=[];const run=(...args)=>{calls.push(args.slice(0,3));args[3](null);};
 assert.equal(await registerBrowserApp({platform:'darwin',packaged:true,executable:'/Applications/BOS Bot.app/Contents/MacOS/BOS Bot',run}),true);
 assert.deepEqual(calls[0][1],['-f','/Applications/BOS Bot.app']);
 assert.equal(await registerBrowserApp({platform:'darwin',packaged:false,run}),false);assert.equal(calls.length,1);
});
