/** The browser's page tabs, as the workbench strip draws them. The browser
 * (PrimaryBrowser) owns its tabs and publishes them here; the strip sends
 * commands back. Only the selected profile publishes and listens, so the
 * strip always shows the profile on screen. */
import { useSyncExternalStore } from "react";

export interface StripBrowserTab {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  loading?: boolean;
  pinned?: boolean;
  /** Who holds the tab when the bot is using it. */
  agent?: "bot" | "person";
}

export interface StripBrowserState {
  tabs: StripBrowserTab[];
  active: string;
}

export type BrowserTabCommand =
  | { op: "new"; url?: string; after?: string; background?: boolean; reuseBlank?: boolean }
  | { op: "activate" | "close" | "reload" | "duplicate" | "copy-url" | "external" | "close-others" | "close-right"; id: string };

const EMPTY: StripBrowserState = { tabs: [], active: "" };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
let handler: ((command: BrowserTabCommand) => void) | null = null;
let queued: BrowserTabCommand[] = [];

export function publishBrowserTabs(next: StripBrowserState | null): void {
  snapshot = next ?? EMPTY;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useBrowserTabs(): StripBrowserState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function browserTabsSnapshot(): StripBrowserState {
  return snapshot;
}

/** Commands sent before the browser has loaded its tabs wait for it. */
export function sendBrowserCommand(command: BrowserTabCommand): void {
  if (handler) handler(command);
  else queued = [...queued, command].slice(-8);
}

export function handleBrowserCommands(next: (command: BrowserTabCommand) => void): () => void {
  handler = next;
  const pending = queued;
  queued = [];
  for (const command of pending) next(command);
  return () => { if (handler === next) handler = null; };
}
