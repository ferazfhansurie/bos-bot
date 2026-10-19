import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSharedBrowser } from './shared-browser.mjs';

function fixture(mounted = true) {
  let browser, tabs = [], active = '', selected = 'personal'; const commands = [], states = [];
  const report = (profileId = selected) => { selected = profileId; return browser.reportTabs({ profileId, selected: true, mounted: true, tabs, active }); };
  browser = createSharedBrowser({ contentsFromId: () => null, host: {
    available: () => true, reveal: () => {}, command: command => {
      commands.push(command);
      if (command.op === 'new') { tabs.push({ id: command.tabId, url: command.url }); active = command.tabId; }
      if (command.op === 'close') tabs = tabs.filter(tab => tab.id !== command.tabId);
      if (command.op === 'activate') active = command.tabId;
      report(); return true;
    },
  }, notify: state => states.push(state) });
  if (mounted) report();
  return { browser, commands, states, report, call: (thread, name, args = {}, authority = {}) => browser.rpc('same-bot', thread, 'tools/call', { name, arguments: args }, Date.now() + 2000, authority) };
}

test('configured profile refuses a different selected profile without commands', async () => {
  const f = fixture();
  await assert.rejects(f.call('a', 'agent_browser_tab_new', {}, { profileId: 'client' }), /profile/);
  assert.equal(f.commands.length, 0);
  f.report('client');
  assert.match((await f.call('a', 'agent_browser_tab_new', {}, { profileId: 'client' })).content[0].text, /Opened/);
});

test('release cancels a call waiting for the panel and its queued successor', async () => {
  const f = fixture(false);
  const pending = f.call('a', 'agent_browser_tab_new', {}, { generation: 'one' });
  const queued = f.call('a', 'agent_browser_tab_new', {}, { generation: 'one' });
  const failures = [assert.rejects(pending, /turn ended/), assert.rejects(queued, /turn ended/)];
  await new Promise(resolve => setTimeout(resolve, 10));
  f.browser.release('a', 'one'); f.report();
  await Promise.all(failures); assert.equal(f.commands.length, 0);
});

test('an old generation release cannot hand back the new turn tab', async () => {
  const f = fixture();
  await f.call('a', 'agent_browser_tab_new', {}, { generation: 'one' });
  await f.call('a', 'agent_browser_tab_new', {}, { generation: 'two' });
  f.browser.release('a', 'one');
  assert.equal(Object.values(f.states.at(-1).tabs)[0].mode, 'bot');
  await f.call('a', 'agent_browser_tab_list', {}, { generation: 'two' });
});

test('created tab cannot be closed after another same-bot thread claims it', async () => {
  const f = fixture();
  await f.call('a', 'agent_browser_tab_new'); await f.call('a', 'agent_browser_tab_new');
  await f.call('b', 'agent_browser_tab_switch', { tab: 't1' });
  await assert.rejects(f.call('a', 'agent_browser_tab_close', { tab: 't1' }), /using that tab/);
  await f.call('a', 'agent_browser_close');
  assert.equal(f.commands.filter(c => c.op === 'close').length, 1);
});

test('a default-profile turn cannot follow a person profile switch', async () => {
  const f = fixture(); await f.call('a', 'agent_browser_tab_new');
  f.report('client'); const count = f.commands.length;
  await assert.rejects(f.call('a', 'agent_browser_tab_new'), /profile changed/);
  assert.equal(f.commands.length, count);
});

test('server loss releases all holders and cancels pending calls', async () => {
  const f = fixture(); await f.call('a', 'agent_browser_tab_new');
  f.browser.releaseAll(); assert.deepEqual(f.states.at(-1).tabs, {});
  await f.call('b', 'agent_browser_tab_new');
  const waiting = fixture(false);
  const pending = waiting.call('a', 'agent_browser_tab_new');
  const failure = assert.rejects(pending, /turn ended/);
  await new Promise(resolve => setTimeout(resolve, 10));
  waiting.browser.releaseAll(); waiting.report(); await failure;
  assert.equal(waiting.commands.length, 0);
});

test('renderer teardown during publish cannot throw out of browser cleanup', async () => {
  let browser, tabs = [];
  browser = createSharedBrowser({contentsFromId:()=>null,notify:()=>{throw new Error('renderer destroyed');},host:{available:()=>true,reveal:()=>{},command:c=>{tabs.push({id:c.tabId,url:c.url});browser.reportTabs({profileId:'personal',selected:true,mounted:true,tabs,active:c.tabId});return true;}}});
  browser.reportTabs({profileId:'personal',selected:true,mounted:true,tabs,active:''});
  await browser.rpc('bot','a','tools/call',{name:'agent_browser_tab_new'});
  assert.doesNotThrow(()=>browser.releaseAll());
});

function fakeGuest(id, url = 'https://example.com/') {
  const guest = Object.assign(new EventEmitter(), { id, sent: [], isDestroyed: () => false, isCrashed: () => false, isLoading: () => false, getURL: () => url, getTitle: () => 'page', setBackgroundThrottling() {}, getZoomFactor: () => 1 });
  guest.debugger = Object.assign(new EventEmitter(), { attached: false, isAttached() { return this.attached; }, attach() { this.attached = true; }, detach() { this.attached = false; }, async sendCommand(method) { guest.sent.push(method); return {}; } });
  return guest;
}

function guestFixture() {
  let browser, tabs = [{ id: 'mine', url: 'https://chatgpt.com/', guestId: 1 }], active = 'mine', next = 2; const commands = [], guests = new Map([[1, fakeGuest(1, 'https://chatgpt.com/')]]); let states = [];
  const report = () => browser.reportTabs({ profileId: 'personal', selected: true, mounted: true, tabs, active });
  browser = createSharedBrowser({ contentsFromId: id => guests.get(id) ?? null, host: { available: () => true, reveal: () => {}, command: command => {
    commands.push(command);
    if (command.op === 'new') { const id = next++; guests.set(id, fakeGuest(id, command.url)); tabs.push({ id: command.tabId, url: command.url, guestId: id }); if (!command.background) active = command.tabId; }
    if (command.op === 'activate') active = command.tabId;
    report(); return true;
  } }, notify: state => states.push(state) });
  report();
  return { browser, commands, guests, get active() { return active; }, get state() { return states.at(-1); }, call: (name, args = {}) => browser.rpc('bot', 'a', 'tools/call', { name, arguments: args }, Date.now() + 2000, {}) };
}

test('the bot opens its own background tab and never takes the screen', async () => {
  const f = guestFixture();
  await f.call('agent_browser_open', { url: 'https://example.com' });
  const opened = f.commands.find(c => c.op === 'new');
  assert.equal(opened.background, true); assert.equal(f.active, 'mine');
  assert.equal(f.commands.some(c => c.op === 'activate' || (c.op === 'navigate' && c.tabId === 'mine')), false);
  assert.equal(f.state.tabs[opened.tabId].own, true);
  await f.call('agent_browser_tab_new'); await f.call('agent_browser_tab_switch', { tab: 't1' });
  assert.equal(f.commands.some(c => c.op === 'activate'), false); assert.equal(f.active, 'mine');
});

test('keys in the bot tab are dropped, not a takeover; the person still wins in a borrowed tab', async () => {
  const f = guestFixture();
  await f.call('agent_browser_open', { url: 'https://example.com' });
  const own = f.guests.get(2); let blocked = false;
  own.emit('before-input-event', { preventDefault: () => { blocked = true; } }, { type: 'keyDown' });
  own.emit('input-event', {}, { type: 'mouseDown' });
  assert.equal(blocked, true);
  assert.match((await f.call('agent_browser_get_url')).content[0].text, /example\.com/);
  await f.call('agent_browser_close');
  await f.call('agent_browser_get_url');
  assert.equal(f.state.tabs.mine.own, false);
  f.guests.get(1).emit('input-event', {}, { type: 'mouseDown' });
  await assert.rejects(f.call('agent_browser_get_url'), /took over/);
});

test('a reveal and the tabs it holds name the bot conversation', async () => {
  let browser, tabs = []; const reveals = [], states = [];
  const report = () => browser.reportTabs({ profileId: 'personal', selected: true, mounted: true, tabs, active: tabs.at(-1)?.id ?? '' });
  browser = createSharedBrowser({ contentsFromId: () => null, notify: state => states.push(state), host: {
    available: () => true,
    reveal: origin => { reveals.push(origin); setTimeout(report, 5); },
    command: command => { if (command.op === 'new') tabs.push({ id: command.tabId, url: command.url }); report(); return true; },
  } });
  await browser.rpc('bot-1', 'thread-9', 'tools/call', { name: 'agent_browser_tab_new', arguments: {} }, Date.now() + 2000, {});
  assert.deepEqual(reveals, [{ botId: 'bot-1', threadId: 'thread-9' }]);
  const held = Object.values(states.at(-1).tabs);
  assert.equal(held.length, 1);
  assert.equal(held[0].botId, 'bot-1'); assert.equal(held[0].threadId, 'thread-9'); assert.equal(held[0].mode, 'bot');
});

test('full access rides each call to the browser authorizer and the tab holder', async () => {
  let browser, tabs = [], active = ''; const asks = [];
  const report = () => browser.reportTabs({ profileId: 'personal', selected: true, mounted: true, tabs, active });
  browser = createSharedBrowser({ contentsFromId: () => null, host: {
    available: () => true, reveal: () => {}, authorize: async input => { asks.push(input.fullAccess); },
    command: command => { if (command.op === 'new') { tabs.push({ id: command.tabId, url: command.url }); active = command.tabId; } report(); return true; },
  }, notify: () => {} });
  report();
  const call = fullAccess => browser.rpc('bot', 'a', 'tools/call', { name: 'agent_browser_tab_new', arguments: {} }, Date.now() + 2000, { generation: 'g', fullAccess });
  await call(true); await call(false);
  assert.deepEqual(asks, [true, false], 'a downgrade mid-turn applies on the next call');
});
