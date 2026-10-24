import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const { app, BrowserWindow, session, ipcMain } = await import('electron');
process.on('uncaughtException', error => { console.error('fixture uncaught error:', error.stack || error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('fixture unhandled rejection:', error?.stack || error); app.exit(1); });
const [uiURL, data, output, serverURL, promptsFile] = process.argv.slice(2);
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});
app.setPath('userData', path.join(data, 'electron')); app.setPath('sessionData', path.join(data, 'electron')); app.commandLine.appendSwitch('disable-background-networking'); app.dock?.hide();
ipcMain.handle('desktop:skin',()=>true);
ipcMain.handle('remote-full:status',()=>({enabled:false,targets:[]}));
ipcMain.handle('primary-browser:action',()=>false);

// each turn as the real claude saw it (scripts/testing/blank-tab-turn.mjs)
const turns=()=>{const f=path.join(output,'turns.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];};
const pages=dir=>fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/\.html?$/i.test(n)).map(n=>path.join(dir,n)):[];

void app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeSendHeaders({urls:[new URL('/api/*',uiURL).href,new URL('/api/*',uiURL).href.replace(/^http/,'ws')]},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-openmausbot-desktop-owner':token,Origin:serverURL}}));
 const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, additionalArguments: [`--omb-local-origin=${new URL(uiURL).origin}`] } });
 win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message); });
 const evaluate=(code,gesture=false)=>win.webContents.executeJavaScript(code,gesture);
 const until=async(fn,label,ms=24000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(await fn())return;await new Promise(r=>setTimeout(r,120));}console.error(await evaluate('document.body.innerText'));throw new Error('Timed out: '+label);};
 const click=label=>evaluate(`[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.getClientRects().length&&!b.closest('.browser-parked,.hidden')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)})?.click()`,true);
 const capture=async name=>{await new Promise(r=>setTimeout(r,400));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
 const page=()=>win.webContents.mainFrame.framesInSubtree.find(f=>f!==win.webContents.mainFrame&&f.url==='about:srcdoc');
 // a frame swapped mid-call never settles; give up after 2s so `until` keeps polling
 const inPage=code=>Promise.race([page()?.executeJavaScript(code).catch(()=>undefined),new Promise(r=>setTimeout(r,2000))]);
 const key=keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});};
 const result={};fs.rmSync(path.join(output,'failure.png'),{force:true});
 try{
  await win.loadURL(uiURL);
  await until(()=>evaluate('Boolean(document.querySelector("[aria-label=\\"New tab\\"]"))'),'header');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility())'),'new tab page');
  const tools=await evaluate('[...document.querySelector("[data-testid=new-tab-page]").querySelectorAll("button")].map(b=>b.textContent.trim()).filter(Boolean)');
  result.tools=tools;assert.ok(tools[0].startsWith('Blank tab'),`first tool is ${tools[0]}`);assert.ok(!tools.some(t=>/^New (page|video)/.test(t)),'old page/video rows are gone');
  await capture('1-new-tab.png');

  await click('Blank tab');await until(()=>evaluate('Boolean(document.querySelector("[data-testid=blank-tab]"))'),'blank tab');
  // the blank tab has no input of its own: the chat composer is the prompt
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=blank-tab] textarea, [data-testid=blank-tab] input:not([aria-label=\\"Search library\\"])").length'),0,'blank tab has no prompt box of its own');
  await capture('1b-blank-tab.png');
  const composerQ='[...document.querySelectorAll("textarea")].find(e=>e.checkVisibility()&&!e.closest("[data-testid=blank-tab],[data-testid=canvas-tab]"))';
  await click('presentation');await until(()=>evaluate(`${composerQ}?.value==="make this tab a presentation about "&&document.activeElement===${composerQ}`),'starter chip fills the chat composer');
  await evaluate(`(()=>{const el=${composerQ};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  // close it again: the first ask comes from a plain chat with no tab open
  for(let i=0;i<6;i++){const n=await evaluate('(()=>{const b=[...document.querySelectorAll("[data-testid=workbench-tab][data-kind=canvas] .workbench-tab-close,[data-testid=workbench-tab][data-kind=newtab] .workbench-tab-close")][0];b?.click();return b?1:0})()',true);if(!n)break;await new Promise(r=>setTimeout(r,300));}
  await new Promise(r=>setTimeout(r,400));
  result.tabsBeforeAsk=await evaluate('[...document.querySelectorAll("[data-testid=canvas-tab],[data-testid=new-tab-page],[data-testid=blank-tab]")].filter(e=>e.checkVisibility()).length');
  const composer='[...document.querySelectorAll("textarea")].find(e=>e.checkVisibility()&&!e.closest("[data-testid=blank-tab],[data-testid=canvas-tab]"))';
  // there is no blank tab tag or chip anywhere in the composer
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=composer-blank-tab]").length'),0,'no composer chip');
  const type=text=>evaluate(`(()=>{const el=${composer};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const sendChat=async()=>{await new Promise(r=>setTimeout(r,200));await evaluate('[...document.querySelectorAll("button")].find(b=>b.checkVisibility()&&/^(Send message|Send into the running turn|Queue message)$/.test(b.getAttribute("aria-label")||"")).click()',true);};
  const ask1='start a new tab and make it a 5-slide deck about bos bot';
  await type(ask1);await capture('2-plain-chat.png');await sendChat();
  await until(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(ask1)})`),'user bubble');
  console.log('claude writing the deck…');
  await until(()=>turns().length>=1,'first turn done',300000);
  const t1=turns()[0];fs.writeFileSync(path.join(output,'turn-1.json'),JSON.stringify(t1,null,2));
  assert.equal(t1.code,0,`turn 1 exit ${t1.code}`);assert.ok(t1.skill,'the blank-tab skill was in the turn');assert.ok(t1.agentsServer,'the agents mcp server was in the turn');
  const made=pages(path.join(t1.cwd,'bos-pages'));assert.equal(made.length,1,`one page written (${made.join(',')})`);const abs=made[0];result.file=abs;
  // bos opened the tab itself (open_tab → workspace.open)
  await until(()=>evaluate('[...document.querySelectorAll("[data-testid=canvas-frame]")].some(e=>e.checkVisibility())'),'bos opened the page tab',30000);
  await until(async()=>(await inPage('document.querySelectorAll("body > section, [data-slide], main > section").length'))>=5,'deck rendered with 5 slides',20000);
  result.slides=await inPage('document.querySelectorAll("body > section, [data-slide], main > section").length');
  result.reply1=t1.reply;
  const canvasTabs='[...document.querySelectorAll("[data-testid=canvas-tab]")].length';
  const tabsAfter1=await evaluate(canvasTabs);
  await capture('3-deck.png');

  await type('make slide 2 a chart');
  const slide2='document.querySelectorAll("body > section, [data-slide], main > section")[1]?.innerHTML';
  const slide2Before=await inPage(slide2);const before=fs.statSync(abs).mtimeMs;
  await sendChat();
  console.log('claude editing slide 2…');
  await until(()=>turns().length>=2,'second turn done',300000);
  const t2=turns()[1];fs.writeFileSync(path.join(output,'turn-2.json'),JSON.stringify(t2,null,2));
  assert.equal(t2.code,0,`turn 2 exit ${t2.code}`);assert.ok(t2.skill,'the skill stays on for the follow-up');
  assert.ok(fs.statSync(abs).mtimeMs>before,'the same file was edited in place');
  assert.equal(pages(path.join(t1.cwd,'bos-pages')).length,1,'no second page');
  await until(async()=>{const now=await inPage(slide2);return typeof now==='string'&&now!==slide2Before;},'slide 2 re-rendered after the edit',20000);
  assert.equal(await evaluate(canvasTabs),tabsAfter1,'no new tab for the edit');
  result.reply2=t2.reply;
  fs.copyFileSync(abs,path.join(output,'page.html'));
  await inPage('document.querySelectorAll("body > section, [data-slide], main > section")[1].scrollIntoView()');
  await capture('4-chart.png');
  result.slide2Changed=true;result.chartMarkup=await inPage('Boolean(document.querySelectorAll("body > section, [data-slide], main > section")[1]?.querySelector("svg,canvas"))')?'svg/canvas':'html';

  await evaluate('document.querySelector("[data-testid=canvas-present]").click()',true);
  await until(()=>evaluate('document.body.innerText.includes("/ ")&&Boolean(document.querySelector("[aria-label=\\"Exit present mode\\"]"))'),'present mode');
  result.fullscreen=await evaluate('Boolean(document.fullscreenElement)');
  await until(async()=>(await inPage('document.querySelectorAll("[data-bos-on]").length'))===1,'one slide on screen');
  await capture('5-present-1.png');
  key('Right');await until(async()=>(await inPage('Number(document.querySelector("[data-bos-on]")?.getAttribute("data-bos-slide"))'))===1,'arrow moves to slide 2');
  await new Promise(r=>setTimeout(r,2600));await capture('6-present-2.png');
  key('Space');await until(async()=>(await inPage('Number(document.querySelector("[data-bos-on]")?.getAttribute("data-bos-slide"))'))===2,'space moves to slide 3');
  key('Escape');await until(()=>evaluate('!document.querySelector("[aria-label=\\"Exit present mode\\"]")'),'esc exits');
  await until(async()=>(await inPage('document.documentElement.classList.contains("bos-present")'))===false,'page left present mode');
  await capture('7-after-esc.png');

  // a fresh blank tab lists what was made: the deck shows as a live preview card
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility())'),'second new tab');
  await click('Blank tab');
  const card='[...document.querySelectorAll("[data-testid=canvas-library] [data-kind=page]")].find(e=>e.checkVisibility())';
  await until(()=>evaluate(`Boolean(${card})`),'library shows the deck');
  result.libraryCard=await evaluate(`${card}.getAttribute('aria-label')`);
  await until(()=>evaluate(`Boolean(${card}.querySelector('iframe'))`),'deck preview');
  await evaluate(`[...document.querySelectorAll("[data-testid=canvas-library]")].find(e=>e.checkVisibility()).scrollIntoView({block:'start'})`);
  await new Promise(r=>setTimeout(r,800));
  await capture('8-library-grid.png');
  await evaluate('[...document.querySelectorAll("[data-testid=canvas-library] [aria-label=\\"List view\\"]")].find(e=>e.checkVisibility()).click()',true);await until(()=>evaluate('[...document.querySelectorAll("[data-testid=canvas-library]")].some(e=>e.checkVisibility()&&e.innerText.includes("Updated"))'),'list view');
  await capture('9-library-list.png');
  await evaluate('[...document.querySelectorAll("[data-testid=canvas-library] [aria-label=\\"Grid view\\"]")].find(e=>e.checkVisibility()).click()',true);
  await evaluate(`${card}.click()`,true);
  await until(()=>evaluate('[...document.querySelectorAll("[data-testid=canvas-frame]")].some(e=>e.checkVisibility())&&![...document.querySelectorAll("[data-testid=blank-tab]")].some(e=>e.checkVisibility())'),'card reopens the deck');
  await new Promise(r=>setTimeout(r,800));await capture('10-reopened.png');
  result.reopened=true;
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,...result},null,2));
  console.log(JSON.stringify({passed:true,output,...result}));win.destroy();app.exit(0);
 }catch(error){console.error(error);await capture('failure.png').catch(()=>undefined);win.destroy();app.exit(1);}
});
