// Chrome SNSS session metadata only. Never restore serialized page/form state.
// Format references: chromium components/sessions/core/{session_service_commands,
// base_session_service_commands,serialized_navigation_entry}.cc
import fs from 'node:fs';
import path from 'node:path';
export function parseChromeTabs(buffer) {
  if (buffer.length < 8 || buffer.length > 32 * 1024 * 1024 || buffer.toString('ascii',0,4) !== 'SNSS' || ![1,3].includes(buffer.readInt32LE(4))) throw new Error('Unsupported chrome session format');
  const tabs = new Map(), closedWindows = new Set();
  const get = id => { if (!tabs.has(id)) tabs.set(id,{ id, window: 0, order: id, selected: null, pinned: false, navs: new Map() }); return tabs.get(id); };
  for (let at = 8; at + 3 <= buffer.length;) {
    const size = buffer.readUInt16LE(at); at += 2; if (size < 1 || at + size > buffer.length) throw new Error('Chrome session is incomplete');
    const command = buffer[at], data = buffer.subarray(at+1,at+size); at += size;
    try {
      if (command === 6) {
        // SessionCommand stores the complete Pickle, including its 4-byte size header.
        let pos = 4; const int = () => { const n = data.readInt32LE(pos); pos += 4; return n; };
        const string = wide => { const length = int(); const bytes = length * (wide ? 2 : 1); if (length < 0 || bytes > 65536 || pos + bytes > data.length) throw new Error(); const s = data.toString(wide ? 'utf16le' : 'utf8',pos,pos+bytes); pos += (bytes+3)&~3; return s; };
        const id = int(), index = int(), url = string(false), title = string(true); const t = get(id); t.navs.set(index,{url,title});
      } else if (command === 0 && data.length >= 8) { get(data.readInt32LE(0)).window = data.readInt32LE(4); }
      else if (command === 2 && data.length >= 8) { get(data.readInt32LE(0)).order = data.readInt32LE(4); }
      else if (command === 7 && data.length >= 8) { get(data.readInt32LE(0)).selected = data.readInt32LE(4); }
      else if (command === 12 && data.length >= 5) { get(data.readInt32LE(0)).pinned = data[4] !== 0; }
      else if (command === 16 && data.length >= 4) { tabs.delete(data.readInt32LE(0)); }
      else if (command === 17 && data.length >= 4) { closedWindows.add(data.readInt32LE(0)); }
      else if ([5,11,24].includes(command)) throw new Error('Navigation pruning is unsupported');
    } catch { throw new Error('Chrome session could not be interpreted safely'); }
  }
  return [...tabs.values()].filter(t=>!closedWindows.has(t.window)).sort((a,b)=>a.window-b.window||a.order-b.order).flatMap(t=>{const nav=t.navs.get(t.selected)??t.navs.get(Math.max(...t.navs.keys()));return nav?[{...nav,pinned:t.pinned}]:[];}).slice(0,100);
}
export function readChromeTabs(directory) {
  const sessions = path.join(directory,'Sessions'); if (!fs.existsSync(sessions)) return { tabs: [], tabsError: 'No saved chrome session available.' };
  const files = fs.readdirSync(sessions).filter(f=>/^Session_\d+$/.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).reverse();
  if (!files.length) return { tabs: [], tabsError: 'No saved chrome session available.' };
  try { const file=path.join(sessions,files[0]); if(fs.statSync(file).size>32*1024*1024) throw new Error();return {tabs:parseChromeTabs(fs.readFileSync(file)),tabsError:''}; }
  catch { return {tabs:[],tabsError:'Open tabs could not be read from this chrome version. Bookmark all tabs in chrome first, then import those bookmarks.'}; }
}
