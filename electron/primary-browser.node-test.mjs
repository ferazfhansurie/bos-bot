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
function actionFixture(t, dialog = {}) {
 const registry = createWorkspaceBrowserRegistry(), calls = [], root = temp(t);
 let attached = false;
 const debug = Object.assign(new EventEmitter(), { isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; debug.emit('detach'); }, async sendCommand(method, params) { calls.push([method, params]); return method === 'DOM.getBoxModel' ? { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } } : {}; } });
 const guest = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, debugger: debug, capturePage: async () => { calls.push(['capture']); return { toPNG: () => Buffer.from('fixture-png') }; }, enableDeviceEmulation: options => calls.push(['emulate', options]), disableDeviceEmulation: () => calls.push(['reset']), inspectElement: (x, y) => calls.push(['inspect', x, y]) });
 const controller = createPrimaryBrowserController({ root, encryption: encryption(), registry, sessionFromPartition: () => ({}), contentsFromId: id => id === 1 ? guest : null, owner: () => null, shell: {}, dialog });
 registry.attach(guest, controller.partition('personal'));
 return { controller, calls, root, debug, guest };
}
test('native browser actions reject missing guests and cross-profile targets before native effects', async t => {
 const { controller, calls } = actionFixture(t);
 const other = controller.store.create('Other');
 for (const action of ['screenshot', 'thumbnail', 'inspect-element', 'device-toolbar']) {
  await assert.rejects(controller.action(action, { profileId: other.id, guestId: 1, device: 'mobile' }), /no longer available/);
  await assert.rejects(controller.action(action, { profileId: 'personal', guestId: 999, device: 'mobile' }), /no longer available/);
 }
 assert.deepEqual(calls, []);
});
test('thumbnail returns a small jpeg without a dialog, or null for a blank page', async t => {
 const fixture = actionFixture(t, { async showSaveDialog() { throw new Error('no dialog for a thumbnail'); } });
 let empty = false, options;
 const image = { isEmpty: () => empty, getSize: () => ({ width: 1920, height: 1080 }), resize: ({ width }) => ({ width, toJPEG: () => Buffer.from('small') }), toJPEG: () => Buffer.from('big') };
 fixture.guest.capturePage = async (_rect, opts) => { options = opts; return image; };
 assert.equal(await fixture.controller.action('thumbnail', { profileId: 'personal', guestId: 1 }), `data:image/jpeg;base64,${Buffer.from('small').toString('base64')}`);
 assert.deepEqual(options, { stayHidden: true });
 empty = true;
 assert.equal(await fixture.controller.action('thumbnail', { profileId: 'personal', guestId: 1 }), null);
});
test('screenshot writes only the native selected path and cancellation does not write', async t => {
 let selected, canceled = false;
 const fixture = actionFixture(t, { async showSaveDialog(_owner, options) { assert.deepEqual(options.filters[0].extensions, ['png']); return { canceled, filePath: selected }; } });
 selected = path.join(fixture.root, 'capture.png');
 assert.equal(await fixture.controller.action('screenshot', { profileId: 'personal', guestId: 1, filePath: '/ignored' }), true);
 assert.equal(fs.readFileSync(selected, 'utf8'), 'fixture-png');
 assert.equal(fs.statSync(selected).mode & 0o777, 0o600);
 canceled = true; selected = path.join(fixture.root, 'canceled.png');
 assert.equal(await fixture.controller.action('screenshot', { profileId: 'personal', guestId: 1 }), false);
 assert.equal(fs.existsSync(selected), false);
});
test('device presets use native mobile emulation and desktop resets it', async t => {
 const { controller, calls } = actionFixture(t);
 for (const device of ['mobile', 'tablet', 'desktop']) assert.equal(await controller.action('device-toolbar', { profileId: 'personal', guestId: 1, device }), device);
 assert.deepEqual(calls[0][1].viewSize, { width: 390, height: 844 });
 assert.deepEqual(calls[1][1].viewSize, { width: 820, height: 1180 });
 assert.deepEqual(calls[2], ['reset']);
 await assert.rejects(controller.action('device-toolbar', { profileId: 'personal', guestId: 1, device: 'arbitrary' }), /Choose desktop/);
 assert.equal(calls.length, 3);
});
test('element picker scopes CDP to its guest then opens native inspection at the picked element', async t => {
 const { controller, calls, debug } = actionFixture(t);
 assert.equal(await controller.action('inspect-element', { profileId: 'personal', guestId: 1 }), true);
 assert.equal(debug.isAttached(), true);
 assert.equal(calls.find(([method]) => method === 'Overlay.setInspectMode')[1].mode, 'searchForNode');
 debug.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 17 });
 await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(calls.find(([method]) => method === 'DOM.getBoxModel'), ['DOM.getBoxModel', { backendNodeId: 17 }]);
 assert.deepEqual(calls.at(-1), ['inspect', 20, 30]);
 assert.equal(debug.isAttached(), false);
 assert.equal(debug.listenerCount('message'), 0);
});
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
test('bots sign in with a saved login for the exact origin unless switched off, without a prompt or the password in the result', async t => {
 const registry = createWorkspaceBrowserRegistry(); let url = 'https://staging.example.com/login'; const scripts = []; let prompts = 0;
 const guest = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, getURL: () => url, executeJavaScript: async s => { scripts.push(s); return true; } });
 const root = temp(t), crypt = encryption();
 const controller = createPrimaryBrowserController({ root, encryption: crypt, registry, sessionFromPartition: () => ({}), contentsFromId: id => id === 1 ? guest : null, owner: () => null, shell: {}, dialog: { async showMessageBox() { prompts++; return { response: 1 }; } } });
 registry.attach(guest, controller.partition('personal')); const vault = createBrowserVault(root, crypt);
 vault.import('personal', [{ origin: 'https://staging.example.com', username: 'qa', password: 'fixture-secret' }, { origin: 'https://other.example.com', username: 'qa', password: 'other-secret' }]);
 const result = await controller.botSignIn('personal', 1);
 assert.deepEqual(result, { username: 'qa', origin: 'https://staging.example.com' }); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(prompts, 0);
 assert.equal(scripts.length, 1); assert.match(scripts[0], /fixture-secret/); assert.doesNotMatch(scripts[0], /other-secret/);
 const id = vault.summary('personal').find(r => r.origin === 'https://staging.example.com').id;
 assert.equal(await controller.action('bot-sign-in', { profileId: 'personal', id, allowed: false }), false);
 assert.equal(vault.summary('personal').find(r => r.id === id).botSignIn, false);
 await assert.rejects(controller.botSignIn('personal', 1), /No saved login/);
 url = 'http://staging.example.com/login'; await assert.rejects(controller.botSignIn('personal', 1), /HTTPS/);
 assert.equal(scripts.length, 1);
});
test('agent site approvals are profile and conversation scoped, and refuse navigation during confirmation', async t => {
 const registry=createWorkspaceBrowserRegistry();let url='https://example.com/page';let prompts=0;let navigate=false;
 const guest=Object.assign(new EventEmitter(),{id:77,isDestroyed:()=>false,getURL:()=>url});
 const c=createPrimaryBrowserController({root:temp(t),encryption:encryption(),registry,sessionFromPartition:()=>({}),contentsFromId:()=>guest,owner:()=>null,shell:{},dialog:{async showMessageBox(){prompts++;if(navigate)url='https://other.com';return {response:1};}}});
 registry.attach(guest,c.partition('personal'));
 c.store.agentRule('personal','https://example.com',{browse:'ask',download:'block',upload:'ask'});
 await c.authorizeAgent('personal',77,url,'browse','','turn-a');await c.authorizeAgent('personal',77,url,'browse','','turn-a');assert.equal(prompts,1);
 await c.authorizeAgent('personal',77,url,'browse','','turn-b');assert.equal(prompts,2);
 await assert.rejects(c.authorizeAgent('personal',77,url,'download'),/blocked/);assert.equal(prompts,2);
 await Promise.all([c.authorizeAgent('personal',77,url,'upload','','turn-a'),c.authorizeAgent('personal',77,url,'upload','','turn-a')]);await c.authorizeAgent('personal',77,url,'upload','','turn-a');assert.equal(prompts,3);
 navigate=true;await assert.rejects(c.authorizeAgent('personal',77,url,'upload','','turn-c'),/page changed/);
});
test('profiles rename, and delete removes their library while keeping the last one', t => {
 const root = temp(t), store = createPrimaryBrowserStore(root), work = store.create('Work'), client = store.create('Client');
 assert.equal(store.rename(work.id, '  Work stuff ').name, 'Work stuff');
 assert.throws(() => store.rename(work.id, '   '), /Name your profile/); assert.throws(() => store.rename('missing', 'x'), /Unknown/);
 store.bookmark(work.id, { url: 'https://work.com' }); const file = store.fileFor(work.id); assert.ok(fs.existsSync(file));
 store.select(work.id);
 const after = store.remove(work.id);
 assert.deepEqual(after.profiles.map(p => p.name), ['Personal', 'Client']); assert.equal(after.selected, client.id, 'the next profile takes over the selection');
 assert.ok(!fs.existsSync(file)); assert.throws(() => store.read(work.id), /Unknown/);
 const reopened = createPrimaryBrowserStore(root); assert.equal(reopened.profiles().selected, client.id); assert.equal(reopened.profiles().profiles.length, 2);
 assert.equal(store.remove('personal').selected, client.id, 'deleting an unselected profile keeps the selection');
 assert.throws(() => store.remove(client.id), /at least one/); assert.equal(store.profiles().profiles.length, 1);
});
test('deleting a profile asks, refuses while a bot drives it, and wipes logins, vault and approvals', async t => {
 const root = temp(t), registry = createWorkspaceBrowserRegistry(), cleared = [], asked = [];
 let answer = 0, busy = false;
 const controller = createPrimaryBrowserController({ root, encryption: encryption(), registry, sessionFromPartition: p => ({ clearStorageData: async () => cleared.push(['storage', p]), clearCache: async () => cleared.push(['cache', p]) }), contentsFromId: () => null, owner: () => null, shell: {}, agentBusy: () => busy, dialog: { showMessageBox: async (_w, o) => { asked.push(o.message); return { response: answer }; } } });
 const work = controller.store.create('Work'); const p = controller.partition(work.id);
 controller.store.bookmark(work.id, { url: 'https://work.com' });
 fs.writeFileSync(path.join(root, `${work.id}.vault`), 'x'); fs.writeFileSync(path.join(root, `${work.id}.blocker.json`), '{}');
 busy = true; await assert.rejects(controller.action('delete', { profileId: work.id }), /bot is using/); assert.deepEqual(asked, []);
 busy = false; assert.equal(await controller.action('delete', { profileId: work.id }), null, 'cancel keeps it');
 assert.match(asked[0], /Delete the browser profile “Work”/); assert.ok(controller.store.read(work.id)); assert.deepEqual(cleared, []);
 answer = 1; const next = await controller.action('delete', { profileId: work.id });
 assert.deepEqual(next.profiles.map(x => x.id), ['personal']); assert.deepEqual(cleared, [['storage', p], ['cache', p]]);
 for (const f of [`${work.id}.json`, `${work.id}.vault`, `${work.id}.blocker.json`]) assert.ok(!fs.existsSync(path.join(root, f)), f);
 assert.equal(controller.profileFor(p), undefined);
 await assert.rejects(controller.action('delete', { profileId: 'personal' }), /at least one/);
 assert.equal((await controller.action('rename', { profileId: 'personal', name: 'Me' })).name, 'Me');
});
test('full access skips every ask prompt unless the profile keeps asking; block rules still hold', async t => {
 const registry=createWorkspaceBrowserRegistry();let prompts=0;const url='https://mail.example.com/compose';
 const guest=Object.assign(new EventEmitter(),{id:78,isDestroyed:()=>false,getURL:()=>url});
 const c=createPrimaryBrowserController({root:temp(t),encryption:encryption(),registry,sessionFromPartition:()=>({}),contentsFromId:()=>guest,owner:()=>null,shell:{},dialog:{async showMessageBox(){prompts++;return {response:1};}}});
 registry.attach(guest,c.partition('personal'));
 c.store.agentRule('personal','https://mail.example.com',{browse:'ask',download:'ask',upload:'ask'});
 for (const action of ['browse','upload','download']) await c.authorizeAgent('personal',78,url,action,'','turn-a',{fullAccess:true});
 await c.authorizeAgent('personal',78,'https://other.example.com/form','upload','','turn-a',{fullAccess:true});
 assert.equal(prompts,0,'full access never asks, on ruled or default sites');
 await c.authorizeAgent('personal',78,url,'upload','','turn-b');assert.equal(prompts,1,'ask mode still prompts');
 c.store.agentRule('personal','https://mail.example.com',{browse:'allow',download:'block',upload:'ask'});
 await assert.rejects(c.authorizeAgent('personal',78,url,'download','','turn-a',{fullAccess:true}),/blocked/);
 assert.equal(await c.action('agent-full-access',{profileId:'personal',ask:true}),true);assert.equal(c.store.read('personal').agentAskFullAccess,true);
 await c.authorizeAgent('personal',78,url,'upload','','turn-c',{fullAccess:true});assert.equal(prompts,2,'the profile switch brings prompts back');
 await c.action('agent-full-access',{profileId:'personal',ask:false});assert.equal('agentAskFullAccess' in c.store.read('personal'),false);
 await c.authorizeAgent('personal',78,url,'upload','','turn-d',{fullAccess:true});assert.equal(prompts,2);
});
