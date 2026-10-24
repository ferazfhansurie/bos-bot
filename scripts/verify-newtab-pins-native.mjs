import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const { app, BrowserWindow, session, ipcMain } = await import('electron');
process.on('uncaughtException', error => { console.error('fixture uncaught error:', error.stack || error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('fixture unhandled rejection:', error?.stack || error); app.exit(1); });
const [uiURL, data, output, serverURL, botId] = process.argv.slice(2);
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});
app.setPath('userData', path.join(data, 'electron')); app.setPath('sessionData', path.join(data, 'electron')); app.commandLine.appendSwitch('disable-background-networking'); app.dock?.hide();
ipcMain.handle('desktop:skin',()=>true);
ipcMain.handle('remote-full:status',()=>({enabled:false,targets:[]}));
ipcMain.handle('primary-browser:action',()=>false);
const headers={'x-openmausbot-desktop-owner':token,origin:serverURL,'content-type':'application/json'};
const call=async(method,url,body)=>{const r=await fetch(serverURL+url,{method,headers,body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`${method} ${url} ${r.status} ${JSON.stringify(j)}`);return j;};
const current=async()=>{const j=await call('GET','/api/bots');const b=(j.bots??j).find(b=>b.id===botId);return b.threadId;};
const folder=async threadId=>(await call('GET',`/api/workspace-files/list?${new URLSearchParams({botId,threadId,path:'.'})}`)).root;
const page=(title,body)=>`<!doctype html><html><head><title>${title}</title></head><body style="font:32px system-ui;padding:40px"><h1 data-pin-check>${body}</h1></body></html>`;

void app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeSendHeaders({urls:[new URL('/api/*',uiURL).href,new URL('/api/*',uiURL).href.replace(/^http/,'ws')]},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-openmausbot-desktop-owner':token,Origin:serverURL}}));
 const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, additionalArguments: [`--omb-local-origin=${new URL(uiURL).origin}`] } });
 win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message); });
 const evaluate=(code,gesture=false)=>win.webContents.executeJavaScript(code,gesture);
 const until=async(fn,label,ms=24000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(await fn())return;await new Promise(r=>setTimeout(r,120));}console.error(await evaluate('document.body.innerText'));throw new Error('Timed out: '+label);};
 const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.getClientRects().length&&!b.closest('.browser-parked,.hidden')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});b?.click();return Boolean(b)})()`,true);
 const capture=async name=>{await new Promise(r=>setTimeout(r,400));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
 const frameText=()=>Promise.race([win.webContents.mainFrame.framesInSubtree.find(f=>f!==win.webContents.mainFrame&&f.url==='about:srcdoc')?.executeJavaScript('document.querySelector("[data-pin-check]")?.textContent').catch(()=>undefined),new Promise(r=>setTimeout(r,2000))]);
 const visible=sel=>`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.checkVisibility())`;
 const newTab=async()=>{await until(()=>click('New tab'),'new tab button');await until(()=>evaluate(`${visible('[data-testid=new-tab-page]')}.length>0`),'new tab page');};
 const pinnedRows=()=>evaluate(`${visible('[data-testid=new-tab-pinned]')}.map(e=>e.innerText.trim())`);
 const result={};fs.rmSync(path.join(output,'failure.png'),{force:true});
 try{
  const chat1=await current();const dir1=await folder(chat1);
  fs.mkdirSync(path.join(dir1,'bos-pages'),{recursive:true});
  // tall, so the scroll check below has somewhere to go
  fs.writeFileSync(path.join(dir1,'bos-pages/2026-10-25-sales-dashboard-a1b2.html'),page('Sales dashboard','sales from chat one').replace('</body>','<div style="height:5000px"></div></body>'));
  fs.writeFileSync(path.join(dir1,'bos-pages/2026-10-25-team-deck-c3d4.html'),page('Team deck','deck from chat one'));
  await win.loadURL(uiURL);
  await until(()=>evaluate('Boolean(document.querySelector("[aria-label=\\"New tab\\"]"))'),'header');

  // 1. open a page from the blank tab's library and pin it from its header
  await newTab();
  assert.deepEqual(await pinnedRows(),[],'nothing pinned yet');
  await capture('1-new-tab-empty.png');
  await click('Blank tab');
  const card=`${visible('[data-testid=canvas-library] [data-kind=page]')}.find(e=>/Sales dashboard/i.test(e.getAttribute('aria-label')||e.innerText))`;
  await until(()=>evaluate(`Boolean(${card})`),'library lists the dashboard');
  await evaluate(`${card}.click()`,true);
  await until(async()=>(await frameText())==='sales from chat one','dashboard renders');
  // 1b. the app re-rendering around the tab (bot updates, polls) must not reload the page: no white flash, no jump to the top
  const inFrame=code=>win.webContents.mainFrame.framesInSubtree.find(f=>f!==win.webContents.mainFrame&&f.url==='about:srcdoc')?.executeJavaScript(code);
  await inFrame('scrollTo(0,1500);window.__same=1;0');
  for(let i=0;i<4;i++){await call('PATCH',`/api/bots/${botId}`,{description:'scroll check '+i});await new Promise(r=>setTimeout(r,600));}
  await evaluate(`window.fixtureDispatch({type:'select',id:${JSON.stringify(botId)}})`);
  await new Promise(r=>setTimeout(r,9000));
  result.scrollKept=await inFrame('[Math.round(scrollY),window.__same===1]');
  assert.deepEqual(result.scrollKept,[1500,true],'page kept its scroll and was not reloaded');
  await until(()=>evaluate(`${visible('[data-testid=canvas-pin]')}.length===1`),'pin button');
  await evaluate(`${visible('[data-testid=canvas-pin]')}[0].click()`,true);
  await until(()=>evaluate(`${visible('[data-testid=canvas-pin]')}[0].getAttribute('aria-pressed')==='true'`),'pin toggles on');
  await capture('2-pinned-from-header.png');

  // 2. the next new tab has it under Tools, and one click opens it
  await newTab();
  await until(async()=>(await pinnedRows()).length===1,'pinned row in tools');
  result.pinnedAfterHeader=await pinnedRows();
  assert.match(result.pinnedAfterHeader[0],/Sales dashboard/i);
  result.tools=await evaluate(`${visible('[data-testid=new-tab-page]')}[0].innerText.split('\\n').filter(Boolean)`);
  await capture('3-new-tab-with-pin.png');
  await evaluate(`${visible('[data-testid=new-tab-pinned] button')}[0].click()`,true);
  await until(async()=>(await frameText())==='sales from chat one'&&await evaluate(`${visible('[data-testid=new-tab-page]')}.length===0`),'pin opens the page in that tab');

  // 3. add the deck through "Add a tab you made" (the dashboard is already pinned, so it is not offered)
  await newTab();
  await evaluate(`${visible('[data-testid=new-tab-add-pin]')}[0].click()`,true);
  await until(()=>evaluate(`[...document.querySelectorAll('[role=menuitem]')].some(e=>/Team deck/i.test(e.textContent))`),'chooser lists the deck');
  result.choices=await evaluate(`[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim())`);
  assert.ok(!result.choices.some(c=>/Sales dashboard/i.test(c)),'pinned page not offered again');
  await capture('4-add-chooser.png');
  await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(e=>/Team deck/i.test(e.textContent)).click()`,true);
  await until(async()=>(await pinnedRows()).length===2,'deck pinned');
  result.pinned=await pinnedRows();
  await capture('5-two-pins.png');

  // 4. a second chat has its own folder; its new tab still shows both pins and opens chat one's page
  await evaluate(`window.fixtureDispatch({type:'newTask',botId:${JSON.stringify(botId)}})`);
  await until(async()=>(await current())!==chat1,'second chat created');
  const chat2=await current();assert.notEqual(chat2,chat1,'second chat is current');
  const dir2=await folder(chat2);assert.notEqual(dir2,dir1,'second chat has its own folder');
  assert.ok(!fs.existsSync(path.join(dir2,'bos-pages/2026-10-25-team-deck-c3d4.html')),'the deck is not in chat two');
  await until(()=>evaluate(`${visible('[data-testid=new-tab-page],[data-testid=canvas-tab]')}.length===0`),'chat two opens with no tabs',30000);
  await newTab();
  await until(async()=>(await pinnedRows()).length===2,'pins follow to chat two');
  await capture('6-chat-two-new-tab.png');
  const deckRow=`${visible('[data-testid=new-tab-pinned]')}.find(e=>/Team deck/i.test(e.innerText)).querySelector('button')`;
  await evaluate(`${deckRow}.click()`,true);
  await until(async()=>(await frameText())==='deck from chat one','chat one\'s deck opens in chat two');
  result.openedAcrossChats=true;
  // the chooser named it from the file; opening it swaps in the page's own title
  await until(()=>evaluate(`JSON.parse(localStorage.getItem('bos.newtab.pins')).some(p=>p.title==='Team deck')`),'pin takes the page title');
  await capture('7-deck-in-chat-two.png');

  // 5. survives a reload (the tab keeps its page and source chat), and unpin removes the row
  await win.reload();
  await until(async()=>(await frameText())==='deck from chat one','deck tab restored after reload',30000);
  result.restoredAfterReload=true;
  await newTab();
  await until(async()=>(await pinnedRows()).length===2,'pins after reload');
  await evaluate(`${visible('[data-testid=new-tab-pinned]')}.find(e=>/Sales dashboard/i.test(e.innerText)).querySelector('[aria-label^="Unpin"]').click()`,true);
  await until(async()=>(await pinnedRows()).length===1,'unpinned');
  result.afterUnpin=await pinnedRows();
  await capture('8-after-unpin.png');
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,...result},null,2));
  console.log(JSON.stringify({passed:true,output,...result}));win.destroy();app.exit(0);
 }catch(error){console.error(error);await capture('failure.png').catch(()=>undefined);win.destroy();app.exit(1);}
});
