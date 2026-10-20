import path from 'node:path';
import { agentPermission } from './browser-agent-policy.mjs';
import { cookiePreview, importChromeCookies } from './chrome-cookies.mjs';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createPrimaryBrowserStore, createBrowserVault, chromeProfiles, chromePreview, parsePasswordCSV, webURL, cleanTabs, chromeRoot } from './primary-browser.mjs';

// Only wired to the main window's local-only IPC. No HTTP/tool/model access.
export function createPrimaryBrowserController({ root, encryption, registry, sessionFromPartition, contentsFromId, dialog, owner, shell, chromeDirectory, contentBlocker, agentBusy = () => false, allowInsecureTestOrigins = [] }) {
  const store = createPrimaryBrowserStore(root);
  const vault = createBrowserVault(root, encryption);
  const profiles = new Map(); const previews = new Map(); const downloadPaths = new Map();
  const partition = id => { store.fileFor(id); const p = registry.register(`primary:${id}`); profiles.set(p, id); return p; };
  const profileFor = p => profiles.get(p);
  const agentApprovals = new Map();
  const elementPickers = new Map();
  const confirm = async (message, detail, buttons = ['Cancel', 'Allow']) => (await dialog.showMessageBox(owner(), { type: 'question', message, detail, buttons, defaultId: 0, cancelId: 0 })).response === 1;
  const credentialOrigin = guest => { const url = webURL(guest.getURL()); if (!url) throw new Error('Open a secure sign-in page'); const u = new URL(url); if (u.protocol !== 'https:' && !allowInsecureTestOrigins.includes(u.origin)) throw new Error('Saved passwords require an HTTPS sign-in page'); return u.origin; };
  const fillLogin = (guest, origin, record) => guest.executeJavaScript(`(() => { if(location.origin!==${JSON.stringify(origin)})return false; const passwords=[...document.querySelectorAll('input[type=password]')].filter(e=>e.getClientRects().length); if(passwords.length!==1)return false; const p=passwords[0];const scope=p.form||document;const u=scope.querySelector('input[autocomplete=username],input[type=email]')||[...scope.querySelectorAll('input[type=text]')].find(e=>e.getClientRects().length);const set=(e,v)=>{if(!e)return;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};set(u,${JSON.stringify(record.username)});set(p,${JSON.stringify(record.password)});return true;})()`);
  const guestFor = (id, guestId) => { const guest = contentsFromId(guestId); if (!guest || guest.isDestroyed() || registry.source(guest)?.partition !== partition(id)) throw new Error('This browser tab is no longer available'); return guest; };
  return {
    store, partition, profileFor,
    agentPermission(id, url, action) { return agentPermission(store.read(id).agentRules, url, action); },
    async authorizeAgent(id, guestId, url, action, detail = '', scope = '', { fullAccess = false } = {}) {
      const guest = guestId == null && action === 'browse' ? null : guestFor(id, guestId);
      const origin = new URL(url).origin;
      const library = store.read(id);
      const rules = JSON.stringify(library.agentRules);
      const permission = agentPermission(library.agentRules, url, action);
      if (permission === 'block') throw new Error(`Agent ${action} is blocked for ${origin} in this browser profile`);
      if (permission === 'allow') return;
      // A bot the person gave Full access acts without asking, unless this
      // profile turned that off. Explicit block rules above still hold.
      if (fullAccess === true && library.agentAskFullAccess !== true) return;
      // One answer per site, tab and bot turn: a page fires many posts at once
      // and asking for each one stalls sign-ins and verification checks.
      const key = JSON.stringify([id, guestId, origin, action, rules, scope]);
      const remembered = guest && (action === 'browse' || action === 'upload');
      if (remembered && agentApprovals.get(key) === true) return;
      if (remembered && agentApprovals.get(key)) return agentApprovals.get(key);
      const before = guest?.getURL();
      const ask = (async () => {
        const allowed = await confirm(`Allow the bot to ${action} on ${origin}?`, detail || 'This permission applies to this action. Change saved site rules in browser settings.');
        if (!allowed || (guest && (guest.isDestroyed() || guest.getURL() !== before)) || JSON.stringify(store.read(id).agentRules) !== rules) throw new Error('Site permission was declined or the page changed. Check the page before continuing.');
      })();
      if (!remembered) return ask;
      agentApprovals.set(key, ask);
      try { await ask; agentApprovals.set(key, true); } catch (error) { agentApprovals.delete(key); throw error; }
    },
    visit(p, url, title) { const id = profileFor(p); if (id) store.visit(id, url, title); },
    download(p, row, file) { const id = profileFor(p); if (!id) return; if (file) downloadPaths.set(row.id, { profile: id, file }); store.download(id, { ...row, ...(file ? { file } : {}) }); },
    async permission(p, contents, permission, details = {}) {
      const id = profileFor(p); if (!id || !contents || contents.isDestroyed()) return false;
      const url = webURL(contents.getURL()); if (!url) return false;
      const origin = new URL(url).origin; const requesting = webURL(details.requestingUrl || origin);
      if (!requesting || new URL(requesting).origin !== origin || !['media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture'].includes(permission)) return false;
      const key = `${origin}|${permission}`; const saved = store.read(id).permissions[key];
      if (typeof saved === 'boolean') return saved;
      const allowed = await confirm(`${new URL(origin).hostname} wants ${permission.replaceAll('-', ' ')}`, 'Allow this site in this browser profile? You can reset permissions in browser settings.');
      // A prompt may outlive the tab or navigation: never grant the new page.
      if (contents.isDestroyed() || new URL(contents.getURL()).origin !== origin) return false;
      store.permission(id, origin, permission, allowed); return allowed;
    },
    checkPermission(p, contents, permission, origin) {
      const id = profileFor(p); if (!id || !contents || contents.isDestroyed()) return false;
      try { if (new URL(contents.getURL()).origin !== new URL(origin).origin) return false; return store.read(id).permissions[`${new URL(origin).origin}|${permission}`] === true; } catch { return false; }
    },
    /** A bot's sign-in on its own tab: a saved login for this exact origin the
     * person has not switched off for bots. The password stays in main. */
    async botSignIn(id, guestId, username) {
      const guest = guestFor(id, guestId); const origin = credentialOrigin(guest);
      const record = vault.botCredential(id, origin, username);
      if (!await fillLogin(guest, origin, record)) throw new Error('Could not find exactly one visible password field on this page. Open the sign-in page and try again.');
      return { username: record.username, origin };
    },
    async action(action, input = {}) {
      if (action === 'profiles') return store.profiles();
      if (action === 'create') return store.create(input.name);
      if (action === 'chrome-profiles') return chromeProfiles(chromeDirectory);
      const id = input.profileId; store.fileFor(id);
      if (action === 'rename') return store.rename(id, input.name);
      if (action === 'delete') {
        const index = store.profiles(); const name = index.profiles.find(p => p.id === id).name;
        if (index.profiles.length <= 1) throw new Error('Keep at least one browser profile');
        if (agentBusy(id)) throw new Error('A bot is using this profile. Stop it or wait for it to finish, then delete.');
        if (!await confirm(`Delete the browser profile “${name}”?`, 'This signs you out of every website in it and removes its bookmarks, history, tabs, downloads list, site permissions and saved passwords from bos. This cannot be undone.', ['Cancel', 'Delete profile'])) return null;
        // The dialog is async: a bot may have started in the meantime.
        if (agentBusy(id)) throw new Error('A bot started using this profile. Stop it or wait for it to finish, then delete.');
        const p = partition(id); const ses = sessionFromPartition(p);
        await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache?.();
        const next = store.remove(id);
        vault.destroy(id); fs.rmSync(path.join(root, `${id}.blocker.json`), { force: true });
        profiles.delete(p);
        for (const key of agentApprovals.keys()) if (JSON.parse(key)[0] === id) agentApprovals.delete(key);
        for (const [token, preview] of previews) if (preview.profileId === id) previews.delete(token);
        for (const [download, saved] of downloadPaths) if (saved.profile === id) downloadPaths.delete(download);
        return next;
      }
      if (action === 'screenshot') {
        const guest = guestFor(id, input.guestId);
        // Capture before the dialog, so switching tabs while choosing a path cannot
        // save a different page. Paths are chosen only through the native dialog.
        const capture = await guest.capturePage();
        const pick = await dialog.showSaveDialog(owner(), { title: 'Save screenshot', defaultPath: 'bos-screenshot.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
        if (pick.canceled || !pick.filePath) return false;
        fs.writeFileSync(pick.filePath, capture.toPNG(), { mode: 0o600 });
        return true;
      }
      if (action === 'device-toolbar') {
        const guest = guestFor(id, input.guestId);
        const device = input.device;
        if (!['desktop', 'mobile', 'tablet'].includes(device)) throw new Error('Choose desktop, mobile or tablet');
        if (device === 'desktop') guest.disableDeviceEmulation();
        else {
          const size = device === 'mobile' ? { width: 390, height: 844 } : { width: 820, height: 1180 };
          guest.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: size, viewPosition: { x: 0, y: 0 }, viewSize: size, deviceScaleFactor: 1, scale: 1 });
        }
        return device;
      }
      if (action === 'inspect-element') {
        const guest = guestFor(id, input.guestId);
        await elementPickers.get(guest.id)?.();
        const debug = guest.debugger;
        const attachedHere = !debug.isAttached();
        if (attachedHere) debug.attach('1.3');
        let timer; let finished = false;
        const cleanup = async () => {
          if (finished) return;
          finished = true; clearTimeout(timer);
          elementPickers.delete(guest.id);
          debug.removeListener('message', selected); debug.removeListener('detach', cleanup);
          try { await debug.sendCommand('Overlay.setInspectMode', { mode: 'none' }); } catch { /* tab closed or devtools took over */ }
          try { if (attachedHere && debug.isAttached()) debug.detach(); } catch { /* guest destroyed */ }
        };
        const selected = async (_event, method, params) => {
          if (method !== 'Overlay.inspectNodeRequested' || finished) return;
          try {
            const { model } = await debug.sendCommand('DOM.getBoxModel', { backendNodeId: params.backendNodeId });
            const points = model.border;
            await cleanup();
            // Revalidate the profile after the asynchronous CDP response.
            if (guestFor(id, input.guestId) !== guest) return;
            guest.inspectElement(Math.round((points[0] + points[4]) / 2), Math.round((points[1] + points[5]) / 2));
          } catch { await cleanup(); }
        };
        elementPickers.set(guest.id, cleanup);
        debug.on('message', selected); debug.once('detach', cleanup);
        try {
          await debug.sendCommand('DOM.enable');
          await debug.sendCommand('Overlay.enable');
          await debug.sendCommand('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.35 }, borderColor: { r: 111, g: 168, b: 220, a: 0.8 } } });
          timer = setTimeout(cleanup, 120000); timer.unref?.();
          return true;
        } catch (error) { await cleanup(); throw error; }
      }
      if (action === 'blocker-status') return contentBlocker?.status(id, input.guestId ? guestFor(id,input.guestId) : undefined);
      if (action === 'blocker-toggle') return contentBlocker?.toggle(id, input.guestId ? guestFor(id,input.guestId) : undefined, {enabled:input.enabled,siteOnly:input.siteOnly===true});
      if (action === 'select') { store.select(id); return partition(id); }
      if (action === 'read') { const d = store.read(id); return { ...d, downloads: d.downloads.map(({ file: _file, ...row }) => row), partition: partition(id), ...(contentBlocker ? {blocker:contentBlocker.status(id)} : {}) }; }
      if (action === 'tabs') { store.saveTabs(id, input.state); return true; }
      if (action === 'bookmark') return store.bookmark(id, input);
      if (action === 'remove-bookmark') { store.removeBookmark(id, input.id); return true; }
      if (action === 'clear-history') { store.clearHistory(id); return true; }
      if (action === 'reset-permissions') { store.clearPermissions(id); return true; }
      if (action === 'agent-site-rule') { store.agentRule(id, input.origin, input.rule); agentApprovals.clear(); return true; }
      if (action === 'agent-full-access') { store.agentAskFullAccess(id, input.ask === true); return true; }
      if (action === 'preview-chrome') {
        const data = await chromePreview(input.sourceId, chromeDirectory); const token = randomUUID();
        previews.clear(); previews.set(token, { profileId: id, sourceId: input.sourceId, data, expires: Date.now() + 5 * 60000 });
        const cookies = await cookiePreview(path.join(chromeDirectory??chromeRoot(),input.sourceId));
        return { ...cookies, token, source: data.source, bookmarks: data.bookmarks.length, history: data.history.length, historyError: data.historyError, tabs: data.tabs.length, tabsError: data.tabsError };
      }
      if (action === 'import-chrome') {
        const preview = previews.get(input.token); if (!preview || preview.profileId !== id || preview.expires < Date.now()) throw new Error('Preview expired. Preview chrome again.');
        const categories=input.categories;if(!Array.isArray(categories))throw new Error('Choose data to import');
        let cookies;
        if(categories.includes('cookies')){
          if(!await confirm(`Import saved chrome logins into ${store.profiles().profiles.find(p=>p.id===id).name}?`, 'This grants this profile access to accounts signed into the selected chrome profile. macOS may ask for Chrome Safe Storage access. Existing bos cookies stay unchanged, except google logins, which are replaced with the current ones from chrome. Google may sign a copied login out after a while: import again to refresh it. Some other sites will require signing in again. Library undo does not remove imported logins; use Clear website data to sign out.', ['Cancel','Import logins']))return null;
          cookies=await importChromeCookies(path.join(chromeDirectory??chromeRoot(),preview.sourceId),sessionFromPartition(partition(id)));
        }
        const libraryCategories=categories.filter(c=>c!=='cookies');const result=libraryCategories.length?store.import(id, preview.data, libraryCategories):{bookmarks:0,history:0,tabs:0}; previews.delete(input.token); return {...result,...(cookies?{cookies}: {})};
      }
      if (action === 'undo-import') { store.undoImport(id, input.id); return true; }
      if (action === 'import-passwords') {
        const result = await dialog.showOpenDialog(owner(), { title: 'Choose your chrome password export', properties: ['openFile'], filters: [{ name: 'Password CSV', extensions: ['csv'] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0]; if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Password file is too large');
        const records = parsePasswordCSV(fs.readFileSync(file, 'utf8'));
        if (!records.length) throw new Error('No supported passwords in this export');
        if (!await confirm(`Import ${records.length} passwords into ${store.profiles().profiles.find(p => p.id === id).name}?`, 'Stored encrypted with your system keychain. Matching saved accounts will be updated. Passkeys and payment cards are not included.', ['Cancel', 'Import'])) return null;
        const added = vault.import(id, records);
        const deleted = await confirm('Delete the unencrypted export?', 'The selected CSV contains readable passwords. Delete that export now that the encrypted import succeeded?', ['Keep file', 'Delete export']);
        if (deleted) fs.unlinkSync(file);
        return { added, total: records.length, exportDeleted: deleted };
      }
      if (action === 'passwords') {
        const guest = guestFor(id, input.guestId); const origin = credentialOrigin(guest);
        return vault.summary(id).filter(r => r.origin === origin);
      }
      if (action === 'fill-password') {
        const guest = guestFor(id, input.guestId); const origin = credentialOrigin(guest); const record = vault.credential(id, input.id, origin);
        if (!await confirm(`Fill your saved password on ${new URL(origin).hostname}?`, `Account: ${record.username}`, ['Cancel', 'Fill'])) return false;
        // Recheck after the native confirmation and in the page itself.
        if (guest.isDestroyed() || new URL(guest.getURL()).origin !== origin) throw new Error('The page changed. Try again.');
        return fillLogin(guest, origin, record);
      }
      if (action === 'save-password') {
        const guest = guestFor(id, input.guestId); const origin = credentialOrigin(guest);
        if (!await confirm(`Save the password entered on ${new URL(origin).hostname}?`, 'Save only credentials you own in this profile. The password stays in the encrypted local vault.', ['Cancel', 'Save'])) return false;
        if (guest.isDestroyed() || new URL(guest.getURL()).origin !== origin) throw new Error('The page changed. Try again.');
        const record = await guest.executeJavaScript(`(() => {if(location.origin!==${JSON.stringify(origin)})return null;const p=[...document.querySelectorAll('input[type=password]')].find(e=>e.value&&e.getClientRects().length);if(!p)return null;const scope=p.form||document;const u=scope.querySelector('input[autocomplete=username],input[type=email]')||[...scope.querySelectorAll('input[type=text]')].find(e=>e.getClientRects().length);return {origin:location.origin,username:u?.value||'',password:p.value};})()`);
        if (!record || record.origin !== origin) throw new Error('No entered password found on this page');
        vault.import(id, [record]); return true;
      }
      if (action === 'bot-sign-in') return vault.setBotSignIn(id, input.id, input.allowed !== false);
      if (action === 'remove-password') { if (!await confirm('Remove this saved password?', 'This removes it from the encrypted vault in this profile.', ['Cancel', 'Remove'])) return false; vault.remove(id, input.id); return true; }
      if (action === 'download-open' || action === 'download-reveal') {
        const row = store.read(id).downloads.find(d => d.id === input.id); const saved = downloadPaths.get(input.id); const file = saved?.profile === id ? saved.file : row?.file;
        if (!row || row.state !== 'completed' || !file || !fs.existsSync(file)) throw new Error('Downloaded file is no longer available');
        if (action === 'download-reveal') shell.showItemInFolder(file); else { const error = await shell.openPath(file); if (error) throw new Error('Could not open the downloaded file'); } return true;
      }
      if (action === 'clear-site-data') {
        if (!await confirm('Clear this profile’s website data?', 'This signs you out of websites in this profile. Bookmarks, history and saved passwords remain.', ['Cancel', 'Clear website data'])) return false;
        const ses = sessionFromPartition(partition(id)); await ses.clearStorageData(); await ses.clearCache(); return true;
      }
      if (action === 'export-library') {
        const pick = await dialog.showSaveDialog(owner(), { title: 'Export browser library', defaultPath: 'bos-browser-library.json', filters: [{ name: 'Browser library', extensions: ['json'] }] });
        if (pick.canceled || !pick.filePath) return false;
        const d = store.read(id); fs.writeFileSync(pick.filePath, JSON.stringify({ version: 1, bookmarks: d.bookmarks, history: d.history, ...cleanExportTabs(d) }, null, 2), { mode: 0o600 }); return true;
      }
      if (action === 'restore-library') {
        const pick = await dialog.showOpenDialog(owner(), { title: 'Restore browser library', properties: ['openFile'], filters: [{ name: 'Browser library', extensions: ['json'] }] });
        if (pick.canceled || !pick.filePaths[0]) return false;
        const file = pick.filePaths[0]; if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Library file is too large');
        const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data.version !== 1 || !Array.isArray(data.bookmarks) || !Array.isArray(data.history)) throw new Error('Choose a bos browser library export');
        const result = store.import(id, { ...data, source: 'Browser library export' }, ['bookmarks', 'history']);
        if (Array.isArray(data.tabs) && await confirm('Restore the exported tabs too?', 'These will open as additional tabs in this profile.', ['Library only', 'Restore tabs'])) { const current = store.read(id); const extra = cleanTabs(data).tabs.filter(t => !current.tabs.some(old => old.url === t.url)); store.saveTabs(id, { tabs: [...current.tabs, ...extra.map(t => ({ ...t, id: randomUUID() }))], active: current.active }); }
        return result;
      }
      throw new Error('Unknown browser action');
    },
  };
}
function cleanExportTabs(d) { return { tabs: d.tabs, active: d.active }; }
