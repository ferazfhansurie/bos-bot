import { describe, it, expect } from 'vitest';
import { DesktopBrowserBridge } from './desktop-browser-bridge.ts';
describe('private desktop browser bridge',()=>{
 it('pins bot/thread to the server request, and accepts only matching private response ids',async()=>{
  let sent:any;const bridge=new DesktopBrowserBridge(request=>{sent=request;return true;});const result=bridge.request('bos','thread','tools/call',{name:'bos_browser_snapshot'});
  expect(sent).toMatchObject({type:'bos:shared-browser-request',botId:'bos',threadId:'thread'});expect(sent.deadline).toBeGreaterThan(Date.now());
  expect(bridge.receive({type:'wrong',requestId:sent.requestId,ok:true})).toBe(false);bridge.receive({type:'bos:shared-browser-result',requestId:sent.requestId,ok:true,result:{content:[]}});await expect(result).resolves.toEqual({content:[]});
 });
 it('refuses when no desktop is attached and does not retry',async()=>{let count=0;const bridge=new DesktopBrowserBridge(()=>{count++;return false;});await expect(bridge.request('bos','thread','tools/list',{})).rejects.toThrow('not connected');expect(count).toBe(1);});
});
