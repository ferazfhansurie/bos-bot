export type BrowserTab = { id: string; title: string; url: string; pinned?: boolean };
export type BrowserEntry = { id: string; title: string; url: string; folder?: string; visitedAt?: number };
export type BrowserLibrary = {
  blocker?: {enabled:boolean;site:string;siteEnabled:boolean;blocked:number;disabledSites:string[]};
  partition: string; tabs: BrowserTab[]; active: string;
  bookmarks: BrowserEntry[]; history: BrowserEntry[];
  downloads: import('@/types/ogb').ToolsBrowserDownload[];
  permissions: Record<string, boolean>;
  imports: { id: string; source: string; at: number; added: { bookmarks: string[]; history: string[]; tabs?: string[] } }[];
};
export type BrowserProfile = { id: string; name: string };
export type ChromePreview = { token: string; source: string; bookmarks: number; history: number; historyError: string; tabs: number; tabsError: string; cookies: number; cookiesError: string };
export interface PrimaryBrowserBridge {
  action(action: 'profiles', input?: Record<string, unknown>): Promise<{ profiles: BrowserProfile[]; selected: string }>;
  action(action: 'create', input: Record<string, unknown>): Promise<BrowserProfile>;
  action(action: 'read', input: Record<string, unknown>): Promise<BrowserLibrary>;
  action(action: 'chrome-profiles', input?: Record<string, unknown>): Promise<BrowserProfile[]>;
  action(action: 'preview-chrome', input: Record<string, unknown>): Promise<ChromePreview>;
  action(action: 'passwords', input: Record<string, unknown>): Promise<{ id: string; origin: string; username: string }[]>;
  action(action: string, input?: Record<string, unknown>): Promise<unknown>;
  onExternalURL(cb: (value: { profileId: string; url: string }) => void): () => void;
  onSharedState(cb: (state: { guestId: number; shared: boolean; botId?: string; threadId?: string }) => void): () => void;
  onShortcut(cb: (input: { command?: string; key: string; shift: boolean; partition: string }) => void): () => void;
}
