/** The tab strip over a workspace panel. One row for every kind: the
 * browser's page tabs are spread out in place of the browser's workspace
 * tab, so web pages, files, terminals and side chats sit side by side the
 * way they do in a real browser. Far right: full view and "Hide tabs". */
import { useCallback, useState, type ReactNode } from "react";
import {
  ArrowRightToLine, Copy, CopyPlus, ExternalLink, Globe, Loader2, Maximize2, MessageSquare, Minimize2, PanelBottom, PanelRight, Plus, RotateCw, X,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Menu, pointAnchor, type MenuAnchor, type MenuEntry } from "@/components/workbench/Menu";
import { sendBrowserCommand, useBrowserTabs, type StripBrowserTab } from "@/components/workbench/browser-tabs";
import { tabKind, useTabKinds, type TabIcon } from "@/components/workbench/registry";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import { DETACHABLE, TAB_LABEL, type WorkspacePane, type WorkspaceTab } from "@/lib/thread-workspace";
import { runWorkspaceCommand } from "@/lib/workspace-commands";
import { useStore } from "@/state/store";
import { useV3 } from "@/lib/v3";
import { TabMascot } from "@/components/v3/Alive";
import { useStage } from "@/lib/v3-stage";

const mac = () => /mac/i.test(globalThis.navigator?.platform ?? "") || globalThis.window?.ogb?.platform === "darwin";

/** A strip button with ChatGPT's hover card: label and keycap. */
export function StripButton({ label, keys, onClick, pressed, children, className }: {
  label: string; keys?: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; pressed?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <span className="group/tip relative flex">
      <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick}
        className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg text-ink/70 transition-colors duration-150 ease-out hover:bg-ink/[.078] hover:text-ink",
          pressed && "bg-ink/[.1] text-ink", className)}>
        {children}
      </button>
      <span data-popover role="tooltip" className="pointer-events-none absolute end-0 top-[calc(100%+6px)] z-50 hidden items-center gap-2 whitespace-nowrap rounded-xl border border-ink/[.084] bg-menu px-2.5 py-1.5 text-[13px] text-ink shadow-lg group-hover/tip:flex group-hover/tip:delay-500">
        {label}{keys && <kbd className="rounded-md bg-ink/[.12] px-1.5 font-sans text-[12px] text-ink/80">{keys}</kbd>}
      </span>
    </span>
  );
}

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

interface StripItem {
  key: string;
  tab: WorkspaceTab;
  page?: StripBrowserTab;
  title: string;
  icon: TabIcon;
  favicon?: string;
  loading?: boolean;
  active: boolean;
  hint?: string;
}

function StripTab({ item, onActivate, onClose, onMenu, botId }: {
  item: StripItem; onActivate: () => void; onClose: () => void; onMenu: (event: React.MouseEvent) => void;
  /** 3.0: the bot working in this tab, who walks into its header */
  botId?: string;
}) {
  const Icon = item.icon;
  const [broken, setBroken] = useState(false);
  const icon = item.loading
    ? <Loader2 size={16} className="shrink-0 animate-spin text-ink/60" />
    : item.favicon && !broken
      ? <img src={item.favicon} alt="" className="size-4 shrink-0 rounded-[3px]" onError={() => setBroken(true)} />
      : <Icon size={16} strokeWidth={1.75} className="shrink-0" />;
  return (
    <div role="tab" aria-selected={item.active} tabIndex={0} title={item.hint ?? item.title}
      data-testid="workbench-tab" data-kind={item.page ? "browser-page" : item.tab.kind}
      onClick={onActivate} onContextMenu={onMenu}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(); } }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(); } }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      className={cn("workbench-tab group relative flex h-8 min-w-[90px] max-w-[240px] flex-1 basis-0 cursor-default select-none items-center gap-2 rounded-[10px] border pe-1 ps-2.5 text-[13px] transition-colors duration-150 ease-out",
        item.active ? "is-active border-ink/[.084] bg-ink/[.1] text-ink shadow-sm" : "border-transparent text-ink/70 hover:bg-ink/[.1] hover:text-ink")}>
      {botId ? <TabMascot botId={botId} fallback={icon} /> : icon}
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]">{item.title}</span>
      <button type="button" aria-label={`Close ${item.title}`} onClick={(event) => { event.stopPropagation(); onClose(); }}
        className={cn("workbench-tab-close flex size-6 shrink-0 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[.1] hover:text-ink",
          item.active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
        <X size={14} />
      </button>
    </div>
  );
}

export function WorkbenchStrip({ pane, leading, trailing }: { pane: WorkspacePane; leading?: ReactNode; trailing?: ReactNode }) {
  useTabKinds();
  const { target, workspace, focusTab, closeTab, moveTab, detach, openTab, git, botBrowsing } = useWorkspace();
  const v3 = useV3();
  const opener = useStage(target?.botId ?? "");
  const { dispatch } = useStore();
  const browser = useBrowserTabs();
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(null);
  const [confirm, setConfirm] = useState<WorkspaceTab[] | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const tabs = workspace.tabs.filter((tab) => tab.pane === pane && !(tab.kind === "changes" && git === false));

  const items: StripItem[] = [];
  for (const tab of tabs) {
    const active = workspace.active[pane] === tab.id;
    if (tab.kind === "browser") {
      const pages = browser.tabs.length ? browser.tabs : [{ id: "", title: "New tab", url: "about:blank" }];
      for (const page of pages) {
        const blank = !page.url || page.url === "about:blank";
        items.push({
          key: `${tab.id}:${page.id}`, tab, page, icon: Globe, favicon: page.favicon, loading: page.loading,
          title: blank ? "New tab" : page.title || hostOf(page.url) || page.url,
          hint: blank ? "New tab" : `${page.title}\n${page.url}`,
          active: active && (!browser.active || page.id === browser.active),
        });
      }
      continue;
    }
    const definition = tabKind(tab.kind);
    const same = tabs.filter((candidate) => candidate.kind === tab.kind);
    items.push({
      key: tab.id, tab, active,
      icon: definition?.icon ?? Globe,
      title: definition?.title(tab, { index: same.indexOf(tab), count: same.length }) ?? TAB_LABEL[tab.kind],
      hint: tab.path,
    });
  }

  const finishClose = (closing: WorkspaceTab[]) => {
    for (const tab of closing) {
      closeTab(tab.id);
      if (target) tabKind(tab.kind)?.onClosed?.(tab, target, dispatch);
    }
  };
  /** Close workspace tabs, asking first when a kind wants that. */
  const requestClose = (closing: WorkspaceTab[]) => {
    if (!closing.length) return;
    if (closing.some((tab) => tabKind(tab.kind)?.confirmClose)) setConfirm(closing);
    else finishClose(closing);
  };
  const browserTab = tabs.find((tab) => tab.kind === "browser");
  const closeItem = (item: StripItem) => {
    if (!item.page) return requestClose([item.tab]);
    // the last page closes the browser tab; the browser keeps a fresh new tab
    if (browser.tabs.length > 1 && item.page.id) sendBrowserCommand({ op: "close", id: item.page.id });
    else {
      if (item.page.id) sendBrowserCommand({ op: "close", id: item.page.id });
      closeTab(item.tab.id);
    }
  };
  const activate = (item: StripItem) => {
    focusTab(item.tab.id);
    if (item.page?.id) sendBrowserCommand({ op: "activate", id: item.page.id });
  };
  const others = (item: StripItem) => tabs.filter((tab) => tab.id !== item.tab.id && tab.kind !== "browser");
  const rightOf = (item: StripItem) => {
    const at = items.indexOf(item);
    return items.slice(at + 1);
  };

  const openMenu = (event: React.MouseEvent, item: StripItem) => {
    event.preventDefault();
    const anchor = pointAnchor(event.clientX, event.clientY);
    const right = rightOf(item);
    const closeRight = () => {
      if (item.page?.id) sendBrowserCommand({ op: "close-right", id: item.page.id });
      requestClose([...new Set(right.filter((entry) => !entry.page).map((entry) => entry.tab))]);
    };
    const closeOthers = () => {
      if (item.page?.id) sendBrowserCommand({ op: "close-others", id: item.page.id });
      else if (browserTab) closeTab(browserTab.id);
      requestClose(others(item));
    };
    const close: MenuEntry[] = [
      { type: "separator", key: "s-close" },
      { key: "close", label: "Close", shortcut: item.page ? (mac() ? "⌘W" : "Ctrl W") : undefined, onSelect: () => closeItem(item) },
      { key: "close-others", label: "Close other tabs", disabled: items.length < 2, onSelect: closeOthers },
      { key: "close-right", label: "Close tabs to the right", disabled: right.length === 0, onSelect: closeRight },
    ];
    if (item.page) {
      const id = item.page.id;
      const blank = !item.page.url || item.page.url === "about:blank";
      setMenu({ anchor, entries: [
        { key: "reload", label: "Reload", icon: RotateCw, disabled: blank || !id, onSelect: () => sendBrowserCommand({ op: "reload", id }) },
        { key: "duplicate", label: "Duplicate", icon: CopyPlus, disabled: !id, onSelect: () => sendBrowserCommand({ op: "duplicate", id }) },
        { key: "copy", label: "Copy URL", icon: Copy, disabled: blank || !id, onSelect: () => sendBrowserCommand({ op: "copy-url", id }) },
        { type: "separator", key: "s-new" },
        { key: "new-right", label: "New tab to the right", icon: ArrowRightToLine, onSelect: () => { focusTab(item.tab.id); sendBrowserCommand({ op: "new", after: id || undefined }); } },
        { key: "external", label: "Open in external browser", icon: ExternalLink, disabled: blank || !id, onSelect: () => sendBrowserCommand({ op: "external", id }) },
        ...close,
      ] });
      return;
    }
    const tab = item.tab;
    const movable = tab.kind !== "bot-browser";
    setMenu({ anchor, entries: [
      ...(movable ? [pane === "right"
        ? { key: "bottom", label: "Move to bottom panel", icon: PanelBottom, onSelect: () => moveTab(tab.id, "bottom") }
        : { key: "right", label: "Move to right panel", icon: PanelRight, onSelect: () => moveTab(tab.id, "right") }] : []),
      ...(DETACHABLE.has(tab.kind) && window.ogb?.workspaceWindow ? [{ key: "window", label: "Move to new window", icon: ExternalLink, onSelect: () => detach(tab.id) }] : []),
      ...close,
    ] });
  };

  return (
    <div className="workbench-strip flex h-[43px] shrink-0 items-center gap-2 bg-inset pe-1.5 ps-2" role="tablist" aria-label={`${pane} panel`}>
      {leading}
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
        {items.map((item, index) => {
          const previous = items[index - 1];
          return (
            <div key={item.key} className="contents">
              {index > 0 && <span aria-hidden className={cn("mx-1 h-3 w-px shrink-0 bg-ink/[.12]", (item.active || previous?.active) && "opacity-0")} />}
              <StripTab item={item} onActivate={() => activate(item)} onClose={() => closeItem(item)} onMenu={(event) => openMenu(event, item)}
                botId={!v3 ? undefined : item.page ? (item.page.agent === "bot" ? botBrowsing?.botId : undefined) : (opener.opened === item.tab.id ? target?.botId : undefined)} />
            </div>
          );
        })}
        <button type="button" aria-label="New tab" title="New tab" data-testid="workbench-new-tab"
          onClick={() => {
            if (pane === "bottom") return openTab("terminal", { pane: "bottom", fresh: true });
            runWorkspaceCommand("workspace-new-tab");
          }}
          className="ms-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-ink/70 transition-colors duration-150 ease-out hover:bg-ink/[.078] hover:text-ink">
          <Plus size={18} strokeWidth={1.75} />
        </button>
      </div>
      {trailing}
      {menu && <Menu anchor={menu.anchor} entries={menu.entries} label="Tab" onClose={closeMenu} width={240} />}
      {confirm && (() => {
        const kind = confirm.map((tab) => tabKind(tab.kind)?.confirmClose).find(Boolean)!;
        return (
          <ConfirmDialog open title={kind.title} body={kind.body} confirmLabel={kind.confirmLabel} tone="neutral"
            onCancel={() => setConfirm(null)} onConfirm={() => { const closing = confirm; setConfirm(null); finishClose(closing); }} />
        );
      })()}
    </div>
  );
}

/** Right panel's far-right controls: full view and hide. */
export function WorkbenchPanelControls() {
  const { workspace, setLayout } = useWorkspace();
  const full = workspace.layout === "full";
  const isMac = mac();
  return (
    <div className="flex shrink-0 items-center gap-2">
      <StripButton label={full ? "Exit full view" : "Enter full view"} keys={isMac ? "⇧⌘F" : "Ctrl Shift F"} onClick={() => setLayout(full ? "split" : "full")}>
        {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </StripButton>
      <StripButton label="Hide tabs" keys={isMac ? "⇧⌘B" : "Ctrl Shift B"} onClick={() => setLayout("hidden")} pressed>
        <PanelRight size={17} strokeWidth={1.75} />
      </StripButton>
    </div>
  );
}

/** In full view the chat is behind the panel; this brings it back. */
export function WorkbenchShowChat() {
  const { setLayout } = useWorkspace();
  return (
    <button type="button" onClick={() => setLayout("split")} title="Show chat"
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink/70 hover:bg-ink/[.078] hover:text-ink">
      <MessageSquare size={14} />Chat
    </button>
  );
}
