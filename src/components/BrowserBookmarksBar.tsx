import { type MouseEvent, useLayoutEffect, useRef, useState } from 'react';
import { ChevronsRight, Copy, ExternalLink, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { Menu, anchorOf, pointAnchor, type MenuAnchor, type MenuEntry } from '@/components/workbench/Menu';
import type { TabIcon } from '@/components/workbench/registry';
import { siteName } from '@/lib/browser-suggestions';
import type { BrowserEntry } from '@/lib/primary-browser-types';

// Chrome names its bar root "Bookmarks bar" (older builds "Bookmarks Bar").
// Pages bookmarked in bos have no folder and sit on the bar too.
const BAR_ROOT = /^bookmarks bar$/i;
const FAVICONS_KEY = 'bos.browser.favicons';
export const BOOKMARKS_BAR_KEY = 'bos.browser.bookmarksBar';

type Node = { kind: 'page'; entry: BrowserEntry } | { kind: 'folder'; name: string; path: string; children: Node[] };

function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

let favicons: Record<string, string> | null = null;
function faviconStore() {
  if (favicons) return favicons;
  try { favicons = JSON.parse(localStorage.getItem(FAVICONS_KEY) || '{}') as Record<string, string>; } catch { favicons = {}; }
  return favicons;
}
/** Remembers the icon a page showed, so its bookmark gets the real one. */
export function rememberFavicon(url: string, icon?: string) {
  const host = hostOf(url);
  if (!host || !icon || !/^https:|^data:image\//i.test(icon) || icon.length > 4096) return;
  const store = faviconStore();
  if (store[host] === icon) return;
  delete store[host]; store[host] = icon;
  const hosts = Object.keys(store);
  for (const old of hosts.slice(0, Math.max(0, hosts.length - 400))) delete store[old];
  try { localStorage.setItem(FAVICONS_KEY, JSON.stringify(store)); } catch { /* storage full: icons stay in memory */ }
}

export function Favicon({ url, size = 16 }: { url: string; size?: number }) {
  const host = hostOf(url);
  const sources = [faviconStore()[host], host && `https://${host}/favicon.ico`].filter(Boolean) as string[];
  const [failed, setFailed] = useState(0);
  if (failed < sources.length) return <img src={sources[failed]} alt="" width={size} height={size} className="browser-bookmark-favicon" draggable={false} onError={() => setFailed(n => n + 1)} />;
  const hue = [...host].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);
  return <span className="browser-bookmark-letter" style={{ width: size, height: size, background: `hsl(${hue} 45% 45% / .28)`, color: `hsl(${hue} 70% 72%)` }}>{(siteName(host) || '?').slice(0, 1)}</span>;
}

const iconCache = new Map<string, TabIcon>();
function faviconIcon(url: string): TabIcon {
  const host = hostOf(url);
  let icon = iconCache.get(host);
  if (!icon) { icon = function BookmarkIcon({ size }) { return <Favicon url={url} size={Number(size) || 16} />; }; iconCache.set(host, icon); }
  return icon;
}

/** Folder paths become a tree in the order chrome stored them. */
function tree(entries: BrowserEntry[], depth: number, base: string): Node[] {
  const nodes: Node[] = []; const folders = new Map<string, Extract<Node, { kind: 'folder' }>>();
  for (const entry of entries) {
    const parts = (entry.folder || '').split('/').slice(depth);
    if (!parts.length || !parts[0]) { nodes.push({ kind: 'page', entry }); continue; }
    let folder = folders.get(parts[0]);
    if (!folder) { folder = { kind: 'folder', name: parts[0], path: base ? `${base}/${parts[0]}` : parts[0], children: [] }; folders.set(parts[0], folder); nodes.push(folder); }
    folder.children.push({ kind: 'page', entry });
  }
  for (const node of nodes) if (node.kind === 'folder') node.children = tree(node.children.map(c => (c as Extract<Node, { kind: 'page' }>).entry), depth + 1, node.path);
  return nodes;
}

function title(entry: BrowserEntry) { return entry.title && entry.title !== entry.url ? entry.title : siteName(hostOf(entry.url)) || entry.url; }

export function BrowserBookmarksBar({ bookmarks, onOpen, onOpenTab, onRemove, onShowAll, onImport, onNotice }: {
  bookmarks: BrowserEntry[];
  onOpen: (url: string, event?: MouseEvent<HTMLButtonElement>) => void;
  onOpenTab: (url: string) => void;
  onRemove: (id: string) => void;
  onShowAll: () => void;
  onImport: () => void;
  onNotice: (text: string) => void;
}) {
  const onBar = (b: BrowserEntry) => !b.folder || BAR_ROOT.test(b.folder.split('/')[0]);
  const other = bookmarks.filter(b => !onBar(b));
  // Strip the bar root and build one tree, so pages and folders keep chrome's order.
  const items = tree(bookmarks.filter(onBar).map(b => ({ ...b, folder: (b.folder || '').split('/').slice(1).join('/') })), 0, '');
  const row = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[]; label: string } | null>(null);
  const signature = items.map(n => n.kind === 'page' ? n.entry.id : `f:${n.path}`).join('|');

  useLayoutEffect(() => {
    const el = row.current; if (!el) return;
    const measure = () => {
      const width = el.clientWidth; let count = 0;
      for (const child of el.children) { const item = child as HTMLElement; if (item.offsetLeft + item.offsetWidth > width) break; count++; }
      setFit(count);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, [signature]);

  const entriesFor = (nodes: Node[]): MenuEntry[] => nodes.length ? nodes.map(node => node.kind === 'folder'
    ? { key: `f:${node.path}`, label: node.name, icon: Folder, submenu: entriesFor(node.children) }
    : { key: node.entry.id, label: title(node.entry), icon: faviconIcon(node.entry.url), onSelect: () => onOpen(node.entry.url) })
    : [{ type: 'label', key: 'empty', label: '(empty)' }];
  const pageMenu = (entry: BrowserEntry, anchor: MenuAnchor) => setMenu({ anchor, label: title(entry), entries: [
    { key: 'open-tab', label: 'Open in new tab', icon: ExternalLink, onSelect: () => onOpenTab(entry.url) },
    { key: 'copy', label: 'Copy link', icon: Copy, onSelect: () => { void navigator.clipboard.writeText(entry.url).then(() => onNotice('Link copied.')); } },
    { type: 'separator', key: 'sep' },
    { key: 'remove', label: 'Remove bookmark', icon: Trash2, danger: true, onSelect: () => onRemove(entry.id) },
  ] });
  const hidden = items.slice(fit);

  if (!bookmarks.length) return <div className="browser-bookmarks-bar is-empty">
    <span>For quick access, bookmark pages with ⌘D or the star.</span>
    <button type="button" onClick={onImport}>Import bookmarks from chrome</button>
  </div>;

  return <div className="browser-bookmarks-bar" role="toolbar" aria-label="Bookmarks bar">
    <div ref={row} className="browser-bookmarks-row">
      {items.map((node, index) => node.kind === 'page'
        ? <button key={node.entry.id} type="button" className="browser-bookmark" title={`${title(node.entry)}\n${node.entry.url}`} style={index >= fit ? { visibility: 'hidden' } : undefined} tabIndex={index >= fit ? -1 : undefined}
          onClick={event => onOpen(node.entry.url, event)} onAuxClick={event => { if (event.button === 1) onOpen(node.entry.url, event); }}
          onContextMenu={event => { event.preventDefault(); pageMenu(node.entry, pointAnchor(event.clientX, event.clientY)); }}>
          <Favicon url={node.entry.url} /><span>{title(node.entry)}</span>
        </button>
        : <button key={`f:${node.path}`} type="button" className="browser-bookmark" aria-haspopup="menu" style={index >= fit ? { visibility: 'hidden' } : undefined} tabIndex={index >= fit ? -1 : undefined}
          onClick={event => setMenu({ anchor: anchorOf(event.currentTarget), label: node.name, entries: entriesFor(node.children) })}>
          <Folder size={15} className="shrink-0 opacity-70" /><span>{node.name}</span>
        </button>)}
    </div>
    {hidden.length > 0 && <button type="button" className="browser-bookmark browser-bookmark-more" aria-label={`${hidden.length} more bookmarks`} title="More bookmarks" onClick={event => setMenu({ anchor: anchorOf(event.currentTarget), label: 'More bookmarks', entries: entriesFor(hidden) })}><ChevronsRight size={15} /></button>}
    {other.length > 0 && <><span className="browser-bookmarks-divider" /><button type="button" className="browser-bookmark" aria-haspopup="menu" onClick={event => setMenu({ anchor: anchorOf(event.currentTarget), label: 'All bookmarks', entries: [...entriesFor(tree(other, 0, '')), { type: 'separator', key: 'sep' }, { key: 'manage', label: 'Search all bookmarks', icon: FolderOpen, onSelect: onShowAll }] })}><Folder size={15} className="shrink-0 opacity-70" /><span>All bookmarks</span></button></>}
    {menu && <Menu anchor={menu.anchor} label={menu.label} entries={menu.entries} width={280} onClose={() => setMenu(null)} />}
  </div>;
}
