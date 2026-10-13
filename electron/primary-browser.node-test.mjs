import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createPrimaryBrowserStore, createBrowserVault, parsePasswordCSV, chromePreview, cleanTabs } from './primary-browser.mjs';
import { createPrimaryBrowserController } from './primary-browser-controller.mjs';
import { createWorkspaceBrowserRegistry } from './workspace-browser.mjs';
import { EventEmitter } from 'node:events';
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bos-browser-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const encryption = () => { const key = randomBytes(32); return { isEncryptionAvailable: () => true, encryptString(s) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(s), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }, decryptString(b) { const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); } }; };
test('profiles and browser library survive restart without leaking into another profile', t => {
 const root = temp(t), store = createPrimaryBrowserStore(root), work = store.create('Work');
 store.saveTabs('personal', { tabs: [{ id: 'a', url: 'https://example.com', title: 'Example' }], active: 'a' }); store.visit('personal', 'https://example.com', 'Example'); store.bookmark('personal', { url: 'https://example.com', title: 'Example' });
 const reopened = createPrimaryBrowserStore(root); assert.equal(reopened.read('personal').tabs[0].id, 'a'); assert.equal(reopened.read('personal').history.length, 1); assert.equal(reopened.read(work.id).history.length, 0);
 assert.throws(() => reopened.read('../outside')); assert.throws(() => reopened.select('missing')); assert.equal(fs.statSync(store.fileFor('personal')).mode & 0o777, 0o600);
});
test('imports preserve folders, skip duplicates and undo only their new records', t => {
 const store = createPrimaryBrowserStore(temp(t)); store.bookmark('personal', { url: 'https://existing.com', title: 'Existing' });
 const preview = { source: 'Chrome', bookmarks: [{ url: 'https://existing.com', title: 'Existing', folder: '' }, { url: 'https://new.com', title: 'New', folder: 'Work/Projects' }, { url: 'javascript:alert(1)', title: 'Unsafe' }], history: [{ url: 'https://new.com', title: 'New', visitedAt: 123 }] };
 const first = store.import('personal', preview, ['bookmarks', 'history']); assert.equal(first.bookmarks, 1); assert.equal(first.history, 1); assert.equal(store.read('personal').bookmarks[1].folder, 'Work/Projects');
 const next = store.import('personal', preview, ['bookmarks', 'history']); assert.equal(next.bookmarks, 0); assert.equal(next.history, 0);
 store.bookmark('personal', { url: 'https://manual.com', title: 'Manual' }); store.undoImport('personal', first.id); assert.deepEqual(store.read('personal').bookmarks.map(x => x.title), ['Existing', 'Manual']);
 assert.throws(() => store.import('personal', preview, ['passwords']));
});
test('corrupt data is reported without replacing it with an empty profile', t => {
 const root = temp(t), store = createPrimaryBrowserStore(root); fs.writeFileSync(store.fileFor('personal'), '{broken'); assert.throws(() => store.read('personal')); assert.throws(() => store.bookmark('personal', { url: 'https://example.com' })); assert.equal(fs.readFileSync(store.fileFor('personal'), 'utf8'), '{broken');
 fs.writeFileSync(path.join(root, 'profiles.json'), '{broken'); assert.throws(() => createPrimaryBrowserStore(root));
});
test('unsafe tab urls and duplicate ids cannot be persisted', () => {
 assert.deepEqual(cleanTabs({ tabs: [{ id: 'a', url: 'https://example.com' }, { id: 'a', url: 'https://other.com' }, { id: 'b', url: 'file:///etc/passwd' }, { id: 'c', url: 'https://user:pass@example.com' }], active: 'b' }).tabs.map(t => t.id), ['a']);
});
test('quoted password CSV supports commas, quotes and embedded newlines without unsafe urls', () => {
 const parsed = parsePasswordCSV('name,url,username,password\r\nExample,https://example.com,"a,b","p""ass\nword"\r\nUnsafe,javascript:evil,a,b'); assert.equal(parsed.length, 1); assert.equal(parsed[0].username, 'a,b'); assert.equal(parsed[0].password, 'p"ass\nword'); assert.throws(() => parsePasswordCSV('url,username,password\n"broken'));
});
test('vault persists only ciphertext, isolates profiles and refuses insecure backend or corruption', t => {
 const root = temp(t), crypt = encryption(), vault = createBrowserVault(root, crypt); const secret = 'fixture-only-password'; vault.import('personal', [{ origin: 'https://example.com', username: 'fixture', password: secret }]);
 assert.equal(fs.readFileSync(path.join(root, 'personal.vault')).includes(Buffer.from(secret)), false); assert.equal(vault.summary('personal')[0].password, undefined); assert.equal(vault.summary('work').length, 0);
 const row = vault.summary('personal')[0]; assert.equal(vault.credential('personal', row.id, row.origin).password, secret); assert.throws(() => vault.credential('personal', row.id, 'https://evil.com'));
 assert.throws(() => createBrowserVault(root, { ...crypt, getSelectedStorageBackend: () => 'basic_text' }).summary('personal'));
 fs.writeFileSync(path.join(root, 'personal.vault'), 'corrupt'); assert.throws(() => vault.import('personal', [])); assert.equal(fs.readFileSync(path.join(root, 'personal.vault'), 'utf8'), 'corrupt');
});
test('chrome read is bounded, read-only, preserves bookmark hierarchy and reports unavailable history', async t => {
 const root = temp(t); fs.mkdirSync(path.join(root, 'Default')); fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Fixture' }, '../outside': { name: 'Bad' } } } })); const data = JSON.stringify({ roots: { bar: { type: 'folder', name: 'Bookmarks bar', children: [{ type: 'folder', name: 'Work', children: [{ type: 'url', name: 'Example', url: 'https://example.com' }] }] } } }); fs.writeFileSync(path.join(root, 'Default/Bookmarks'), data); fs.writeFileSync(path.join(root, 'Default/History'), 'invalid');
 const result = await chromePreview('Default', root); assert.equal(result.bookmarks[0].folder, 'Bookmarks bar/Work'); assert.ok(result.historyError); assert.equal(fs.readFileSync(path.join(root, 'Default/Bookmarks'), 'utf8'), data); await assert.rejects(chromePreview('../outside', root));
});
test('controller will not fill a credential after a navigation or in another profile, or grant iframe permissions', async t => {
 const registry = createWorkspaceBrowserRegistry(); let url = 'https://example.com/login'; let executed = false; let navigateOnConfirm = false;
 const guest = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, getURL: () => url, executeJavaScript: async () => { executed = true; return true; } });
 const root = temp(t), crypt = encryption();
 const controller = createPrimaryBrowserController({ root, encryption: crypt, registry, sessionFromPartition: () => ({}), contentsFromId: id => id === 1 ? guest : null, owner: () => null, shell: {}, dialog: { async showMessageBox() { if (navigateOnConfirm) url = 'https://evil.com/'; return { response: 1 }; } } });
 const p = controller.partition('personal'); registry.attach(guest, p); const vault = createBrowserVault(root, crypt); vault.import('personal', [{ origin: 'https://example.com', username: 'user', password: 'dummy' }]); const credential = vault.summary('personal')[0];
 assert.equal(await controller.permission(p, guest, 'media', { requestingUrl: 'https://evil.com' }), false);
 const work = controller.store.create('Work'); await assert.rejects(controller.action('passwords', { profileId: work.id, guestId: 1 }));
 navigateOnConfirm = true; await assert.rejects(controller.action('fill-password', { profileId: 'personal', guestId: 1, id: credential.id })); assert.equal(executed, false);
});
test('a full history import does not destroy preexisting history on undo',t=>{
 const store=createPrimaryBrowserStore(temp(t));const file=store.fileFor('personal');const data=store.read('personal');data.history=Array.from({length:20000},(_,i)=>({id:`old-${i}`,url:`https://example.com/${i}`,title:'Old',visitedAt:i}));fs.writeFileSync(file,JSON.stringify(data));
 const imported=store.import('personal',{source:'Chrome',history:[{url:'https://new.com',visitedAt:999999}]},['history']);store.undoImport('personal',imported.id);assert.equal(store.read('personal').history.length,20000);assert.equal(store.read('personal').history.some(h=>h.id==='old-0'),true);
});
test('password metadata and filling reject insecure origins',async t=>{
 const registry=createWorkspaceBrowserRegistry(),guest=Object.assign(new EventEmitter(),{id:1,isDestroyed:()=>false,getURL:()=> 'http://example.com/login'});
 const c=createPrimaryBrowserController({root:temp(t),encryption:encryption(),registry,sessionFromPartition:()=>({}),contentsFromId:()=>guest,owner:()=>null,shell:{},dialog:{}});registry.attach(guest,c.partition('personal'));
 await assert.rejects(c.action('passwords',{profileId:'personal',guestId:1}),/HTTPS/);await assert.rejects(c.action('fill-password',{profileId:'personal',guestId:1,id:'test'}),/HTTPS/);
});
