import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({useStore:()=>({state:{activeView:'bots'},dispatch:vi.fn()}),api:vi.fn(),formatTime:String}));
vi.mock('@/lib/thread-preferences',()=>({useShowThreads:()=>false}));
import { SharedContactsSidebar } from './SharedContactsSidebar';
it('keeps an older pinned bot above newer chats, and unpin restores recency',()=>{
 const rows=[{id:'older',at:1,pinned:true,element:'OLDER_PINNED'},{id:'newer',at:50,element:'NEWER_CHAT'}];
 const render=(localRows: typeof rows)=>renderToStaticMarkup(createElement(SharedContactsSidebar,{placement:'unified',localRows}));
 let html=render(rows);
 expect(html.indexOf('OLDER_PINNED')).toBeLessThan(html.indexOf('NEWER_CHAT'));
 html=render(rows.map(row=>({...row,pinned:false})));
 expect(html.indexOf('NEWER_CHAT')).toBeLessThan(html.indexOf('OLDER_PINNED'));
});
