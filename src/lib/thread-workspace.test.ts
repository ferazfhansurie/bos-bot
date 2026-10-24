import {describe,it,expect} from 'vitest';
import {emptyWorkspace,openTab,replaceTab,sanitizeWorkspace,closeTab,moveTab,rightVisible,bottomVisible,showPage} from './thread-workspace';
describe('conversation workbench persistence and transitions',()=>{
 it('restores every real kind while rejecting side chats with no thread and unsafe file paths',()=>{
  const restored=sanitizeWorkspace({layout:'split',tabs:[{id:'file',kind:'files',path:'../private'},{id:'side',kind:'sidechat',ref:'thread-1',title:'Side chat'},{id:'orphan',kind:'sidechat'},{id:'page',kind:'page',ref:'page-1',title:'Draft'},{id:'new',kind:'newtab'}],active:{right:'page'}});
  expect(restored.tabs.map(tab=>tab.kind)).toEqual(['files','sidechat','page','newtab']);
  expect(restored.tabs[0].path).toBeUndefined();
  expect(restored.tabs[1].ref).toBe('thread-1');expect(restored.active.right).toBe('page');
 });
 it('keeps a blank tab\'s page path and source chat across reloads',()=>{
  const restored=sanitizeWorkspace({layout:'split',tabs:[{id:'c1',kind:'canvas',ref:'bos-pages/deck.html',title:'Deck'},{id:'c2',kind:'canvas',ref:'bos-pages/x.html',from:'thread-2'},{id:'c3',kind:'canvas',ref:'../etc/passwd',from:'thread-3'},{id:'c4',kind:'canvas',ref:'a.html',from:'bad thread/id'}],active:{right:'c1'}});
  expect(restored.tabs.map(tab=>[tab.ref,tab.from])).toEqual([['bos-pages/deck.html',undefined],['bos-pages/x.html','thread-2'],[undefined,undefined],['a.html',undefined]]);
  const opened=openTab(emptyWorkspace(),'canvas',{ref:'bos-pages/x.html',from:'thread-2'});
  expect(opened.state.tabs[0].from).toBe('thread-2');
  const swapped=replaceTab(openTab(emptyWorkspace(),'newtab',{id:'n'}).state,'n','canvas',{ref:'bos-pages/y.html',from:'thread-9'});
  expect(swapped.state.tabs[0]).toMatchObject({kind:'canvas',ref:'bos-pages/y.html',from:'thread-9'});
 });
 it('replaces a tools tab in place and reuses an existing files tab',()=>{
  const first=openTab(emptyWorkspace(),'files',{id:'files'});
  const second=openTab(first.state,'newtab',{id:'new'});
  const replaced=replaceTab(second.state,'new','files',{path:'notes.md'});
  expect(replaced.id).toBe('files');expect(replaced.state.tabs).toHaveLength(1);
  expect(replaced.state.tabs[0].path).toBe('notes.md');expect(rightVisible(replaced.state)).toBe(true);
 });
 it('keeps unrelated tools when moving and closing one terminal',()=>{
  let state=openTab(emptyWorkspace(),'files',{id:'files'}).state;
  state=openTab(state,'terminal',{id:'term',pane:'right'}).state;
  state=moveTab(state,'term','bottom');expect(bottomVisible(state)).toBe(true);expect(rightVisible(state)).toBe(true);
  state=closeTab(state,'term').state;expect(bottomVisible(state)).toBe(false);expect(state.tabs.map(t=>t.id)).toEqual(['files']);
 });
 it('shows a page the bot opened: same tab, else the blank or new tab on screen, else a fresh one',()=>{
  const blank=openTab(emptyWorkspace(),'canvas',{id:'blank'}).state;
  const filled=showPage(blank,'bos-pages/a.html','deck');
  expect(filled.id).toBe('blank');expect(filled.state.tabs).toEqual([{id:'blank',kind:'canvas',pane:'right',ref:'bos-pages/a.html',title:'deck'}]);
  expect(showPage(filled.state,'bos-pages/a.html').id).toBe('blank');
  const fresh=showPage(filled.state,'bos-pages/b.html');
  expect(fresh.id).not.toBe('blank');expect(fresh.state.active.right).toBe(fresh.id);
  const fromNew=showPage(openTab(emptyWorkspace(),'newtab',{id:'new'}).state,'bos-pages/c.html','dash');
  expect(fromNew.state.tabs.map(t=>[t.kind,t.ref])).toEqual([['canvas','bos-pages/c.html']]);
  const hidden=showPage({...emptyWorkspace(),layout:'hidden'},'bos-pages/d.html');
  expect(hidden.state.layout).toBe('split');
 });
});
