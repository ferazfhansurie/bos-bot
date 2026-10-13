// Local browser library. Credentials never enter this store or the renderer.
import { readChromeTabs } from './chrome-tabs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export function webURL(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const text = (s, limit = 200) => typeof s === 'string' ? [...s].filter(c=>c.charCodeAt(0)>=32).join('').slice(0, limit) : '';
export function cleanTabs(input) {
  if (!input || !Array.isArray(input.tabs)) throw new Error('Invalid browser tabs');
  const ids = new Set();
  const tabs = input.tabs.slice(0, 100).flatMap(t => {
    if (!t || typeof t.id !== 'string' || !/^[\w-]{1,80}$/.test(t.id) || ids.has(t.id)) return [];
    const url = t.url === 'about:blank' ? t.url : webURL(t.url);
    if (!url) return [];
    ids.add(t.id);
    return [{ id: t.id, title: text(t.title) || 'New tab', url, pinned: t.pinned === true }];
  });
  return { tabs, active: ids.has(input.active) ? input.active : tabs[0]?.id ?? '' };
}
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}
const empty = () => ({ tabs: [], active: '', bookmarks: [], history: [], downloads: [], permissions: {}, imports: [] });
export function createPrimaryBrowserStore(root) {
  const indexFile = path.join(root, 'profiles.json');
  let index;
  if (fs.existsSync(indexFile)) {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!Array.isArray(index.profiles) || !index.profiles.length || index.profiles.some(p => !/^[\w-]{1,80}$/.test(p.id))) throw new Error('Browser profiles are not readable');
  } else { index = { profiles: [{ id: 'personal', name: 'Personal' }], selected: 'personal' }; atomic(indexFile, JSON.stringify(index)); }
  const fileFor = id => { if (!index.profiles.some(p => p.id === id)) throw new Error('Unknown browser profile'); return path.join(root, `${id}.json`); };
  const read = id => {
    const file = fileFor(id);
    if (!fs.existsSync(file)) return empty();
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(d.bookmarks) || !Array.isArray(d.history)) throw new Error('Browser library is not readable');
    return { ...empty(), ...d, ...cleanTabs(d) };
  };
  const write = (id, d) => atomic(fileFor(id), JSON.stringify(d));
  const mutate = (id, fn) => { const d = read(id); const result = fn(d); write(id, d); return result; };
  return {
    profiles() { return structuredClone(index); },
    create(name) {
      name = text(name, 60).trim(); if (!name) throw new Error('Name your profile');
      if (index.profiles.length >= 30) throw new Error('Profile limit reached');
      const p = { id: randomUUID(), name }; index.profiles.push(p); atomic(indexFile, JSON.stringify(index)); return p;
    },
    select(id) { fileFor(id); index.selected = id; atomic(indexFile, JSON.stringify(index)); },
    read, fileFor,
    saveTabs(id, state) { const tabs = cleanTabs(state); mutate(id, d => Object.assign(d, tabs)); },
    visit(id, url, title) {
      url = webURL(url); if (!url) return;
      mutate(id, d => { const old = d.history.find(h => h.url === url); d.history = [{ id: old?.id ?? randomUUID(), url, title: text(title) || url, visitedAt: Date.now(), visits: (old?.visits ?? 0) + 1 }, ...d.history.filter(h => h.url !== url)].slice(0, 20000); });
    },
    bookmark(id, input) {
      const url = webURL(input?.url); if (!url) throw new Error('Only web pages can be bookmarked');
      return mutate(id, d => { const old = d.bookmarks.find(b => b.url === url && b.folder === ''); if (old) return old; const b = { id: randomUUID(), url, title: text(input.title) || url, folder: '' }; d.bookmarks.push(b); return b; });
    },
    removeBookmark(id, bookmarkId) { mutate(id, d => { d.bookmarks = d.bookmarks.filter(b => b.id !== bookmarkId); }); },
    clearHistory(id) { mutate(id, d => { d.history = []; }); },
    permission(id, origin, permission, allowed) {
      const url = webURL(origin); if (!url) throw new Error('Invalid site');
      mutate(id, d => { d.permissions[`${new URL(url).origin}|${permission}`] = allowed === true; });
    },
    clearPermissions(id) { mutate(id, d => { d.permissions = {}; }); },
    download(id, row) { mutate(id, d => { d.downloads = [{ ...row }, ...d.downloads.filter(x => x.id !== row.id)].slice(0, 200); }); },
    import(id, preview, categories) {
      if (!Array.isArray(categories) || !categories.length || categories.some(c => !['bookmarks', 'history', 'tabs'].includes(c))) throw new Error('Choose bookmarks or history');
      return mutate(id, d => {
        const added = { bookmarks: [], history: [], tabs: [] }; const batchId = randomUUID();
        for (const category of categories.filter(c => c !== 'tabs')) {
          const keys = new Set(d[category].map(x => `${x.url}|${category === 'bookmarks' ? x.folder : ''}`));
          for (const raw of (preview[category] ?? []).slice(0, 20000)) {
            if (d[category].length >= 20000) break;
            const url = webURL(raw.url); if (!url) continue;
            const folder = category === 'bookmarks' ? text(raw.folder, 1000) : '';
            const key = `${url}|${folder}`; if (keys.has(key)) continue; keys.add(key);
            const entry = { id: randomUUID(), title: text(raw.title) || url, url, ...(category === 'bookmarks' ? { folder } : { visitedAt: Number(raw.visitedAt) || Date.now(), visits: Number(raw.visits) || 1 }) };
            d[category].push(entry); added[category].push(entry.id);
          }
        }
        if (categories.includes('tabs')) { const keys = new Set(d.tabs.map(t=>t.url)); for(const raw of preview.tabs??[]) {const url=webURL(raw.url);if(!url||keys.has(url)||d.tabs.length>=100)continue;keys.add(url);const t={id:randomUUID(),url,title:text(raw.title)||url,pinned:raw.pinned===true};d.tabs.push(t);added.tabs.push(t.id);}if(!d.active)d.active=d.tabs[0]?.id??''; }
        d.history.sort((a, b) => b.visitedAt - a.visitedAt);
        d.imports = [{ id: batchId, source: text(preview.source), at: Date.now(), added }, ...d.imports].slice(0, 10);
        return { id: batchId, bookmarks: added.bookmarks.length, history: added.history.length, tabs: added.tabs.length };
      });
    },
    undoImport(id, batchId) { mutate(id, d => { const batch = d.imports.find(b => b.id === batchId); if (!batch) throw new Error('Import no longer available'); for (const category of ['bookmarks', 'history']) { const ids = new Set(batch.added[category]); d[category] = d[category].filter(x => !ids.has(x.id)); } d.tabs=d.tabs.filter(t=>!(batch.added.tabs??[]).includes(t.id));if(!d.tabs.some(t=>t.id===d.active))d.active=d.tabs[0]?.id??''; d.imports = d.imports.filter(b => b.id !== batchId); }); },
  };
}

export function chromeRoot(home = os.homedir(), platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome');
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'Google/Chrome/User Data');
  return path.join(home, '.config/google-chrome');
}
export function chromeProfiles(root = chromeRoot()) {
  const file = path.join(root, 'Local State'); if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(data.profile?.info_cache ?? {}).filter(([id]) => /^(Default|Profile \d+)$/.test(id)).map(([id, info]) => ({ id, name: text(info.name) || id }));
}
export function chromeBookmarks(data) {
  const result = [];
  function walk(node, folders) {
    if (result.length >= 20000 || folders.length > 40) return;
    if (node.type === 'url') { const url = webURL(node.url); if (url) result.push({ url, title: text(node.name), folder: folders.join('/') }); }
    else for (const child of (node.children ?? [])) walk(child, [...folders, text(node.name)]);
  }
  for (const node of Object.values(data.roots ?? {})) walk(node, []);
  return result;
}
export async function chromePreview(sourceId, root = chromeRoot()) {
  const p = chromeProfiles(root).find(p => p.id === sourceId); if (!p) throw new Error('Choose an available chrome profile');
  const directory = path.join(root, p.id); const file = path.join(directory, 'Bookmarks');
  const bookmarks = fs.existsSync(file) ? chromeBookmarks(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  let history = [], historyError = '';
  if (fs.existsSync(path.join(directory, 'History'))) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(directory, 'History'), { readOnly: true });
      try { history = db.prepare('SELECT url, title, visit_count AS visits, (last_visit_time / 1000 - 11644473600000) AS visitedAt FROM urls ORDER BY last_visit_time DESC LIMIT 20000').all().filter(h => webURL(h.url)); } finally { db.close(); }
    } catch { historyError = 'History could not be read. Close chrome and preview again.'; }
  }
  return { source: p.name, bookmarks, history, historyError, ...readChromeTabs(directory) };
}

export function parsePasswordCSV(input) {
  if (input.length > 20 * 1024 * 1024) throw new Error('Password file is too large');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && input[i + 1] === '\n') i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('Password file is incomplete');
  row.push(field); if (row.some(Boolean)) rows.push(row);
  const headers = (rows.shift() ?? []).map(h => h.replace(/^\uFEFF/, '').toLowerCase().trim());
  const urlAt = headers.indexOf('url'), userAt = headers.indexOf('username'), passAt = headers.indexOf('password');
  if ([urlAt, userAt, passAt].some(i => i < 0)) throw new Error('Choose a chrome password export with url, username and password columns');
  return rows.slice(0, 20000).flatMap(r => { const url = webURL(r[urlAt]); return url && r[passAt] ? [{ origin: new URL(url).origin, username: r[userAt] ?? '', password: r[passAt] }] : []; });
}

export function createBrowserVault(root, encryption) {
  const fileFor = id => { if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid profile'); return path.join(root, `${id}.vault`); };
  const available = () => { if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure password storage is unavailable. Unlock your system keychain and retry.'); };
  const read = id => { available(); const file = fileFor(id); return fs.existsSync(file) ? JSON.parse(encryption.decryptString(fs.readFileSync(file))) : []; };
  return {
    summary(id) { return read(id).map(({ id, origin, username }) => ({ id, origin, username })); },
    import(id, records) { const rows = read(id); let added = 0; for (const r of records) { const origin = webURL(r.origin); if (!origin || new URL(origin).origin !== r.origin || typeof r.password !== 'string' || !r.password || r.password.length > 8192 || typeof r.username !== 'string') continue; const old = rows.find(x => x.origin === r.origin && x.username === r.username); if (old) { old.password = r.password; } else { rows.push({ origin: r.origin, username: r.username.slice(0, 8192), password: r.password, id: randomUUID() }); added++; } } atomic(fileFor(id), encryption.encryptString(JSON.stringify(rows))); return added; },
    credential(id, credentialId, origin) { const row = read(id).find(r => r.id === credentialId && r.origin === origin); if (!row) throw new Error('Password does not match this site'); return row; },
    remove(id, credentialId) { const rows = read(id).filter(r => r.id !== credentialId); atomic(fileFor(id), encryption.encryptString(JSON.stringify(rows))); },
  };
}
