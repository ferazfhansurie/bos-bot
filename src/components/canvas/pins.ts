// Pages pinned to the new tab's Tools list, so a dashboard or deck bos made
// is one click from any new tab of the same bot. Kept on this device, like
// the library layout. A pin remembers the conversation whose folder holds
// the page, so it opens from a different chat too.
import { useEffect, useState } from "react";

export interface PinnedPage { botId: string; threadId: string; path: string; title: string }

const KEY = "bos.newtab.pins";
const EVENT = "bos:newtab-pins";
const MAX = 24;

function store(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

const valid = (p: unknown): p is PinnedPage => {
  const v = p as PinnedPage | null;
  return Boolean(v && typeof v.botId === "string" && typeof v.threadId === "string" && typeof v.path === "string" && v.path && typeof v.title === "string");
};

export function readPins(): PinnedPage[] {
  try {
    const raw = JSON.parse(store()?.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter(valid).slice(0, MAX) : [];
  } catch { return []; }
}

function writePins(pins: PinnedPage[]) {
  try { store()?.setItem(KEY, JSON.stringify(pins.slice(0, MAX))); } catch { /* storage full or off: the pin just doesn't stick */ }
  globalThis.window?.dispatchEvent(new Event(EVENT));
}

type PageKey = Pick<PinnedPage, "botId" | "threadId" | "path">;
// two chats can each have a bos-pages/deck.html, so the chat is part of a page's identity
const same = (a: PageKey, b: PageKey) => a.botId === b.botId && a.threadId === b.threadId && a.path === b.path;

export const isPinned = (pins: readonly PinnedPage[], page: PageKey) => pins.some(p => same(p, page));

/** Pin (newest last, so the list keeps the order you added them in) or
 * refresh an existing pin's title. */
export function pinPage(page: PinnedPage) {
  const pins = readPins();
  const at = pins.findIndex(p => same(p, page));
  if (at >= 0) pins[at] = { ...pins[at]!, title: page.title };
  else pins.push(page);
  writePins(pins);
}

export function unpinPage(page: PageKey) {
  writePins(readPins().filter(p => !same(p, page)));
}

/** This bot's pins, live across tabs and windows. */
export function usePins(botId: string | undefined): PinnedPage[] {
  const [pins, setPins] = useState(readPins);
  useEffect(() => {
    const sync = () => setPins(readPins());
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) sync(); };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", onStorage); };
  }, []);
  return botId ? pins.filter(p => p.botId === botId) : [];
}
