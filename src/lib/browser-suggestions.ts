import type { BrowserEntry } from './primary-browser-types';

/** Only ordinary pages belong in navigation suggestions, never login hand-offs. */
export function suggestiblePage(entry: BrowserEntry) {
  try {
    const url = new URL(entry.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (/^(auth|accounts|login|id)\./i.test(url.hostname) || /\/(oauth2?|authorize|authorization|callback|login|signin|sso|mfa(?:-challenge)?|setcst|sorry)(\/|$)/i.test(url.pathname)) return null;
    if (url.pathname.length > 200 || url.hash.length > 80) return null;
    if ([...url.searchParams.keys()].some(key => !['v', 'q', 'search_query', 'page', 'list', 't'].includes(key.toLowerCase()))) return null;
    const display = url.host.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname);
    const title = /^https?:\/\//i.test(entry.title) ? display : entry.title.replace(/[\r\n\t]/g, ' ').slice(0, 100);
    return { ...entry, title: title || url.hostname, display, host: url.hostname.replace(/^www\./, '') };
  } catch { return null; }
}

export function browserSuggestions(entries: BrowserEntry[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    const page = suggestiblePage(entry);
    if (!page || seen.has(page.url) || !`${page.title} ${page.display}`.toLowerCase().includes(needle)) return [];
    seen.add(page.url); return [page];
  }).slice(0, 6);
}

export function browserStartSites(bookmarks: BrowserEntry[], history: BrowserEntry[]) {
  if (bookmarks.length) return bookmarks.slice(0, 11);
  const hosts = new Map<string, BrowserEntry>();
  for (const entry of history) {
    const page = suggestiblePage(entry);
    if (page && !hosts.has(page.host)) hosts.set(page.host, { ...entry, url: new URL(entry.url).origin, title: siteName(page.host) });
    if (hosts.size === 7) break;
  }
  return [...hosts.values()];
}
export function siteName(host: string) {
  const names: Record<string, string> = {'youtube.com':'YouTube','mail.google.com':'Gmail','github.com':'GitHub','chatgpt.com':'ChatGPT','google.com':'Google','notion.so':'Notion','notion.com':'Notion','figma.com':'Figma','linkedin.com':'LinkedIn','x.com':'X'};
  return names[host] || host.split('.')[0].replace(/^./, c=>c.toUpperCase());
}
