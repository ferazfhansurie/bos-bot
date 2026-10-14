import assert from 'node:assert/strict';
import test from 'node:test';
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
