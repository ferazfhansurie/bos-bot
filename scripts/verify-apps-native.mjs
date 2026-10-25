// Apps end to end (VERIFY_NATIVE=apps scripts/verify-blank-tab.ts): a real
// claude turn makes a crm, a contact is added in the page through the
// bridge, a second real turn updates it with app_write, the open tab shows
// the change live, and after a window reload the app reopens from the new
// tab with the change kept. Then a phone-width check. Isolated fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const { app, BrowserWindow, session, ipcMain } = await import('electron');
process.on('uncaughtException', error => { console.error('fixture uncaught error:', error.stack || error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('fixture unhandled rejection:', error?.stack || error); app.exit(1); });
const [uiURL, data, output, serverURL] = process.argv.slice(2);
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});
app.setPath('userData', path.join(data, 'electron')); app.setPath('sessionData', path.join(data, 'electron')); app.commandLine.appendSwitch('disable-background-networking'); app.dock?.hide();
ipcMain.handle('desktop:skin',()=>true);
ipcMain.handle('remote-full:status',()=>({enabled:false,targets:[]}));
ipcMain.handle('primary-browser:action',()=>false);

const turns=()=>{const f=path.join(output,'turns.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];};
const api=async(method,url,body)=>{const r=await fetch(serverURL+url,{method,headers:{'x-openmausbot-desktop-owner':token,origin:serverURL,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();if(!r.ok)throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(j)}`);return j;};

void app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeSendHeaders({urls:[new URL('/api/*',uiURL).href,new URL('/api/*',uiURL).href.replace(/^http/,'ws')]},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-openmausbot-desktop-owner':token,Origin:serverURL}}));
 const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, additionalArguments: [`--omb-local-origin=${new URL(uiURL).origin}`] } });
 win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message); });
 const evaluate=(code,gesture=false)=>win.webContents.executeJavaScript(code,gesture);
 const until=async(fn,label,ms=24000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(await fn())return;await new Promise(r=>setTimeout(r,150));}console.error(await evaluate('document.body.innerText'));throw new Error('Timed out: '+label);};
 const click=label=>evaluate(`[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.getClientRects().length&&!b.closest('.browser-parked,.hidden')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)})?.click()`,true);
 const capture=async name=>{await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
 let phoneFrame;const page=()=>phoneFrame??win.webContents.mainFrame.framesInSubtree.find(f=>f!==win.webContents.mainFrame&&f.url==='about:srcdoc');
 const inPage=code=>Promise.race([page()?.executeJavaScript(code,true).catch(()=>undefined),new Promise(r=>setTimeout(r,2000))]);
 const composer='[...document.querySelectorAll("textarea")].find(e=>e.checkVisibility()&&!e.closest("[data-testid=blank-tab],[data-testid=canvas-tab]"))';
 const type=text=>evaluate(`(()=>{const el=${composer};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const sendChat=async()=>{await new Promise(r=>setTimeout(r,200));await evaluate('[...document.querySelectorAll("button")].find(b=>b.checkVisibility()&&/^(Send message|Send into the running turn|Queue message)$/.test(b.getAttribute("aria-label")||"")).click()',true);};
 // where the crm shows a contact: its board column, or its stage badge in the list
 const stageShown=id=>inPage(`(()=>{const t=document.querySelector('.tile[data-id=${JSON.stringify(id)}]');if(t)return t.closest('.col')?.dataset.stage;const r=document.querySelector('tr[data-id=${JSON.stringify(id)}] .badge');return r?r.textContent.trim().toLowerCase():null})()`);
 const result={};fs.rmSync(path.join(output,'failure.png'),{force:true});
 try{
  const {bots}=await api('GET','/api/bots');const bot=bots[0];
  await win.loadURL(uiURL);
  await until(()=>evaluate('Boolean(document.querySelector("[aria-label=\\"New tab\\"]"))'),'header');

  // 1. ask a bot for a crm, in plain chat
  const ask1='make me a crm for seri bridal, my wedding planning business';
  await type(ask1);await sendChat();
  console.log('claude making the crm…');
  await until(()=>turns().length>=1,'first turn done',300000);
  const t1=turns()[0];fs.writeFileSync(path.join(output,'turn-1.json'),JSON.stringify(t1,null,2));
  assert.equal(t1.code,0,`turn 1 exit ${t1.code}`);assert.ok(t1.skills.includes('apps'),`apps skill in the turn (${t1.skills})`);
  const {apps}=await api('GET',`/api/apps?botId=${bot.id}`);
  assert.equal(apps.length,1,`one app made (${apps.map(a=>a.name)})`);const made=apps[0];
  result.app={id:made.id,name:made.name,template:made.template,path:made.path};result.reply1=t1.reply;
  await until(()=>evaluate('[...document.querySelectorAll("[data-testid=canvas-frame]")].some(e=>e.checkVisibility())'),'bos opened the app tab',30000);
  await until(async()=>Boolean(await inPage('typeof bos==="object"&&Boolean(document.querySelector("#new-contact"))')),'crm rendered with the bridge',20000);
  result.headerName=await evaluate('[...document.querySelectorAll("[data-testid=canvas-tab]")].find(e=>e.checkVisibility())?.querySelector("header")?.innerText?.split("\\n")[0]');
  await capture('1-crm.png');

  // 2. add a contact in the page, through its own form and the bridge
  await inPage('document.querySelector("#new-contact").click()');
  await until(async()=>Boolean(await inPage('document.querySelector("#contact-sheet").open')),'contact sheet opens');
  // the bot tailors the form (it may drop or rename fields and stages), so fill only what exists and pick the second stage
  const picked=await inPage(`(()=>{const f=document.querySelector('#contact-form');const set=(n,v)=>{const el=f.querySelector('[name='+n+']');if(!el)return;el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set('name','Ali');set('company','Seri Bridal');set('phone','+60 12 000 0000');set('value','4500');const s=f.querySelector('[name=stage]');const v=s.options[Math.min(1,s.options.length-1)].value;s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#cs-save').click();return v;})()`);
  let contact;
  await until(async()=>{const r=await api('GET',`/api/apps/${made.id}/data/contacts`);contact=(r.records??r)[0];return contact?.name==='Ali';},'contact stored on the server');
  assert.equal(contact.stage,picked);result.added={id:contact.id,stage:contact.stage,by:contact._by};
  await until(async()=>(await stageShown(contact.id))===picked,`page shows ali as ${picked}`);
  await capture('2-contact-added.png');

  // 3. the bot updates it; the open tab must change without reloading
  await inPage('window.__sameFrame=1');
  const fileBefore=fs.statSync(path.join(t1.cwd,made.path)).mtimeMs;
  const ask2='ali just booked with us, move ali to booked (or won) in my crm';
  await type(ask2);await sendChat();
  console.log('claude updating ali…');
  await until(()=>turns().length>=2,'second turn done',300000);
  const t2=turns()[1];fs.writeFileSync(path.join(output,'turn-2.json'),JSON.stringify(t2,null,2));
  assert.equal(t2.code,0,`turn 2 exit ${t2.code}`);
  const after=(await api('GET',`/api/apps/${made.id}/data/contacts`)).records.find(r=>r.id===contact.id);
  assert.notEqual(after.stage,contact.stage,`the bot moved ali (still ${after.stage})`);assert.notEqual(after._by,contact._by,'the bot wrote it');
  const moved=after.stage;
  await until(async()=>(await stageShown(contact.id))===moved,`page shows ali as ${moved}`,10000);
  result.live={stage:moved,by:after._by,sameFrame:Boolean(await inPage('window.__sameFrame')),pageFileEdited:fs.statSync(path.join(t1.cwd,made.path)).mtimeMs!==fileBefore};
  result.reply2=t2.reply;
  await capture('3-bot-updated.png');

  // 4. reload the window: the app reopens from the new tab's tools with the change kept
  await win.webContents.reloadIgnoringCache();
  await until(()=>evaluate('Boolean(document.querySelector("[aria-label=\\"New tab\\"]"))'),'header after reload');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-app]")].some(e=>e.checkVisibility())'),'new tab lists the app');
  result.newTabApps=await evaluate('[...document.querySelectorAll("[data-testid=new-tab-app]")].filter(e=>e.checkVisibility()).map(e=>e.innerText.trim())');
  await capture('4-new-tab-apps.png');
  await evaluate('[...document.querySelectorAll("[data-testid=new-tab-app] button")].find(e=>e.checkVisibility()).click()',true);
  await until(async()=>(await stageShown(contact.id))===moved,'after reload the app still shows the move',20000);
  await capture('5-after-reload.png');
  result.persisted=true;

  // 5. the library lists it as an app with its count
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility())'),'another new tab');
  await click('Blank tab');
  const card='[...document.querySelectorAll("[data-testid=canvas-library] [data-kind=app]")].find(e=>e.checkVisibility())';
  await until(()=>evaluate(`Boolean(${card})`),'library shows the app');
  result.libraryCard=await evaluate(`${card}.innerText.trim()`);
  await evaluate(`[...document.querySelectorAll("[data-testid=canvas-library]")].find(e=>e.checkVisibility()).scrollIntoView({block:'start'})`);
  await capture('6-library.png');
  await evaluate(`${card}.click()`,true);
  await until(async()=>(await stageShown(contact.id))===moved,'library card reopens the app');

  // 6. phone width: the page itself at 390px, sheet included
  // earlier app tabs stay mounted (hidden), so find the visible frame and then read the page that is phone width
  await until(()=>evaluate('[...document.querySelectorAll("[data-testid=canvas-frame]")].some(e=>e.checkVisibility())'),'visible app frame');
  await evaluate('(()=>{const f=[...document.querySelectorAll("[data-testid=canvas-frame]")].find(e=>e.checkVisibility());f.style.width="390px";f.style.height="760px";f.style.flex="none";})()');
  await until(async()=>{for(const f of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url==='about:srcdoc')){if(await f.executeJavaScript('innerWidth>300&&innerWidth<=400').catch(()=>false)){phoneFrame=f;return true;}}return false;},'a page at phone width');
  await new Promise(r=>setTimeout(r,600));
  result.phone=await inPage('({width:innerWidth,overflowX:document.documentElement.scrollWidth-innerWidth,newLabelHidden:(e=>e?getComputedStyle(e).display==="none":null)(document.querySelector("#new-contact .hide-sm"))})');
  assert.ok(result.phone.width<=400,`frame is phone width (${result.phone.width})`);
  assert.ok(result.phone.overflowX<=1,`no sideways scroll at phone width (${result.phone.overflowX}px)`);
  await capture('7-phone-board.png');
  await inPage(`document.querySelector('.tile[data-id=${JSON.stringify(contact.id)}]')?.click()`);
  await until(async()=>Boolean(await inPage('document.querySelector("#contact-sheet").open')),'contact sheet at phone width');
  result.phoneSheet=await inPage('(()=>{const r=document.querySelector("#contact-sheet").getBoundingClientRect();return {width:Math.round(r.width),bottom:Math.round(innerHeight-r.bottom),overflowX:document.documentElement.scrollWidth-innerWidth}})()');
  await capture('8-phone-sheet.png');

  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,...result},null,2));
  console.log(JSON.stringify({passed:true,output,...result}));win.destroy();app.exit(0);
 }catch(error){console.error(error);fs.writeFileSync(path.join(output,'partial.json'),JSON.stringify(result,null,2));await capture('failure.png').catch(()=>undefined);win.destroy();app.exit(1);}
});
