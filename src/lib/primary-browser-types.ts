export type BrowserTab = { id: string; title: string; url: string; pinned?: boolean };
export type BrowserEntry = { id: string; title: string; url: string; folder?: string; visitedAt?: number };
export type BrowserLibrary = {
  /** true: bots with Full access still get the per-site prompts. */
  agentAskFullAccess?: boolean;
  agentRules?: Record<string, {browse: 'allow' | 'ask' | 'block'; download: 'allow' | 'ask' | 'block'; upload: 'allow' | 'ask' | 'block'}>;
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
  action(action: 'passwords', input: Record<string, unknown>): Promise<{ id: string; origin: string; username: string; botSignIn: boolean }[]>;
  action(action: string, input?: Record<string, unknown>): Promise<unknown>;
  /** A bot's reveal names its conversation; only that thread opens the pane. */
  onExternalURL(cb: (value: { profileId: string; url: string; reveal?: boolean; botId?: string; threadId?: string }) => void): () => void;
  /** Tabs the bot holds: 'bot' while it drives, 'user' after the person took over. */
  onAgentState(cb: (state: BrowserAgentState) => void): () => void;
  /** Main asks the renderer to open, show, navigate or close a tab for the bot. */
  onAgentCommand(cb: (command: BrowserAgentCommand) => void): () => void;
  onShortcut(cb: (input: { command?: string; key: string; shift: boolean; partition: string }) => void): () => void;
}

export type BrowserAgentState = { tabs: Record<string, { mode: 'bot' | 'user'; busy: boolean; own?: boolean; botId?: string; threadId?: string; cursor: { x: number; y: number; at: number } | null }> };
export type BrowserAgentCommand = { op: 'new' | 'activate' | 'navigate' | 'close'; profileId: string; tabId: string; url?: string; background?: boolean };
