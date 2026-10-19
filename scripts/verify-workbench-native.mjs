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
 const [uiURL, data, output, serverURL, pageURL] = process.argv.slice(2);

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
 const blocker=createContentBlocker({root:path.join(data,'browser'),filters:'||127.0.0.1:'+new URL(pageURL).port+'/ads.js\n127.0.0.1##.sponsor',contentsFromId:id=>webContents.fromId(id)});
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

 const evaluate=code=>win.webContents.executeJavaScript(code);
 const until=async(fn,label)=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,80));}console.error(await evaluate('document.body.innerText'));throw new Error('Timed out: '+label);};
 const click=label=>evaluate(`[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.getClientRects().length&&getComputedStyle(b).visibility!=='hidden'&&!b.closest('.browser-parked,.hidden')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)}||(b.getAttribute('role')==='menuitem'&&b.querySelector('span')?.textContent===${JSON.stringify(label)}))?.click()`);
 const capture=async name=>{await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
 try{
  await win.loadURL(uiURL);
  await until(()=>evaluate('Boolean(document.querySelector("[aria-label=\\"New tab\\"]"))'),'header');
  await click('Conversation options');await until(()=>evaluate('document.body.innerText.includes("Rename")'),'thread menu');await capture('header-menu.png');
  await click('Rename');await until(()=>evaluate('Boolean(document.querySelector("dialog[open]"))'),'rename dialog');
  await evaluate(`(()=>{const el=document.querySelector('[aria-label="Conversation name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Renamed fixture');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('Save');await until(()=>evaluate(`fetch('/api/bots').then(r=>r.json()).then(data=>data.bots.some(bot=>bot.tasks?.some(task=>task.title==='Renamed fixture')))`),'persisted rename');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility({visibilityProperty:true})&&!e.closest(".browser-parked,.hidden"))'),'tools tab');await capture('new-tab.png');
  assert.equal(await evaluate('document.querySelectorAll(".browser-tabs").length'),0);
  await click('Files⌘P');
  await until(()=>evaluate('Boolean(document.querySelector("[data-testid=workspace-files]"))'),'files view');await capture('files.png');
  const filter=async value=>evaluate(`(()=>{const el=document.querySelector('[aria-label="Filter files"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await filter('absent-fixture-file');await until(()=>evaluate('document.body.innerText.includes("No matching files")'),'file filter');await click('Clear file filter');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility({visibilityProperty:true})&&!e.closest(".browser-parked,.hidden"))'),'new browser tab');
  await evaluate(`(()=>{const el=document.querySelector('[aria-label="Search or enter a URL"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(pageURL)});el.dispatchEvent(new Event('input',{bubbles:true}));el.form.requestSubmit();})()`);
  const guest=()=>webContents.getAllWebContents().find(c=>c.getType()==='webview'&&c.getURL()===pageURL);
  await until(()=>guest()?.getTitle()==='Panel browser fixture','real guest');
  await click('Browser menu');await until(()=>evaluate('document.body.innerText.includes("Take a screenshot")'),'browser menu');await capture('browser-menu.png');
  const screenshotBefore=fs.existsSync(path.join(output,'native-page.png'))?fs.statSync(path.join(output,'native-page.png')).mtimeMs:0;
  await click('Take a screenshot');await until(()=>fs.existsSync(path.join(output,'native-page.png'))&&fs.statSync(path.join(output,'native-page.png')).mtimeMs>screenshotBefore,'native screenshot');
  assert.ok(fs.readFileSync(path.join(output,'native-page.png')).subarray(1,4).equals(Buffer.from('PNG')));
  await controller.action('device-toolbar',{profileId:'personal',guestId:guest().id,device:'mobile'});
  await controller.action('device-toolbar',{profileId:'personal',guestId:guest().id,device:'desktop'});
  await capture('browser-page.png');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility({visibilityProperty:true})&&!e.closest(".browser-parked,.hidden"))'),'tools again');
  await click('Side chat⌥⌘S');await until(()=>evaluate('Boolean(document.querySelector("[data-testid=workspace-sidechat]"))'),'real side chat');await capture('side-chat.png');
  await click('New tab');await until(()=>evaluate('[...document.querySelectorAll("[data-testid=new-tab-page]")].some(e=>e.checkVisibility({visibilityProperty:true})&&!e.closest(".browser-parked,.hidden"))'),'terminal tools');
  await click('Terminal⌃`');await until(()=>evaluate('Boolean(document.querySelector(".xterm"))'),'terminal tab');await until(()=>evaluate('Boolean(document.querySelector("[data-testid=terminal-status]")?.title)'), 'real terminal shell');await capture('terminal.png');
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,headerRename:true,unifiedTabs:true,filesFilter:true,realGuest:true,nativeScreenshot:true,deviceEmulation:true,sideChat:true,terminal:true},null,2));
  console.log(JSON.stringify({passed:true,output}));win.destroy();app.exit(0);
 }catch(error){console.error(error);await capture('failure.png');win.destroy();app.exit(1);}
 });
