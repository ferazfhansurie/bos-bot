import {describe,it,expect} from 'vitest';
import {emptyWorkspace,openTab,replaceTab,sanitizeWorkspace,closeTab,moveTab,rightVisible,bottomVisible} from './thread-workspace';
describe('conversation workbench persistence and transitions',()=>{
 it('restores every real kind while rejecting side chats with no thread and unsafe file paths',()=>{
  const restored=sanitizeWorkspace({layout:'split',tabs:[{id:'file',kind:'files',path:'../private'},{id:'side',kind:'sidechat',ref:'thread-1',title:'Side chat'},{id:'orphan',kind:'sidechat'},{id:'page',kind:'page',ref:'page-1',title:'Draft'},{id:'new',kind:'newtab'}],active:{right:'page'}});
  expect(restored.tabs.map(tab=>tab.kind)).toEqual(['files','sidechat','page','newtab']);
  expect(restored.tabs[0].path).toBeUndefined();
  expect(restored.tabs[1].ref).toBe('thread-1');expect(restored.active.right).toBe('page');
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
});
