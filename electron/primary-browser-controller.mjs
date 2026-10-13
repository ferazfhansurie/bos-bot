import path from 'node:path';
import { cookiePreview, importChromeCookies } from './chrome-cookies.mjs';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createPrimaryBrowserStore, createBrowserVault, chromeProfiles, chromePreview, parsePasswordCSV, webURL, cleanTabs, chromeRoot } from './primary-browser.mjs';

// Only wired to the main window's local-only IPC. No HTTP/tool/model access.
export function createPrimaryBrowserController({ root, encryption, registry, sessionFromPartition, contentsFromId, dialog, owner, shell, chromeDirectory, shared, contentBlocker, allowInsecureTestOrigins = [] }) {
  const store = createPrimaryBrowserStore(root);
  const vault = createBrowserVault(root, encryption);
  const profiles = new Map(); const previews = new Map(); const downloadPaths = new Map();
  const partition = id => { store.fileFor(id); const p = registry.register(`primary:${id}`); profiles.set(p, id); return p; };
  const profileFor = p => profiles.get(p);
  const confirm = async (message, detail, buttons = ['Cancel', 'Allow']) => (await dialog.showMessageBox(owner(), { type: 'question', message, detail, buttons, defaultId: 0, cancelId: 0 })).response === 1;
  const credentialOrigin = guest => { const url = webURL(guest.getURL()); if (!url) throw new Error('Open a secure sign-in page'); const u = new URL(url); if (u.protocol !== 'https:' && !allowInsecureTestOrigins.includes(u.origin)) throw new Error('Saved passwords require an HTTPS sign-in page'); return u.origin; };
  const guestFor = (id, guestId) => { const guest = contentsFromId(guestId); if (!guest || guest.isDestroyed() || registry.source(guest)?.partition !== partition(id)) throw new Error('This browser tab is no longer available'); return guest; };
  return {
    store, partition, profileFor,
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
    async action(action, input = {}) {
      if (action === 'profiles') return store.profiles();
      if (action === 'create') return store.create(input.name);
      if (action === 'chrome-profiles') return chromeProfiles(chromeDirectory);
      const id = input.profileId; store.fileFor(id);
      if (action === 'blocker-status') return contentBlocker?.status(id, input.guestId ? guestFor(id,input.guestId) : undefined);
      if (action === 'blocker-toggle') return contentBlocker?.toggle(id, input.guestId ? guestFor(id,input.guestId) : undefined, {enabled:input.enabled,siteOnly:input.siteOnly===true});
      if (action === 'share') { const guest = guestFor(id, input.guestId); if (!webURL(guest.getURL())) throw new Error('Open a webpage before sharing'); return shared.grant({ botId: input.botId, threadId: input.threadId, guestId: guest.id }); }
      if (action === 'take-control') { const guest = guestFor(id, input.guestId); shared.revoke(guest.id); return true; }
      if (action === 'shared-state') return shared?.state(guestFor(id, input.guestId).id) ?? { shared: false };
      if (action === 'select') { store.select(id); return partition(id); }
      if (action === 'read') { const d = store.read(id); return { ...d, downloads: d.downloads.map(({ file: _file, ...row }) => row), partition: partition(id), ...(contentBlocker ? {blocker:contentBlocker.status(id)} : {}) }; }
      if (action === 'tabs') { store.saveTabs(id, input.state); return true; }
      if (action === 'bookmark') return store.bookmark(id, input);
      if (action === 'remove-bookmark') { store.removeBookmark(id, input.id); return true; }
      if (action === 'clear-history') { store.clearHistory(id); return true; }
      if (action === 'reset-permissions') { store.clearPermissions(id); return true; }
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
          if(!await confirm(`Import saved chrome logins into ${store.profiles().profiles.find(p=>p.id===id).name}?`, 'This grants this profile access to accounts signed into the selected chrome profile. macOS may ask for Chrome Safe Storage access. Existing bos cookies stay unchanged. Some sites will require signing in again. Library undo does not remove imported logins; use Clear website data to sign out.', ['Cancel','Import logins']))return null;
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
        return guest.executeJavaScript(`(() => { if(location.origin!==${JSON.stringify(origin)})return false; const passwords=[...document.querySelectorAll('input[type=password]')].filter(e=>e.getClientRects().length); if(passwords.length!==1)return false; const p=passwords[0];const scope=p.form||document;const u=scope.querySelector('input[autocomplete=username],input[type=email]')||[...scope.querySelectorAll('input[type=text]')].find(e=>e.getClientRects().length);const set=(e,v)=>{if(!e)return;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};set(u,${JSON.stringify(record.username)});set(p,${JSON.stringify(record.password)});return true;})()`);
      }
      if (action === 'save-password') {
        const guest = guestFor(id, input.guestId); const origin = credentialOrigin(guest);
        if (!await confirm(`Save the password entered on ${new URL(origin).hostname}?`, 'Save only credentials you own in this profile. The password stays in the encrypted local vault.', ['Cancel', 'Save'])) return false;
        if (guest.isDestroyed() || new URL(guest.getURL()).origin !== origin) throw new Error('The page changed. Try again.');
        const record = await guest.executeJavaScript(`(() => {if(location.origin!==${JSON.stringify(origin)})return null;const p=[...document.querySelectorAll('input[type=password]')].find(e=>e.value&&e.getClientRects().length);if(!p)return null;const scope=p.form||document;const u=scope.querySelector('input[autocomplete=username],input[type=email]')||[...scope.querySelectorAll('input[type=text]')].find(e=>e.getClientRects().length);return {origin:location.origin,username:u?.value||'',password:p.value};})()`);
        if (!record || record.origin !== origin) throw new Error('No entered password found on this page');
        vault.import(id, [record]); return true;
      }
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
