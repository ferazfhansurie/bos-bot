/** The panels beside a conversation: a right panel (beside or over the
 * chat) and a bottom panel under it, each a strip of tabs. Everything they
 * show comes from the workspace provider; this file only lays it out. */
import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import {
  ChevronDown, ExternalLink, FolderTree, GitCompare, Globe, Maximize2, MessageSquare, Minimize2, PanelBottom, PanelRight, Plus, SquareTerminal, X,
  type LucideIcon,
} from "lucide-react";

import { BrowserPanel } from "@/components/BrowserPanel";
import { PanelResizeHandle, PanelResizeShield, useResizablePanel } from "@/components/PanelResizeHandle";
import { PrimaryBrowser } from "@/components/PrimaryBrowser";
import { RowContextMenu, openRowMenu, type RowMenuAt, type RowMenuItem } from "@/components/RowContextMenu";
import { TERMINAL_PANEL_SIZE } from "@/components/TerminalPanel";
import { ChangesTab } from "@/components/workspace/ChangesTab";
import { FilesTab } from "@/components/workspace/FilesTab";
import { QuickOpen } from "@/components/workspace/QuickOpen";
import { TerminalTab } from "@/components/workspace/TerminalTab";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import { browserAvailable as serverBrowserAvailable } from "@/lib/feature-flags";
import type { PanelSizeSpec } from "@/lib/panel-resize";
import { remoteBotHint } from "@/lib/remote-bot";
import type { TerminalTarget } from "@/lib/terminal";
import { DETACHABLE, TAB_LABEL, bottomVisible, rightVisible, type WorkspacePane, type WorkspaceTab, type WorkspaceTabKind } from "@/lib/thread-workspace";
import { fetchChanges } from "@/lib/workspace-files-client";
import { useStore } from "@/state/store";

export const WORKSPACE_BOTTOM_SIZE: PanelSizeSpec = { key: "bos.workspaceBottomHeight", defaultSize: 280, min: 120, reserve: 220 };

const ICON: Record<WorkspaceTabKind, LucideIcon> = {
  browser: Globe, terminal: SquareTerminal, files: FolderTree, changes: GitCompare, "bot-browser": Globe,
};
/** The browser is a native view that lives in the right panel. */
const RIGHT_ONLY: ReadonlySet<WorkspaceTabKind> = new Set(["browser", "bot-browser"]);

function useTabLabel() {
  const { workspace } = useWorkspace();
  return (tab: WorkspaceTab) => {
    if (tab.kind === "terminal") {
      const terminals = workspace.tabs.filter((candidate) => candidate.kind === "terminal");
      return terminals.length > 1 ? `terminal ${terminals.indexOf(tab) + 1}` : "terminal";
    }
    if (tab.kind === "files" && tab.path) return tab.path.slice(tab.path.lastIndexOf("/") + 1);
    return TAB_LABEL[tab.kind];
  };
}

function TabStrip({ pane, trailing }: { pane: WorkspacePane; trailing: ReactNode }) {
  const { workspace, focusTab, closeTab, moveTab, detach, openTab, setLayout, git, browserAvailable } = useWorkspace();
  const { state } = useStore();
  // Without this computer's own browser (a remote server's workspace), the
  // bot browses in the server's engine: offer the live view of that instead.
  const serverBrowser = !browserAvailable && serverBrowserAvailable(state.config) && state.config?.features?.browser !== false;
  const label = useTabLabel();
  const [menu, setMenu] = useState<{ at: RowMenuAt; items: RowMenuItem[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const tabs = workspace.tabs.filter((tab) => tab.pane === pane && !(tab.kind === "changes" && git === false));
  const full = pane === "right" && workspace.layout === "full";

  const tabMenu = (event: React.MouseEvent, tab: WorkspaceTab) => openRowMenu(event, (at) => setMenu({ at, items: [
    ...(RIGHT_ONLY.has(tab.kind) ? [] : pane === "right"
      ? [{ key: "bottom", label: "move to bottom panel", icon: <PanelBottom size={15} />, onSelect: () => moveTab(tab.id, "bottom") }]
      : [{ key: "right", label: "move to right panel", icon: <PanelRight size={15} />, onSelect: () => moveTab(tab.id, "right") }]),
    ...(DETACHABLE.has(tab.kind) && window.ogb?.workspaceWindow ? [{ key: "window", label: "move to new window", icon: <ExternalLink size={15} />, onSelect: () => detach(tab.id) }] : []),
    { key: "close", label: "close tab", icon: <X size={15} />, onSelect: () => closeTab(tab.id) },
  ] }));

  const addMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: RowMenuItem[] = [
      { key: "terminal", label: "terminal", icon: <SquareTerminal size={15} />, onSelect: () => openTab("terminal", { pane, fresh: true }) },
      { key: "files", label: "files", icon: <FolderTree size={15} />, onSelect: () => openTab("files", { pane: "right" }) },
      ...(git === false ? [] : [{ key: "changes", label: "changes", icon: <GitCompare size={15} />, onSelect: () => openTab("changes", { pane: "right" }) }]),
      ...(browserAvailable ? [{ key: "browser", label: "browser", icon: <Globe size={15} />, onSelect: () => openTab("browser") }] : []),
      ...(serverBrowser ? [{ key: "bot-browser", label: "browser", icon: <Globe size={15} />, onSelect: () => openTab("bot-browser", { pane: "right" }) }] : []),
    ];
    setMenu({ at: { x: rect.left, y: rect.bottom + 4 }, items });
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-hairline/50 bg-app px-1.5" role="tablist" aria-label={`${pane} panel`}>
      {full && (
        <button type="button" onClick={() => setLayout("split")} title="show chat" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink">
          <MessageSquare size={13} />chat
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          const Icon = ICON[tab.kind];
          const active = workspace.active[pane] === tab.id;
          return (
            <div key={tab.id} role="tab" aria-selected={active} tabIndex={0} title={tab.path ?? label(tab)}
              onClick={() => focusTab(tab.id)} onContextMenu={(event) => tabMenu(event, tab)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focusTab(tab.id); } }}
              onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}
              className={cn("group flex h-7 max-w-[180px] shrink-0 cursor-default select-none items-center gap-1.5 rounded-md pl-2 pr-1 text-[12.5px]",
                active ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink")}>
              <Icon size={13} className="shrink-0" />
              <span className="min-w-0 truncate">{label(tab)}</span>
              <button type="button" aria-label={`close ${label(tab)}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
                className={cn("rounded p-0.5 hover:bg-raised-hover hover:text-ink", active ? "opacity-70" : "opacity-0 group-hover:opacity-70")}><X size={11} /></button>
            </div>
          );
        })}
        <button type="button" onClick={addMenu} title="new tab" aria-label="new tab" className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><Plus size={13} /></button>
      </div>
      {trailing}
      {menu && <RowContextMenu at={menu.at} label="tab" items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

function TabBody({ tab, target, active }: { tab: WorkspaceTab; target: TerminalTarget; active: boolean }) {
  const { setTabPath, openTab, noteChanges } = useWorkspace();
  const { state } = useStore();
  if (!active) return null;
  if (tab.kind === "terminal") return <TerminalTab target={target} tabId={tab.id} active={active} />;
  if (tab.kind === "files") return <FilesTab target={target} tabId={tab.id} path={tab.path} active={active} onPath={(path) => setTabPath(tab.id, path)} />;
  if (tab.kind === "changes") return <ChangesTab target={target} active={active} onChanges={noteChanges} onOpenFile={(path) => openTab("files", { path })} />;
  if (tab.kind === "bot-browser") {
    const bot = state.bots.find((candidate) => candidate.id === target.botId);
    return (
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {bot && !remoteBotHint(bot)
          ? <><p className="mb-2 px-2 text-xs text-ink-secondary">separate from your tabs. watching leaves the bot in control.</p><BrowserPanel bot={bot} /></>
          : <p className="p-4 text-xs text-ink-secondary">this bot has no browser on this server.</p>}
      </div>
    );
  }
  return null;
}

/** Right panel: beside the chat in split, over it in full. */
export function WorkspaceRightPane({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { target, workspace, setLayout, openTab, closeTab } = useWorkspace();
  const panel = useResizablePanel(TERMINAL_PANEL_SIZE, "right", containerRef);
  const visible = Boolean(target) && rightVisible(workspace);
  const full = workspace.layout === "full";
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.active.right && tab.pane === "right");
  const browserTab = workspace.tabs.find((tab) => tab.kind === "browser");
  const showBrowser = visible && activeTab?.kind === "browser";
  // the browser is one native view for the window: once shown it stays
  // mounted, so switching threads or tabs never reloads its pages
  const [browserTarget, setBrowserTarget] = useState<TerminalTarget | null>(null);
  useEffect(() => { if (showBrowser && target) setBrowserTarget(target); }, [showBrowser, target]);
  const tabs = workspace.tabs.filter((tab) => tab.pane === "right");

  if (!target && !browserTarget) return null;
  return (
    <div className={cn("flex h-full min-w-0 shrink-0 max-md:hidden", !visible && "hidden", full ? "absolute inset-0 z-40" : "relative")}
      style={{ width: full ? "100%" : panel.size }} data-testid="terminal-dock">
      {!full && <PanelResizeHandle panel={panel} dock="right" label="resize panel" testId="terminal-resize-handle" />}
      <section aria-label="workspace" className={cn("flex h-full min-w-0 flex-1 flex-col bg-app", !full && "border-l border-hairline/50")}>
        <TabStrip pane="right" trailing={<>
          <button type="button" onClick={() => setLayout(full ? "split" : "full")} title={full ? "show chat beside" : "expand"} aria-label={full ? "show chat beside" : "expand"}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">{full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
          <button type="button" onClick={() => setLayout("hidden")} title="hide panel" aria-label="hide panel"
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><X size={13} /></button>
        </>} />
        {browserTarget && (
          <div data-workspace-browser className={cn("flex min-h-0 flex-1 flex-col", !showBrowser && "hidden")}>
            <PrimaryBrowser visible={showBrowser} expanded={full} target={target ?? browserTarget}
              onExpand={() => setLayout(full ? "split" : "full")}
              onTool={(tool) => openTab(tool)}
              onClose={() => { if (browserTab) closeTab(browserTab.id); }} />
          </div>
        )}
        {target && tabs.filter((tab) => tab.kind !== "browser").map((tab) => (
          <TabBody key={tab.id} tab={tab} target={target} active={visible && tab.id === activeTab?.id} />
        ))}
      </section>
      <PanelResizeShield active={panel.resizing} dock="right" />
    </div>
  );
}

/** Bottom panel: under the chat column, terminals by default. */
export function WorkspaceBottomPane({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { target, workspace, setBottomOpen } = useWorkspace();
  const panel = useResizablePanel(WORKSPACE_BOTTOM_SIZE, "bottom", containerRef);
  if (!target || !bottomVisible(workspace)) return null;
  const active = workspace.active.bottom;
  return (
    <div className="relative flex min-h-0 shrink-0 flex-col border-t border-hairline/50 bg-app max-md:hidden" style={{ height: panel.size }} data-testid="workspace-bottom">
      <PanelResizeHandle panel={panel} dock="bottom" label="resize bottom panel" testId="workspace-bottom-resize" />
      <TabStrip pane="bottom" trailing={
        <button type="button" onClick={() => setBottomOpen(false)} title="hide panel" aria-label="hide bottom panel"
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><ChevronDown size={13} /></button>
      } />
      {workspace.tabs.filter((tab) => tab.pane === "bottom").map((tab) => (
        <TabBody key={tab.id} tab={tab} target={target} active={tab.id === active} />
      ))}
      <PanelResizeShield active={panel.resizing} dock="bottom" />
    </div>
  );
}

/** ⌘P, and a one-off probe so the changes tab only shows for git folders. */
export function WorkspaceOverlays() {
  const { target, workspace, quickOpen, setQuickOpen, openTab, git, noteChanges } = useWorkspace();
  const botId = target?.botId, threadId = target?.threadId;
  const open = rightVisible(workspace) || bottomVisible(workspace);
  useEffect(() => {
    if (!botId || !threadId || !open || git !== undefined) return;
    const controller = new AbortController();
    void fetchChanges({ botId, threadId }, controller.signal).then(noteChanges).catch(() => {});
    return () => controller.abort();
  }, [botId, threadId, open, git, noteChanges]);
  const close = useCallback(() => setQuickOpen(false), [setQuickOpen]);
  if (!quickOpen || !target) return null;
  return <QuickOpen target={target} onOpen={(path) => openTab("files", { path })} onClose={close} />;
}
