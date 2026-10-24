/** One workspace per thread: the tools open beside a conversation (browser,
 * terminals, files, changes), which panel each sits in, and how much room
 * the panels take. Pure state, remembered per thread in localStorage, so a
 * reload or a trip to another thread comes back to the same desk. */

/** newtab: the tools list a fresh tab shows when this computer has no
 * browser. sidechat: a second thread of the same bot shown in a tab. page: a
 * document tab, rendered by whatever registered the "page" kind (see
 * src/components/workbench/registry.ts). video: a video editing timeline,
 * registered by src/components/videos. */
export type WorkspaceTabKind = "browser" | "terminal" | "files" | "changes" | "bot-browser" | "newtab" | "sidechat" | "page" | "video" | "canvas";
export type WorkspacePane = "right" | "bottom";
/** hidden: chat only. split: chat beside the right panel. full: the right panel covers the chat. */
export type WorkspaceLayout = "hidden" | "split" | "full";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  pane: WorkspacePane;
  /** Files tab: the file shown in its viewer, relative to the working folder. */
  path?: string;
  /** Side chat: the thread it shows. Page: the page id its renderer owns. */
  ref?: string;
  /** A title the tab's renderer chose (a page's name, a side chat's topic). */
  title?: string;
  /** Blank tab: the conversation whose folder holds the page, when it is not
   * this one (a page pinned to new tabs, opened from another chat). */
  from?: string;
}

export interface ThreadWorkspace {
  tabs: WorkspaceTab[];
  active: Partial<Record<WorkspacePane, string>>;
  layout: WorkspaceLayout;
  bottomOpen: boolean;
}

const KEY_PREFIX = "bos.thread-workspace.v2:";
const KINDS: readonly WorkspaceTabKind[] = ["browser", "terminal", "files", "changes", "bot-browser", "newtab", "sidechat", "page", "video", "canvas"];
/** Kinds that exist at most once per thread; opening one again focuses it. */
const SINGLE: ReadonlySet<WorkspaceTabKind> = new Set(["browser", "files", "changes", "bot-browser"]);
const MAX_TABS = 16;
const MAX_TERMINALS = 6;
export const LAYOUT_CYCLE: readonly WorkspaceLayout[] = ["split", "full", "hidden"];

export const TAB_LABEL: Record<WorkspaceTabKind, string> = {
  browser: "browser", terminal: "terminal", files: "files", changes: "changes", "bot-browser": "browser",
  newtab: "New tab", sidechat: "Side chat", page: "Untitled page", video: "Video", canvas: "Blank tab",
};

/** Tab kinds that can move into a window of their own. The browser is a
 * native view owned by the main window, so it stays put. */
export const DETACHABLE: ReadonlySet<WorkspaceTabKind> = new Set(["terminal", "files", "changes"]);

export function emptyWorkspace(): ThreadWorkspace {
  return { tabs: [], active: {}, layout: "hidden", bottomOpen: false };
}

export function workspaceKey(botId: string, threadId: string): string {
  return `${botId}:${threadId}`;
}

export function newTabId(kind: WorkspaceTabKind): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${kind === "bot-browser" ? "bot" : kind}-${random}`;
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0") || value.startsWith("/")) return undefined;
  return value.split("/").includes("..") ? undefined : value;
}

const threadRef = (value: unknown) => (typeof value === "string" && /^[\w:.-]{1,128}$/.test(value) ? value : undefined);

/** Whatever came out of storage, make it a valid workspace or an empty one. */
export function sanitizeWorkspace(value: unknown): ThreadWorkspace {
  if (!value || typeof value !== "object") return emptyWorkspace();
  const raw = value as Record<string, unknown>;
  const seen = new Set<string>(), single = new Set<WorkspaceTabKind>();
  const tabs: WorkspaceTab[] = [];
  for (const item of Array.isArray(raw.tabs) ? raw.tabs : []) {
    if (!item || typeof item !== "object") continue;
    const tab = item as Record<string, unknown>;
    const kind = KINDS.find((k) => k === tab.kind);
    if (!kind || typeof tab.id !== "string" || !/^[\w-]{1,64}$/.test(tab.id) || seen.has(tab.id)) continue;
    if (SINGLE.has(kind)) { if (single.has(kind)) continue; single.add(kind); }
    seen.add(tab.id);
    const pane: WorkspacePane = tab.pane === "bottom" ? "bottom" : "right";
    const path = kind === "files" ? safePath(tab.path) : undefined;
    // a blank tab's ref is the page's path in the working folder
    const ref = kind === "canvas" ? safePath(tab.ref) : typeof tab.ref === "string" && /^[\w:.-]{1,128}$/.test(tab.ref) ? tab.ref : undefined;
    const from = kind === "canvas" && ref ? threadRef(tab.from) : undefined;
    const title = typeof tab.title === "string" && tab.title.trim() ? tab.title.trim().slice(0, 120) : undefined;
    if (kind === "sidechat" && !ref) continue;
    tabs.push({ id: tab.id, kind, pane, ...(path ? { path } : {}), ...(ref ? { ref } : {}), ...(title ? { title } : {}), ...(from ? { from } : {}) });
    if (tabs.length >= MAX_TABS) break;
  }
  const active = (raw.active && typeof raw.active === "object" ? raw.active : {}) as Record<string, unknown>;
  const pick = (pane: WorkspacePane) => {
    const id = active[pane];
    return tabs.find((tab) => tab.id === id && tab.pane === pane)?.id ?? tabs.find((tab) => tab.pane === pane)?.id;
  };
  const layout = raw.layout === "split" || raw.layout === "full" ? raw.layout : "hidden";
  const state: ThreadWorkspace = { tabs, active: { right: pick("right"), bottom: pick("bottom") }, layout, bottomOpen: raw.bottomOpen === true };
  return normalize(state);
}

/** Panels with nothing in them close; a panel that is open always has an active tab. */
function normalize(state: ThreadWorkspace): ThreadWorkspace {
  const has = (pane: WorkspacePane) => state.tabs.some((tab) => tab.pane === pane);
  const activeFor = (pane: WorkspacePane) => {
    const id = state.active[pane];
    return state.tabs.some((tab) => tab.id === id && tab.pane === pane) ? id : state.tabs.find((tab) => tab.pane === pane)?.id;
  };
  return {
    ...state,
    active: { right: activeFor("right"), bottom: activeFor("bottom") },
    layout: has("right") ? state.layout : "hidden",
    bottomOpen: has("bottom") && state.bottomOpen,
  };
}

export function loadWorkspace(key: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): ThreadWorkspace {
  try {
    const raw = storage?.getItem(KEY_PREFIX + key);
    return raw ? sanitizeWorkspace(JSON.parse(raw)) : emptyWorkspace();
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspace(key: string, state: ThreadWorkspace, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (!state.tabs.length) storage?.removeItem(KEY_PREFIX + key);
    else storage?.setItem(KEY_PREFIX + key, JSON.stringify(state));
  } catch {
    // storage full or blocked: the workspace still works for this session
  }
}

/** Show a tab: its panel opens and it becomes that panel's active tab. */
export function focusTab(state: ThreadWorkspace, id: string): ThreadWorkspace {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return state;
  return normalize({
    ...state,
    active: { ...state.active, [tab.pane]: id },
    layout: tab.pane === "right" && state.layout === "hidden" ? "split" : state.layout,
    bottomOpen: tab.pane === "bottom" ? true : state.bottomOpen,
  });
}

export function defaultPane(kind: WorkspaceTabKind): WorkspacePane {
  return kind === "terminal" ? "bottom" : "right";
}

/** Open (or focus, for single-instance kinds) a tab. Returns the tab's id. */
export function openTab(state: ThreadWorkspace, kind: WorkspaceTabKind, options: { pane?: WorkspacePane; path?: string; id?: string; fresh?: boolean; ref?: string; title?: string; from?: string } = {}): { state: ThreadWorkspace; id: string } {
  const existing = SINGLE.has(kind) || (kind === "terminal" && !options.fresh && !options.id)
    ? state.tabs.find((tab) => tab.kind === kind && (!options.pane || tab.pane === options.pane))
    : undefined;
  if (existing) {
    const tabs = options.path !== undefined && existing.kind === "files"
      ? state.tabs.map((tab) => (tab.id === existing.id ? { ...tab, path: safePath(options.path) } : tab))
      : state.tabs;
    return { state: focusTab({ ...state, tabs }, existing.id), id: existing.id };
  }
  if (kind === "terminal" && state.tabs.filter((tab) => tab.kind === "terminal").length >= MAX_TERMINALS) {
    const last = [...state.tabs].reverse().find((tab) => tab.kind === "terminal")!;
    return { state: focusTab(state, last.id), id: last.id };
  }
  const id = options.id && /^[\w-]{1,64}$/.test(options.id) && !state.tabs.some((tab) => tab.id === options.id) ? options.id : newTabId(kind);
  const path = kind === "files" ? safePath(options.path) : undefined;
  const tab: WorkspaceTab = { id, kind, pane: options.pane ?? defaultPane(kind), ...(path ? { path } : {}), ...(options.ref ? { ref: options.ref } : {}), ...(options.title ? { title: options.title.slice(0, 120) } : {}), ...(kind === "canvas" && threadRef(options.from) ? { from: options.from } : {}) };
  const tabs = [...state.tabs, tab].slice(-MAX_TABS);
  return { state: focusTab({ ...state, tabs }, id), id };
}

export function closeTab(state: ThreadWorkspace, id: string): { state: ThreadWorkspace; closed?: WorkspaceTab } {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { state };
  const closed = state.tabs[index]!;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  // the neighbour in the same panel takes over, like closing a browser tab
  const siblings = tabs.filter((tab) => tab.pane === closed.pane);
  const before = state.tabs.slice(0, index).filter((tab) => tab.pane === closed.pane).pop();
  const next = state.active[closed.pane] === id ? (before ?? siblings[0])?.id : state.active[closed.pane];
  return { state: normalize({ ...state, tabs, active: { ...state.active, [closed.pane]: next } }), closed };
}

export function moveTab(state: ThreadWorkspace, id: string, pane: WorkspacePane): ThreadWorkspace {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab || tab.pane === pane) return state;
  const moved = { ...state, tabs: state.tabs.map((candidate) => (candidate.id === id ? { ...candidate, pane } : candidate)) };
  return focusTab(normalize(moved), id);
}

/** A renderer renamed its tab (a page got a title, a side chat a topic). */
export function setTabTitle(state: ThreadWorkspace, id: string, title: string | undefined): ThreadWorkspace {
  const clean = title?.trim().slice(0, 120) || undefined;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title: clean } : tab)) };
}

/** Swap a tab for another kind in the same slot, the way picking a tool on
 * a new tab turns that tab into the tool. */
export function replaceTab(state: ThreadWorkspace, id: string, kind: WorkspaceTabKind, options: { ref?: string; title?: string; path?: string; from?: string } = {}): { state: ThreadWorkspace; id: string } {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || (SINGLE.has(kind) && state.tabs.some((tab) => tab.kind === kind))) {
    const removed = index < 0 ? state : closeTab(state, id).state;
    return openTab(removed, kind, { ...options, pane: state.tabs[index]?.pane });
  }
  const old = state.tabs[index]!;
  const path = kind === "files" ? safePath(options.path) : undefined;
  const tab: WorkspaceTab = { id: newTabId(kind), kind, pane: old.pane, ...(path ? { path } : {}), ...(options.ref ? { ref: options.ref } : {}), ...(options.title ? { title: options.title.slice(0, 120) } : {}), ...(kind === "canvas" && threadRef(options.from) ? { from: options.from } : {}) };
  const tabs = state.tabs.map((candidate, at) => (at === index ? tab : candidate));
  return { state: focusTab({ ...state, tabs, active: { ...state.active, [old.pane]: tab.id } }, tab.id), id: tab.id };
}

export function setFilePath(state: ThreadWorkspace, id: string, path: string | undefined): ThreadWorkspace {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, path: safePath(path) } : tab)) };
}

/** ⌘⇧B: split → full → hidden → split. With no right-panel tab yet the
 * caller opens one first, so hidden → split always shows something. */
export function cycleLayout(state: ThreadWorkspace): ThreadWorkspace {
  if (!state.tabs.some((tab) => tab.pane === "right")) return state;
  const at = LAYOUT_CYCLE.indexOf(state.layout);
  const layout = state.layout === "hidden" ? "split" : LAYOUT_CYCLE[(at + 1) % LAYOUT_CYCLE.length]!;
  return { ...state, layout };
}

/** A page the bot opened (open_tab): the tab already showing it, else the
 * blank or new tab on screen, else a fresh canvas tab on the right. */
export function showPage(state: ThreadWorkspace, ref: string, title?: string): { state: ThreadWorkspace; id: string } {
  const named = (tab: WorkspaceTab) => (title ? { ...tab, title: title.slice(0, 120) } : tab);
  const same = state.tabs.find((tab) => tab.kind === "canvas" && tab.ref === ref);
  if (same) return { state: focusTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === same.id ? named(tab) : tab)) }, same.id), id: same.id };
  const shown = (["right", "bottom"] as const)
    .filter((pane) => (pane === "right" ? state.layout !== "hidden" : state.bottomOpen))
    .map((pane) => state.tabs.find((tab) => tab.id === state.active[pane]))
    .find((tab) => tab && ((tab.kind === "canvas" && !tab.ref) || tab.kind === "newtab"));
  const blank = shown ?? state.tabs.find((tab) => tab.kind === "canvas" && !tab.ref);
  if (blank?.kind === "canvas") {
    return { state: focusTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === blank.id ? named({ ...tab, ref }) : tab)) }, blank.id), id: blank.id };
  }
  if (blank) return replaceTab(state, blank.id, "canvas", { ref, title });
  return openTab(state, "canvas", { pane: "right", ref, title });
}

export function setLayout(state: ThreadWorkspace, layout: WorkspaceLayout): ThreadWorkspace {
  return normalize({ ...state, layout });
}

export function setBottomOpen(state: ThreadWorkspace, open: boolean): ThreadWorkspace {
  return normalize({ ...state, bottomOpen: open });
}

export function rightVisible(state: ThreadWorkspace): boolean {
  return state.layout !== "hidden" && state.tabs.some((tab) => tab.pane === "right");
}

export function bottomVisible(state: ThreadWorkspace): boolean {
  return state.bottomOpen && state.tabs.some((tab) => tab.pane === "bottom");
}
