import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachLaunchSplash } from './launch-splash.mjs';
function fixture(timeoutMs=6000) {
 let view;
 class Contents extends EventEmitter {
  destroyed=false; calls=[]; finish;
  isDestroyed(){return this.destroyed}
  close(){this.destroyed=true}
  setWindowOpenHandler(handler){this.open=handler}
  loadFile(){return Promise.resolve()}
  executeJavaScript(code){this.calls.push(code);return code.startsWith('new Promise')?new Promise(r=>{this.finish=r}):Promise.resolve()}
 }
 class View {constructor(){view=this;this.webContents=new Contents()}setBounds(b){this.bounds=b}setBackgroundColor(){}}
 const win=new EventEmitter();win.webContents=new Contents();win.isDestroyed=()=>false;win.getContentSize=()=>[600,800];
 win.contentView={addChildView(v){this.child=v},removeChildView(){this.child=null}};
 const finish=attachLaunchSplash(win,{WebContentsView:View,filePath:'/test.html',timeoutMs});return {win,view,finish};
}
test('ready before animation load still exits after load and disposes on done',async()=>{
 const {win,view}=fixture();win.webContents.emit('did-finish-load');view.webContents.emit('did-finish-load');
 assert(view.webContents.calls.includes('window.BosSplash?.exit()'));view.webContents.finish(true);await Promise.resolve();
 assert.equal(win.contentView.child,null);assert(view.webContents.destroyed);assert.equal(win.listenerCount('resize'),0);
});
test('animation waits for app load then exits',()=>{const {win,view,finish}=fixture();view.webContents.emit('did-finish-load');assert.equal(view.webContents.calls.length,1);win.webContents.emit('did-finish-load');assert.equal(view.webContents.calls.length,2);finish()});
test('failed splash cannot block app',()=>{const {win,view}=fixture();view.webContents.emit('did-fail-load');assert.equal(win.contentView.child,null)});
test('failed app load allows splash to exit and expose recovery UI',()=>{const {win,view,finish}=fixture();view.webContents.emit('did-finish-load');win.webContents.emit('did-fail-load');assert(view.webContents.calls.includes('window.BosSplash?.exit()'));finish()});
test('timeout removes hung splash',async()=>{const {win}=fixture(5);await new Promise(r=>setTimeout(r,15));assert.equal(win.contentView.child,null)});
test('close cleans listeners and denies navigation',()=>{const {win,view}=fixture();assert.equal(view.webContents.open().action,'deny');let blocked=false;view.webContents.emit('will-navigate',{preventDefault(){blocked=true}});assert(blocked);win.emit('closed');assert(view.webContents.destroyed)});
test('constructor failure cannot abort window startup',()=>{assert.doesNotThrow(()=>attachLaunchSplash({}, {WebContentsView:class {constructor(){throw Error('allocation')}},filePath:'/test'}))});
test('late load after disposal does not execute on destroyed contents',()=>{const {view,finish}=fixture();const callback=view.webContents.listeners('did-finish-load')[0];finish();view.webContents.executeJavaScript=()=>{throw Error('destroyed')};assert.doesNotThrow(callback)});
