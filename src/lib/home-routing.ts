// Bots on another BOS server ("homes", server/homes.ts) sit in the same
// roster as this computer's. The UI keeps calling `/api/bots/<id>/…` and
// `/api/threads/<id>/…`; this module sends those calls to the bot's own
// server through /api/homes/<home>/proxy, so every screen works unchanged.

export interface HomeLink {
  id: string;
  name: string;
  /** False while that server's event stream is down: its bots sleep. */
  online: boolean;
}

export interface LinkedHome {
  id: string;
  name: string;
  origin: string;
  /** Unknown until its first snapshot or stream answers. */
  online?: boolean;
}

interface RoutableBot {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
  homeLink?: HomeLink;
}

export const homeProxyPath = (homeId: string, path: string) => `/api/homes/${encodeURIComponent(homeId)}/proxy${path}`;

/** The home a local API path belongs to, or null for this computer. */
export function homeForRequest(path: string, method: string, bots: RoutableBot[], selectedId?: string): string | null {
  if (!path.startsWith("/api/") || path.startsWith("/api/homes")) return null;
  const pathname = path.split(/[?#]/)[0];
  const bot = /^\/api\/bots\/([^/]+)(?:\/|$)/.exec(pathname);
  if (bot) return bots.find((candidate) => candidate.id === decodeURIComponent(bot[1]))?.homeLink?.id ?? null;
  const thread = /^\/api\/threads\/([^/]+)(?:\/|$)/.exec(pathname);
  if (thread) {
    const id = decodeURIComponent(thread[1]);
    return bots.find((candidate) => candidate.homeLink && (candidate.threadId === id || candidate.tasks?.some((task) => task.threadId === id)))?.homeLink?.id ?? null;
  }
  // A file dropped into a home bot's composer must land on that home, or the
  // message it rides on would point at a file the other server never saw.
  if (pathname === "/api/attachments" && method.toUpperCase() === "POST" && selectedId) {
    return bots.find((candidate) => candidate.id === selectedId)?.homeLink?.id ?? null;
  }
  return null;
}

let installed = false;

/** Patch window.fetch once. `route` answers for the live state each call. */
export function installHomeFetch(route: (path: string, method: string) => string | null): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : null;
    if (raw === null || !raw.startsWith("/api/")) return original(input, init);
    const home = route(raw, init?.method ?? "GET");
    return original(home ? homeProxyPath(home, raw) : raw, init);
  };
}

/** The small label beside a linked server's bot: where it lives, and
 * whether that server is reachable right now. */
export function homeLinkHint(bot: { homeLink?: HomeLink }): string | null {
  if (!bot.homeLink) return null;
  return bot.homeLink.online ? bot.homeLink.name : `${bot.homeLink.name} · asleep`;
}

/** The owner connection has settings and the original history. A peer relay
 * of that same bot is useful to phone clients, but is not a second desktop
 * entry. Match the home and exact canonical id, never display names. */
export function dedupeHomeBots<T extends { id: string; homeLink?: HomeLink; remote?: { homeId: string } }>(bots: T[]): T[] {
  const owned = bots.filter(bot => bot.homeLink && !bot.remote);
  return bots.filter(bot => !bot.remote || !owned.some(owner =>
    owner.homeLink!.id === bot.remote!.homeId && bot.id.endsWith('-' + owner.id)));
}
