/** Desks, native half (see verify-desks.ts): the real chat, workspace dock,
 * primary browser and shared bot browser in a hidden window; real claude
 * turns write the desk and its cards. Never the installed app. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
 const { app, BrowserWindow, session, webContents, ipcMain, safeStorage } = await import('electron');
 process.on('uncaughtException', error => { console.error('fixture uncaught error:', error.stack || error); app.exit(1); });
 process.on('unhandledRejection', error => { console.error('fixture unhandled rejection:', error?.stack || error); app.exit(1); });
 const { createWorkspaceBrowserRegistry } = await import('../electron/workspace-browser.mjs');
 const { createContentBlocker } = await import('../electron/content-blocker.mjs');
 const { browserCommand } = await import('../electron/browser-keybindings.mjs');
 const { createSharedBrowser } = await import('../electron/shared-browser.mjs');
 const { createPrimaryBrowserController } = await import('../electron/primary-browser-controller.mjs');
 const { noteBrowserKeyInput, attachToolsBrowserGuest, hardenWebviewAttach, configureToolsBrowserSession } = await import('../electron/tools-browser.mjs');
 const [uiURL, data, output, serverURL, pageURL, botId] = process.argv.slice(2);

 fs.mkdirSync(output,{recursive:true});
 app.setPath('userData', path.join(data, 'electron')); app.setPath('sessionData', path.join(data, 'electron')); app.commandLine.appendSwitch('disable-background-networking'); app.dock?.hide();
 let win, controller, focusedPartition;
 const send = (channel, value) => { if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false; try { win.webContents.send(channel,value); return true; } catch { return false; } };
 const shared = createSharedBrowser({
  contentsFromId: id => webContents.fromId(id),
  guestValid: (id, profileId) => { const c = webContents.fromId(id); return Boolean(c && c.getType() === 'webview' && c.hostWebContents === win?.webContents && registry.source(c)?.partition === controller.partition(profileId)); },
  host: { available: () => Boolean(win && !win.isDestroyed()), reveal: () => send('primary-browser:external-url', {profileId:controller.store.profiles().selected,url:'',reveal:true}), command: command => send('primary-browser:agent-command',command) },
  notify: state => send('primary-browser:agent-state',state),
 }); const appOrigins = () => [new URL(uiURL).origin];
 const registry = createWorkspaceBrowserRegistry({ notify: row => win?.webContents.send('tools-browser:download', row), onDownload: (p, row, file) => controller?.download(p, row, file) });
 const prompts = [];
 const dialog = { async showMessageBox(_owner, options) { prompts.push(options.message); return { response: options.message === 'Delete the unencrypted export?' ? 0 : 1 }; }, async showSaveDialog(){return {canceled:false,filePath:path.join(output,'native-page.png')};}, async showOpenDialog() { return { canceled: false, filePaths: [path.join(output, 'passwords.csv')] }; } };
 const blocker=createContentBlocker({root:path.join(data,'browser'),filters:'',contentsFromId:id=>webContents.fromId(id)});
 const sessions = new Set();
 function setup(p) {
  if (sessions.has(p)) return; sessions.add(p); const ses = session.fromPartition(p);
  configureToolsBrowserSession(ses, { appOrigins, shouldBlockRequest:details=>blocker.shouldBlock(controller.profileFor(p),details), requestPermission: (c, permission, details) => controller.permission(p, c, permission, details), checkPermission: (c, permission, origin) => controller.checkPermission(p, c, permission, origin) });
  ses.on('will-download', (e, item, source) => { item.setSavePath(path.join(output, item.getFilename())); registry.trackDownload(p, e, item, source); });
 }
 ipcMain.handle('desktop:skin',()=>true);
 ipcMain.handle('remote-full:status',()=>({enabled:false,targets:[]}));
 ipcMain.handle('primary-browser:action', async (event, action, input) => { if (event.sender !== win.webContents || new URL(event.sender.getURL()).origin !== new URL(uiURL).origin) throw new Error('Wrong sender'); if(action==='browser-focus'){focusedPartition=input.focused?controller.partition(input.profileId):undefined;return true;}if(action==='consume-external-link')return false;if(action==='agent-tabs')return shared.reportTabs(input);if(['agent-take-over','agent-give-back','agent-stop'].includes(action))return shared.person(action.slice(6),input.tabId);if(action==='reveal')return true;const result = await controller.action(action, input); if (action === 'read' || action === 'select') setup(typeof result === 'string' ? result : result.partition); return result; });
 app.on('web-contents-created', (_event, c) => {
  c.on('before-input-event',(event,input)=>{noteBrowserKeyInput(input);const command=browserCommand(input);if(c===win?.webContents&&focusedPartition&&input.type==='keyDown'&&command){event.preventDefault();c.send('primary-browser:shortcut',{command,key:input.key,shift:input.shift,partition:focusedPartition});}});
  c.on('will-attach-webview', (e, prefs, params) => {  if (c !== win?.webContents || !registry.has(params.partition) || !hardenWebviewAttach(prefs, params, { appOrigins, partition: params.partition, nativePopups: true })) e.preventDefault(); });
  c.on('did-attach-webview', (_event, guest) => { const p = [...sessions].find(p => session.fromPartition(p) === guest.session); const attach = c => { registry.attach(c, p); c.on('did-navigate', (_e, url) => controller.visit(p, url, c.getTitle())); c.on('before-input-event', (e, input) => { if (c.getType()==='webview'&&browserCommand(input) && input.type === 'keyDown') { e.preventDefault(); win.webContents.send('primary-browser:shortcut', { command:browserCommand(input),key: input.key, shift: input.shift, partition: p }); } }); }; attach(guest);guest.on('dom-ready',()=>void blocker.apply(controller.profileFor(p),guest).catch(console.error)); attachToolsBrowserGuest(guest, { appOrigins, nativePopups: true, popupOptions: { show: false }, onPopup:(url,options)=>win.webContents.send('tools-browser:popup',url,{...registry.source(guest),...options}), onNativePopup: contents => { attach(contents); } }); });
 });
 void app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeSendHeaders({urls:[new URL('/api/*',uiURL).href,new URL('/api/*',uiURL).href.replace(/^http/,'ws')]},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-openmausbot-desktop-owner':'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',Origin:serverURL}}));

 controller = createPrimaryBrowserController({ root: path.join(data, 'browser'), encryption: safeStorage, registry, contentBlocker:blocker, sessionFromPartition: p => session.fromPartition(p), contentsFromId: id => webContents.fromId(id), owner: () => win, shell: { showItemInFolder() {}, async openPath() { return ''; } }, dialog, shared, allowInsecureTestOrigins: [new URL(pageURL).origin], chromeDirectory: path.join(data, 'chrome') });
 win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, additionalArguments: [`--omb-local-origin=${new URL(uiURL).origin}`, '--bos-primary-browser=1'] } });
 win.webContents.on('console-message', e => { if (e.level === 'error') console.error('renderer:', e.message); });

 const evaluate=(code,gesture=false)=>win.webContents.executeJavaScript(code,gesture);
 const until=async(fn,label,ms=24000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(await fn())return;await new Promise(r=>setTimeout(r,150));}console.error(await evaluate('document.body.innerText'));throw new Error('Timed out: '+label);};
 const capture=async name=>{await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
 const turns=()=>{const f=path.join(output,'turns.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];};
 const desks=()=>fetch(`${serverURL}/api/bots/${botId}/desks`,{headers:{'x-openmausbot-desktop-owner':'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',origin:serverURL}}).then(r=>r.json()).then(r=>r.desks);
 const deskTab='[...document.querySelectorAll("[data-testid=desk-tab]")].find(e=>e.checkVisibility())';
 const inDesk=code=>evaluate(`(()=>{const d=${deskTab};if(!d)return undefined;return (${code})(d);})()`);
 const clickIn=(selector,text)=>evaluate(`(()=>{const d=${deskTab};const b=[...(d?.querySelectorAll(${JSON.stringify(selector)})??[])].find(b=>b.checkVisibility()&&(${JSON.stringify(text??'')}===''||b.textContent.trim()===${JSON.stringify(text??'')}));b?.click();return Boolean(b);})()`,true);
 // a bot browser tab takes the dock's focus; the person clicks back to the desk
 const showDesk=()=>evaluate('[...document.querySelectorAll("[data-testid=workbench-tab][data-kind=desk]")].find(e=>e.checkVisibility())?.click()',true);
 const composer='[...document.querySelectorAll("textarea")].find(e=>e.checkVisibility()&&!e.closest("[data-testid=desk-tab]"))';
 const type=text=>evaluate(`(()=>{const el=${composer};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const sendChat=async()=>{await new Promise(r=>setTimeout(r,250));await evaluate('[...document.querySelectorAll("button")].find(b=>b.checkVisibility()&&/^(Send message|Send into the running turn|Queue message)$/.test(b.getAttribute("aria-label")||"")).click()',true);};
 const turn=async(n,label)=>{console.log(`claude: ${label}…`);await until(()=>turns().length>=n,label,300000);const t=turns()[n-1];fs.writeFileSync(path.join(output,`turn-${n}.json`),JSON.stringify(t,null,2));assert.equal(t.code,0,`turn ${n} exit ${t.code}`);assert.ok(t.skill,`turn ${n} had the desks skill`);return t;};
 const result={};fs.rmSync(path.join(output,'failure.png'),{force:true});
 try{
  await win.loadURL(uiURL);
  await until(()=>evaluate(`Boolean(${composer})`),'chat composer');

  // 1. plain chat → bos opens the app as a desk and writes a card from real numbers
  const ask1=`open my ads manager at ${pageURL} as a desk. today's spend is rm42 in total: "meet my hires" rm20, "free setup" rm12, "whatsapp demo" rm10. give me a card with today's spend and a button on each ad that tells me how it is doing.`;
  await type(ask1);await sendChat();
  const t1=await turn(1,'opening the desk');result.reply1=t1.reply;
  await until(()=>evaluate(`Boolean(${deskTab})`),'bos opened the desk tab itself',30000);
  const [desk]=await desks();assert.ok(desk,'a desk was saved');assert.equal(desk.host,'127.0.0.1');assert.ok(desk.cards.length>=1,'bos wrote a card');result.desk={id:desk.id,name:desk.name,status:desk.status,cards:desk.cards.map(c=>c.id)};
  await until(()=>inDesk('d=>d.querySelectorAll("[data-testid=desk-card]").length>0&&d.querySelector("[data-testid=desk-card]").innerText.includes("42")'),'card draws the real spend');
  await capture('1-desk-opened.png');

  // 2. sign in: the person opens the app, then tells bos they are in
  assert.ok(await inDesk('d=>Boolean(d.querySelector("[data-testid=desk-sign-in]"))'),'sign-in banner while the desk needs a sign-in');
  await clickIn('[data-testid=desk-signed-in]');
  await until(async()=>(await desks())[0].status==='ready','desk marked signed in');
  await until(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(`i'm signed in to ${desk.name}, carry on`)})`),'signed-in message in the chat');
  await turn(2,'carrying on after sign-in');
  await until(()=>inDesk('d=>!d.querySelector("[data-testid=desk-sign-in]")'),'banner gone');

  // 3. live view: bos works the app in its own browser tab; take over and hand back
  const thread=desk.threadId;
  const rpc=(name,args={})=>shared.rpc(botId,thread,'tools/call',{name,arguments:args},Date.now()+20000,{generation:'desks-fixture',profileId:'personal'});
  await rpc('agent_browser_open',{url:pageURL});
  await new Promise(r=>setTimeout(r,800));await showDesk();
  await until(()=>evaluate(`Boolean(${deskTab})`),'back on the desk');
  await until(()=>inDesk('d=>Boolean(d.querySelector("[data-testid=desk-live] img[src^=\\"data:image/jpeg\\"]"))'),'live view shows the app',30000);
  await until(()=>inDesk('d=>d.querySelector("[data-testid=desk-live]").innerText.includes("bos is working")'),'bos is working');
  await capture('2-live-bos-working.png');
  await clickIn('[data-testid=desk-takeover]');
  await until(()=>inDesk('d=>d.querySelector("[data-testid=desk-live]").innerText.includes("You have control")'),'person took over');
  await capture('3-taken-over.png');
  await clickIn('[data-testid=desk-handback]');
  await until(()=>inDesk('d=>d.querySelector("[data-testid=desk-live]").innerText.includes("bos is working")'),'handed back');
  result.liveView=true;result.takeOverHandBack=true;

  // 4. a card button asks bos in this chat, naming its desk
  const before=turns().length;
  const buttons=await inDesk('d=>[...d.querySelectorAll("[data-testid=desk-card] button")].filter(b=>b.checkVisibility()).map(b=>b.textContent.trim())');
  result.buttons=buttons;assert.ok(buttons.length>=3,`a button per ad (${buttons})`);
  await clickIn('[data-testid=desk-card] button',buttons[0]);
  await until(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(`[${desk.name} desk]`)})`),'button sent a message naming the desk');
  const t3=await turn(before+1,'answering a card button');result.buttonReply=t3.reply;
  await capture('4-button-answered.png');

  // 5. customise by asking; it survives a reload
  const card=(await desks())[0].cards[0];
  await type('add a button to the spend card that drafts a short client update about today\'s spend');await sendChat();
  await turn(before+2,'customising the card');
  const after=(await desks())[0];const changed=after.cards.find(c=>c.id===card.id);
  assert.ok(changed&&changed.code!==card.code,'the same card was changed in place');assert.equal(after.cards.length,(await desks())[0].cards.length);
  await until(()=>inDesk('d=>[...d.querySelectorAll("[data-testid=desk-card] button")].some(b=>/update/i.test(b.textContent))'),'new button on the card');
  await capture('5-customised.png');
  await win.webContents.reload();
  await until(()=>evaluate(`Boolean(${deskTab})`),'desk tab back after reload',30000);
  await until(()=>inDesk('d=>[...d.querySelectorAll("[data-testid=desk-card] button")].some(b=>/update/i.test(b.textContent))'),'customisation survives a reload');
  result.customisedButtons=await inDesk('d=>[...d.querySelectorAll("[data-testid=desk-card] button")].map(b=>b.textContent.trim())');
  await capture('6-after-reload.png');

  // 6. pin: one click from any new tab
  await clickIn('[data-testid=desk-pin]');
  await until(async()=>(await desks())[0].pinned===true,'pinned on the server');
  await evaluate('[...document.querySelectorAll("[data-testid=workbench-new-tab]")].find(b=>b.checkVisibility()).click()',true);
  await until(()=>evaluate(`[...document.querySelectorAll("[data-testid=new-tab-pinned]")].some(e=>e.checkVisibility()&&e.innerText.includes(${JSON.stringify(after.name)}))`),'pinned desk on the new tab');
  await capture('7-new-tab-pin.png');
  await evaluate(`[...document.querySelectorAll("[data-testid=new-tab-pinned] button")].find(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(after.name)}).click()`,true);
  await until(()=>evaluate(`Boolean(${deskTab})`),'pin opens the desk');
  result.pinned=true;
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,...result},null,2));
  console.log(JSON.stringify({passed:true,output,...result}));win.destroy();app.exit(0);
 }catch(error){console.error(error);await capture('failure.png').catch(()=>undefined);win.destroy();app.exit(1);}
 });
