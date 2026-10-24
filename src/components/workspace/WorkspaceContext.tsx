/** The thread workspace: which tools sit beside the current conversation and
 * where. One provider for the window; it follows the selected conversation
 * (or the pane whose header button was pressed last), keeps every thread's
 * own tabs in localStorage, and owns the workspace shortcuts. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { closeTerminalSession, markTerminalStarted, releaseTerminalSession } from "@/components/workspace/terminal-sessions";
import { browserCommand } from "../../../electron/browser-keybindings.mjs";
import { remoteBotHint } from "@/lib/remote-bot";
import { terminalAvailable, sameTerminalTarget, type TerminalTarget } from "@/lib/terminal";
import {
  DETACHABLE, bottomVisible, closeTab as closeTabState, focusTab as focusTabState, loadWorkspace, moveTab as moveTabState,
  openTab as openTabState, replaceTab as replaceTabState, rightVisible, saveWorkspace, setBottomOpen, setFilePath, setLayout, setTabTitle as setTabTitleState, showPage, workspaceKey,
  type ThreadWorkspace, type WorkspaceLayout, type WorkspacePane, type WorkspaceTab, type WorkspaceTabKind,
} from "@/lib/thread-workspace";
import { sendBrowserCommand } from "@/components/workbench/browser-tabs";
import { WORKSPACE_COMMAND_EVENT, workspaceCommandForEvent, type WorkspaceCommandId } from "@/lib/workspace-commands";
import { locatePath, type WorkspaceChanges, type WorkspaceLocation } from "@/lib/workspace-files-client";
import { api, useStore, type Bot } from "@/state/store";

export interface OpenOptions { pane?: WorkspacePane; path?: string; fresh?: boolean; ref?: string; title?: string }

interface WorkspaceValue {
  available: boolean;
  /** The conversation whose tools are showing; null when it can have none. */
  target: TerminalTarget | null;
  workspace: ThreadWorkspace;
  /** Make a conversation's workspace the visible one (header buttons). */
  show: (target: TerminalTarget) => void;
  openTab: (kind: WorkspaceTabKind, options?: OpenOptions) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  moveTab: (id: string, pane: WorkspacePane) => void;
  detach: (id: string) => void;
  setLayout: (layout: WorkspaceLayout) => void;
  setBottomOpen: (open: boolean) => void;
  setTabPath: (id: string, path: string | undefined) => void;
  setTabTitle: (id: string, title: string | undefined) => void;
  setTabRef: (id: string, ref: string) => void;
  /** Turn a tab into another kind in place (a new tab picking a tool). */
  replaceTab: (id: string, kind: WorkspaceTabKind, options?: { ref?: string; title?: string; path?: string }) => void;
  /** A new thread of the same bot, opened in a side chat tab (or in place of `replacing`). */
  openSideChat: (replacing?: string) => Promise<void>;
  openFile: (path: string, threadId?: string) => Promise<boolean>;
  /** Where a path the bot mentioned sits in its conversation's working folder; null when it is not inside it. */
  locate: (path: string, threadId?: string) => Promise<(WorkspaceLocation & { target: TerminalTarget }) | null>;
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  /** Whether the folder is a git repo, as the last changes fetch found it. */
  git: boolean | undefined;
  noteChanges: (changes: WorkspaceChanges) => void;
  browserAvailable: boolean;
  /** A bot opened the browser for a thread that is not on screen: it stays
   * mounted out of sight so the bot can work without taking over this one. */
  browserInBackground: boolean;
  /** The conversation whose bot drives a browser tab right now, if any. */
  botBrowsing: { botId: string; threadId: string } | null;
}

const noop = () => {};
const WorkspaceContext = createContext<WorkspaceValue>({
  available: false, target: null, workspace: { tabs: [], active: {}, layout: "hidden", bottomOpen: false }, show: noop, openTab: noop, closeTab: noop,
  focusTab: noop, moveTab: noop, detach: noop, setLayout: noop, setBottomOpen: noop, setTabPath: noop, setTabTitle: noop, setTabRef: noop, replaceTab: noop,
  openSideChat: async () => {}, openFile: async () => false, locate: async () => null, quickOpen: false, setQuickOpen: noop,
  git: undefined, noteChanges: noop, browserAvailable: false, browserInBackground: false, botBrowsing: null,
});

export function useWorkspace(): WorkspaceValue {
  return useContext(WorkspaceContext);
}

const isMac = () => /mac/i.test(globalThis.navigator?.platform ?? "") || globalThis.window?.ogb?.platform === "darwin";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const available = terminalAvailable();
  const browserAvailable = Boolean(globalThis.window?.ogb?.primaryBrowser);
  // The selected conversation, when it is one this computer works in.
  const selected = useMemo(() => {
    const group = state.groups.find((candidate) => candidate.id === state.selectedId);
    if (group) return group.dm ? null : { botId: group.id, threadId: group.threadId, name: group.name };
    const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
    if (!bot || remoteBotHint(bot)) return null;
    return { botId: bot.id, threadId: bot.threadId, name: bot.name };
  }, [state.groups, state.bots, state.selectedId]);
  // bots and groups change identity on every update; keep the target stable
  const primary = useMemo<TerminalTarget | null>(
    () => (selected ? { botId: selected.botId, threadId: selected.threadId, name: selected.name } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.botId, selected?.threadId, selected?.name],
  );
  const [override, setOverride] = useState<TerminalTarget | null>(null);
  // a new selection (or thread) takes the workspace back from a side pane
  const primaryKey = primary ? workspaceKey(primary.botId, primary.threadId) : "";
  useEffect(() => setOverride(null), [primaryKey]);
  const target = available ? override ?? primary : null;
  const key = target ? workspaceKey(target.botId, target.threadId) : "";

  const [workspaces, setWorkspaces] = useState<Record<string, ThreadWorkspace>>({});
  const workspace = useMemo(() => (key ? workspaces[key] ?? loadWorkspace(key) : loadWorkspace("")), [key, workspaces]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const closed = useRef<{ key: string; tab: WorkspaceTab }[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [gitByKey, setGitByKey] = useState<Record<string, boolean>>({});

  const update = useCallback((change: (current: ThreadWorkspace) => ThreadWorkspace) => {
    const current = targetRef.current;
    if (!current) return;
    const id = workspaceKey(current.botId, current.threadId);
    setWorkspaces((all) => {
      const next = change(all[id] ?? loadWorkspace(id));
      saveWorkspace(id, next);
      return { ...all, [id]: next };
    });
  }, []);

  const openTab = useCallback((kind: WorkspaceTabKind, options: OpenOptions = {}) => {
    update((current) => {
      const result = openTabState(current, kind, options);
      if (kind === "terminal" && !current.tabs.some((tab) => tab.id === result.id)) markTerminalStarted(result.id);
      return result.state;
    });
  }, [update]);

  const closeTab = useCallback((id: string) => {
    const current = targetRef.current;
    const tab = workspaceRef.current.tabs.find((candidate) => candidate.id === id);
    if (!current || !tab) return;
    if (tab.kind === "terminal") closeTerminalSession(id, current);
    // a closed side chat is archived, so there is nothing to reopen
    else if (tab.kind !== "sidechat") closed.current = [...closed.current, { key: workspaceKey(current.botId, current.threadId), tab }].slice(-20);
    update((state) => closeTabState(state, id).state);
  }, [update]);

  const focusTab = useCallback((id: string) => update((state) => focusTabState(state, id)), [update]);
  const moveTab = useCallback((id: string, pane: WorkspacePane) => update((state) => moveTabState(state, id, pane)), [update]);
  const setLayoutValue = useCallback((layout: WorkspaceLayout) => update((state) => setLayout(state, layout)), [update]);
  const setBottom = useCallback((open: boolean) => update((state) => setBottomOpen(state, open)), [update]);
  const setTabPath = useCallback((id: string, path: string | undefined) => update((state) => setFilePath(state, id, path)), [update]);
  const setTabTitle = useCallback((id: string, title: string | undefined) => update((state) => setTabTitleState(state, id, title)), [update]);
  const setTabRef = useCallback((id: string, ref: string) => update((state) => ({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ref } : tab)) })), [update]);
  const replaceTab = useCallback((id: string, kind: WorkspaceTabKind, options: { ref?: string; title?: string; path?: string } = {}) => {
    update((current) => {
      const result = replaceTabState(current, id, kind, options);
      if (kind === "terminal") markTerminalStarted(result.id);
      return result.state;
    });
  }, [update]);

  // The side chat is a real thread of this bot, created without switching
  // the conversation on screen (activate:false); closing it archives it.
  const openSideChat = useCallback(async (replacing?: string) => {
    const current = targetRef.current;
    if (!current) return;
    const count = workspaceRef.current.tabs.filter((tab) => tab.kind === "sidechat").length;
    const title = count ? `Side chat ${count + 1}` : "Side chat";
    try {
      const { bot, task } = await api<{ bot: Bot; task: { threadId: string } }>(`/api/bots/${current.botId}/tasks`, {
        method: "POST", body: JSON.stringify({ activate: false, title }),
      });
      dispatch({ type: "botPatched", bot });
      if (!sameTerminalTarget(targetRef.current, current)) return;
      if (replacing) replaceTab(replacing, "sidechat", { ref: task.threadId, title });
      else openTab("sidechat", { pane: "right", ref: task.threadId, title });
      update((state) => (state.layout === "hidden" ? setLayout(state, "split") : state));
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [dispatch, openTab, replaceTab, update]);

  const detach = useCallback((id: string) => {
    const current = targetRef.current;
    const tab = workspaceRef.current.tabs.find((candidate) => candidate.id === id);
    const open = window.ogb?.workspaceWindow;
    if (!current || !tab || !DETACHABLE.has(tab.kind) || !open) return;
    // the shell keeps running on the server; the new window reattaches to it
    if (tab.kind === "terminal") releaseTerminalSession(id);
    void open(JSON.stringify({ target: current, tab })).then((ok) => {
      if (ok) update((state) => closeTabState(state, id).state);
    }).catch(() => {});
  }, [update]);

  const show = useCallback((next: TerminalTarget) => {
    // set now so an openTab in the same click lands in this workspace
    if (!sameTerminalTarget(targetRef.current, next)) targetRef.current = next;
    setOverride((current) => (sameTerminalTarget(current, next) ? current : next));
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;
  /** The conversation a thread id belongs to, when this computer works in it. */
  const targetFor = useCallback((threadId?: string): TerminalTarget | null => {
    const current = targetRef.current;
    if (!threadId || threadId === current?.threadId) return current;
    const { bots, groups } = stateRef.current;
    const group = groups.find((candidate) => candidate.threadId === threadId);
    const bot = group ? undefined : bots.find((candidate) => candidate.threadId === threadId || candidate.tasks?.some((task) => task.threadId === threadId));
    return group && !group.dm ? { botId: group.id, threadId, name: group.name }
      : bot && !remoteBotHint(bot) ? { botId: bot.id, threadId, name: bot.name } : null;
  }, []);

  const locate = useCallback(async (path: string, threadId?: string) => {
    const where = targetFor(threadId);
    if (!available || !where) return null;
    try { return { ...(await locatePath(where, path)), target: where }; } catch { return null; }
  }, [available, targetFor]);

  /** A path the bot mentioned: show it in the files tab of the conversation
   * it was mentioned in. False when it is not inside that working folder. */
  const openFile = useCallback(async (path: string, threadId?: string): Promise<boolean> => {
    const location = await locate(path, threadId);
    if (!location) return false;
    const where = location.target;
    if (!sameTerminalTarget(where, targetRef.current)) {
      setOverride(where);
      targetRef.current = where;
    }
    openTab("files", location.kind === "file" ? { path: location.path } : {});
    return true;
  }, [locate, openTab]);

  const noteChanges = useCallback((changes: WorkspaceChanges) => {
    const current = targetRef.current;
    if (!current) return;
    const id = workspaceKey(current.botId, current.threadId);
    setGitByKey((all) => (all[id] === changes.git ? all : { ...all, [id]: changes.git }));
  }, []);
  const git = key ? gitByKey[key] : undefined;

  // ⌘⇧B, ⌃`, ⌘J … as one handler; the same ids run from the palette.
  const run = useCallback((command: WorkspaceCommandId) => {
    const current = workspaceRef.current;
    const visible = (tab: WorkspaceTab) => (tab.pane === "right" ? rightVisible(current) : bottomVisible(current)) && current.active[tab.pane] === tab.id;
    const hide = (tab: WorkspaceTab) => (tab.pane === "right" ? setLayoutValue("hidden") : setBottom(false));
    const toggle = (kind: WorkspaceTabKind) => {
      const tab = current.tabs.find((candidate) => candidate.kind === kind);
      if (tab && visible(tab)) hide(tab);
      else openTab(kind);
    };
    if (command === "workspace-layout") {
      // "Hide tabs": the panel goes away and comes back as it was
      if (!current.tabs.some((tab) => tab.pane === "right")) openTab(browserAvailable ? "browser" : "newtab");
      else setLayoutValue(rightVisible(current) ? "hidden" : "split");
    } else if (command === "workspace-full") {
      if (!current.tabs.some((tab) => tab.pane === "right")) { openTab(browserAvailable ? "browser" : "newtab"); setLayoutValue("full"); }
      else setLayoutValue(current.layout === "full" ? "split" : "full");
    } else if (command === "workspace-sidechat") void openSideChat();
    else if (command === "workspace-new-tab") {
      if (browserAvailable) { openTab("browser"); sendBrowserCommand({ op: "new", reuseBlank: !current.tabs.some(tab => tab.kind === "browser") }); }
      else openTab("newtab", { pane: "right" });
    } else if (command === "workspace-terminal") toggle("terminal");
    else if (command === "workspace-bottom") {
      if (current.tabs.some((tab) => tab.pane === "bottom")) setBottom(!current.bottomOpen);
      else openTab("terminal", { pane: "bottom" });
    } else if (command === "workspace-files") toggle("files");
    else if (command === "workspace-file-search") setQuickOpen(true);
    else if (command === "workspace-reopen") {
      const current = targetRef.current;
      if (!current) return;
      const id = workspaceKey(current.botId, current.threadId);
      const index = closed.current.map((entry) => entry.key).lastIndexOf(id);
      if (index < 0) return;
      const { tab } = closed.current[index]!;
      closed.current = closed.current.filter((_, at) => at !== index);
      openTab(tab.kind, { pane: tab.pane, path: tab.path, ref: tab.ref, title: tab.title });
    } else if (command === "workspace-changes") openTab("changes");
    else if (command === "workspace-browser") { if (browserAvailable) openTab("browser"); }
  }, [browserAvailable, openTab, openSideChat, setBottom, setLayoutValue]);

  useEffect(() => {
    if (!available) return;
    const mac = isMac();
    const onKey = (event: KeyboardEvent) => {
      if (!targetRef.current) return;
      const command = workspaceCommandForEvent(event, mac);
      if (!command) return;
      // inside the browser chrome its own keymap (⌘P print, ⌘⇧T reopen tab) wins
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest("[data-workspace-browser]") && browserCommand(event)) return;
      event.preventDefault();
      run(command.id);
    };
    const onCommand = (event: Event) => run((event as CustomEvent<WorkspaceCommandId>).detail);
    window.addEventListener("keydown", onKey);
    window.addEventListener(WORKSPACE_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(WORKSPACE_COMMAND_EVENT, onCommand);
    };
  }, [available, run]);

  // a bot's open_tab shows its page beside that conversation, now if it is on
  // screen, or waiting in its workspace for when you go back to it
  useEffect(() => {
    if (!available) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ botId?: unknown; threadId?: unknown; ref?: unknown; title?: unknown }>).detail;
      if (typeof detail?.botId !== "string" || typeof detail.threadId !== "string" || typeof detail.ref !== "string" || !detail.ref) return;
      const id = workspaceKey(detail.botId, detail.threadId);
      const ref = detail.ref, title = typeof detail.title === "string" ? detail.title : undefined;
      setWorkspaces((all) => {
        const next = showPage(all[id] ?? loadWorkspace(id), ref, title).state;
        saveWorkspace(id, next);
        return { ...all, [id]: next };
      });
    };
    window.addEventListener("bos-workspace-open", onOpen);
    return () => window.removeEventListener("bos-workspace-open", onOpen);
  }, [available]);
  // a link opened from another app shows the browser tab; a bot's reveal
  // shows it only in that bot's thread and opens it out of sight elsewhere
  const [browserInBackground, setBrowserInBackground] = useState(false);
  useEffect(() => {
    const bridge = window.ogb?.primaryBrowser;
    if (!available || !bridge) return;
    const showBrowser = (origin?: { threadId?: string }) => {
      if (origin?.threadId && origin.threadId !== targetRef.current?.threadId) setBrowserInBackground(true);
      else if (targetRef.current) openTab("browser");
    };
    const stop = bridge.onExternalURL(showBrowser);
    // a link that arrived before a local conversation was open waits for one
    if (targetRef.current) void bridge.action("consume-external-link").then((pending) => { if (pending) showBrowser(typeof pending === "object" ? pending : undefined); }).catch(() => {});
    return stop;
  }, [available, openTab, primaryKey]);
  const [botBrowsing, setBotBrowsing] = useState<{ botId: string; threadId: string } | null>(null);
  useEffect(() => window.ogb?.primaryBrowser?.onAgentState((state) => {
    const holder = Object.values(state.tabs ?? {}).find((tab) => tab.mode === "bot" && tab.botId && tab.threadId);
    setBotBrowsing((current) => holder ? (current && current.threadId === holder.threadId && current.botId === holder.botId ? current : { botId: holder.botId!, threadId: holder.threadId! }) : null);
    if (holder) setBrowserInBackground(false);
  }), []);
  // going to the thread a bot is browsing for shows its browser there
  const botBrowsingRef = useRef(botBrowsing);
  botBrowsingRef.current = botBrowsing;
  useEffect(() => {
    const current = targetRef.current;
    if (browserAvailable && current && botBrowsingRef.current?.threadId === current.threadId) openTab("browser");
  }, [browserAvailable, openTab, primaryKey]);

  const value = useMemo<WorkspaceValue>(() => ({
    available, target, workspace, show, openTab, closeTab, focusTab, moveTab, detach, setLayout: setLayoutValue, setBottomOpen: setBottom,
    setTabPath, setTabTitle, setTabRef, replaceTab, openSideChat, openFile, locate, quickOpen, setQuickOpen, git, noteChanges, browserAvailable, browserInBackground, botBrowsing,
  }), [available, target, workspace, show, openTab, closeTab, focusTab, moveTab, detach, setLayoutValue, setBottom, setTabPath, setTabTitle, setTabRef, replaceTab, openSideChat, openFile, locate, quickOpen, git, noteChanges, browserAvailable, browserInBackground, botBrowsing]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
