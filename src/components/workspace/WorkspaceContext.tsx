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
  DETACHABLE, bottomVisible, closeTab as closeTabState, cycleLayout, focusTab as focusTabState, loadWorkspace, moveTab as moveTabState,
  openTab as openTabState, rightVisible, saveWorkspace, setBottomOpen, setFilePath, setLayout, workspaceKey,
  type ThreadWorkspace, type WorkspaceLayout, type WorkspacePane, type WorkspaceTab, type WorkspaceTabKind,
} from "@/lib/thread-workspace";
import { WORKSPACE_COMMAND_EVENT, workspaceCommandForEvent, type WorkspaceCommandId } from "@/lib/workspace-commands";
import { locatePath, type WorkspaceChanges } from "@/lib/workspace-files-client";
import { useStore } from "@/state/store";

export interface OpenOptions { pane?: WorkspacePane; path?: string; fresh?: boolean }

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
  openFile: (path: string, threadId?: string) => Promise<boolean>;
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  /** Whether the folder is a git repo, as the last changes fetch found it. */
  git: boolean | undefined;
  noteChanges: (changes: WorkspaceChanges) => void;
  browserAvailable: boolean;
}

const noop = () => {};
const WorkspaceContext = createContext<WorkspaceValue>({
  available: false, target: null, workspace: { tabs: [], active: {}, layout: "hidden", bottomOpen: false }, show: noop, openTab: noop, closeTab: noop,
  focusTab: noop, moveTab: noop, detach: noop, setLayout: noop, setBottomOpen: noop, setTabPath: noop, openFile: async () => false, quickOpen: false, setQuickOpen: noop,
  git: undefined, noteChanges: noop, browserAvailable: false,
});

export function useWorkspace(): WorkspaceValue {
  return useContext(WorkspaceContext);
}

const isMac = () => /mac/i.test(globalThis.navigator?.platform ?? "") || globalThis.window?.ogb?.platform === "darwin";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
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
    else closed.current = [...closed.current, { key: workspaceKey(current.botId, current.threadId), tab }].slice(-20);
    update((state) => closeTabState(state, id).state);
  }, [update]);

  const focusTab = useCallback((id: string) => update((state) => focusTabState(state, id)), [update]);
  const moveTab = useCallback((id: string, pane: WorkspacePane) => update((state) => moveTabState(state, id, pane)), [update]);
  const setLayoutValue = useCallback((layout: WorkspaceLayout) => update((state) => setLayout(state, layout)), [update]);
  const setBottom = useCallback((open: boolean) => update((state) => setBottomOpen(state, open)), [update]);
  const setTabPath = useCallback((id: string, path: string | undefined) => update((state) => setFilePath(state, id, path)), [update]);

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
  /** A path the bot mentioned: show it in the files tab of the conversation
   * it was mentioned in. False when it is not inside that working folder. */
  const openFile = useCallback(async (path: string, threadId?: string): Promise<boolean> => {
    const current = targetRef.current;
    let where: TerminalTarget | null = current;
    if (threadId && threadId !== current?.threadId) {
      const { bots, groups } = stateRef.current;
      const group = groups.find((candidate) => candidate.threadId === threadId);
      const bot = group ? undefined : bots.find((candidate) => candidate.threadId === threadId || candidate.tasks?.some((task) => task.threadId === threadId));
      where = group && !group.dm ? { botId: group.id, threadId, name: group.name }
        : bot && !remoteBotHint(bot) ? { botId: bot.id, threadId, name: bot.name } : null;
    }
    if (!available || !where) return false;
    let location;
    try { location = await locatePath(where, path); } catch { return false; }
    if (!sameTerminalTarget(where, targetRef.current)) {
      setOverride(where);
      targetRef.current = where;
    }
    openTab("files", location.kind === "file" ? { path: location.path } : {});
    return true;
  }, [available, openTab]);

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
      if (!current.tabs.some((tab) => tab.pane === "right")) openTab(browserAvailable ? "browser" : "files");
      else update(cycleLayout);
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
      openTab(tab.kind, { pane: tab.pane, path: tab.path });
    } else if (command === "workspace-changes") openTab("changes");
    else if (command === "workspace-browser") { if (browserAvailable) openTab("browser"); }
  }, [browserAvailable, openTab, setBottom, setLayoutValue, update]);

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

  // a link opened from another app shows the browser tab
  useEffect(() => {
    const bridge = window.ogb?.primaryBrowser;
    if (!available || !bridge) return;
    const showBrowser = () => { if (targetRef.current) openTab("browser"); };
    const stop = bridge.onExternalURL(showBrowser);
    // a link that arrived before a local conversation was open waits for one
    if (targetRef.current) void bridge.action("consume-external-link").then((pending) => { if (pending) showBrowser(); }).catch(() => {});
    return stop;
  }, [available, openTab, primaryKey]);

  const value = useMemo<WorkspaceValue>(() => ({
    available, target, workspace, show, openTab, closeTab, focusTab, moveTab, detach, setLayout: setLayoutValue, setBottomOpen: setBottom,
    setTabPath, openFile, quickOpen, setQuickOpen, git, noteChanges, browserAvailable,
  }), [available, target, workspace, show, openTab, closeTab, focusTab, moveTab, detach, setLayoutValue, setBottom, setTabPath, openFile, quickOpen, git, noteChanges, browserAvailable]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
