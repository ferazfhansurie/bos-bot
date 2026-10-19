/** The panels beside a conversation: a right panel (beside or over the
 * chat) and a bottom panel under it, each a strip of tabs. Everything they
 * show comes from the workspace provider; this file only lays it out. */
import { useCallback, useEffect, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

import { PanelResizeHandle, PanelResizeShield, useResizablePanel } from "@/components/PanelResizeHandle";
import { PrimaryBrowser } from "@/components/PrimaryBrowser";
import { TERMINAL_PANEL_SIZE } from "@/components/TerminalPanel";
import "@/components/workbench/kinds";
import { usePickTool } from "@/components/workbench/builtins";
import { tabKind, useTabKinds } from "@/components/workbench/registry";
import { StripButton, WorkbenchPanelControls, WorkbenchShowChat, WorkbenchStrip } from "@/components/workbench/WorkbenchStrip";
import { QuickOpen } from "@/components/workspace/QuickOpen";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import type { PanelSizeSpec } from "@/lib/panel-resize";
import type { TerminalTarget } from "@/lib/terminal";
import { bottomVisible, rightVisible, type WorkspaceTab, type WorkspaceTabKind } from "@/lib/thread-workspace";
import { fetchChanges } from "@/lib/workspace-files-client";

export const WORKSPACE_BOTTOM_SIZE: PanelSizeSpec = { key: "bos.workspaceBottomHeight", defaultSize: 280, min: 120, reserve: 220 };

/** Each kind draws itself (see workbench/registry.ts); hidden tabs unmount
 * unless their kind keeps them alive. */
function TabBody({ tab, target, active }: { tab: WorkspaceTab; target: TerminalTarget; active: boolean }) {
  useTabKinds();
  const { closeTab, replaceTab, setTabTitle, setTabRef } = useWorkspace();
  const definition = tabKind(tab.kind);
  if (!definition || (!active && !definition.keepMounted)) return null;
  const body = definition.render({
    tab, target, active,
    setTab: (patch) => {
      if ("title" in patch) setTabTitle(tab.id, patch.title);
      if (patch.ref) setTabRef(tab.id, patch.ref);
    },
    replace: (kind: WorkspaceTabKind, options) => replaceTab(tab.id, kind, options),
    close: () => closeTab(tab.id),
  });
  if (active) return <>{body}</>;
  return <div className="hidden">{body}</div>;
}

/** Right panel: beside the chat in split, over it in full. */
export function WorkspaceRightPane({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { target, workspace, setLayout, closeTab, browserInBackground, botBrowsing } = useWorkspace();
  const pick = usePickTool();
  const panel = useResizablePanel(TERMINAL_PANEL_SIZE, "right", containerRef);
  const visible = Boolean(target) && rightVisible(workspace);
  const full = workspace.layout === "full";
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.active.right && tab.pane === "right");
  const browserTab = workspace.tabs.find((tab) => tab.kind === "browser");
  const showBrowser = visible && activeTab?.kind === "browser";
  // the browser is one native view for the window: once shown it stays
  // mounted, so switching threads or tabs never reloads its pages
  const [browserTarget, setBrowserTarget] = useState<TerminalTarget | null>(null);
  useEffect(() => { if ((showBrowser || browserInBackground) && target) setBrowserTarget(current => showBrowser || !current ? target : current); }, [showBrowser, browserInBackground, target]);
  const tabs = workspace.tabs.filter((tab) => tab.pane === "right");

  if (!target && !browserTarget) return null;
  return (
    // while a bot browses, a closed pane is parked, never display:none, so
    // the bot's page stays live and painted for snapshots and screenshots
    <div className={cn("flex h-full min-w-0 shrink-0 max-md:hidden", !visible ? (browserTarget && (botBrowsing || browserInBackground) ? "workspace-dock-parked" : "hidden") : full ? "absolute inset-0 z-40" : "relative")}
      style={{ width: full && visible ? "100%" : panel.size }} aria-hidden={!visible || undefined} data-testid="terminal-dock">
      {!full && <PanelResizeHandle panel={panel} dock="right" label="resize panel" testId="terminal-resize-handle" />}
      <section aria-label="workspace" className={cn("relative flex h-full min-w-0 flex-1 flex-col bg-app", !full && "border-l border-hairline/50")}>
        <WorkbenchStrip pane="right" leading={full ? <WorkbenchShowChat /> : undefined} trailing={<WorkbenchPanelControls />} />
        {browserTarget && (
          <div data-workspace-browser className={cn("flex min-h-0 flex-1 flex-col", !showBrowser && (botBrowsing || browserInBackground ? "browser-parked" : "hidden"))}>
            <PrimaryBrowser integrated visible={showBrowser} expanded={full} target={target ?? browserTarget}
              onExpand={() => setLayout(full ? "split" : "full")}
              onTool={(tool) => pick(tool)}
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
      <WorkbenchStrip pane="bottom" trailing={
        <StripButton label="Hide bottom panel" keys={/mac/i.test(globalThis.navigator?.platform ?? "") ? "⌘J" : "Ctrl J"} onClick={() => setBottomOpen(false)}>
          <ChevronDown size={16} />
        </StripButton>
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
