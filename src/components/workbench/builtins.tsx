/** The tab kinds bos ships with, registered like any other kind. The browser
 * is the exception: it is one native view the dock keeps mounted, and its
 * page tabs come from browser-tabs.ts. */
import { Folders, GitCompare, Globe, MessageCircle, NotebookText, Plus, SquareTerminal } from "lucide-react";

import { BrowserPanel } from "@/components/BrowserPanel";
import { CANVAS_DIR, canvasFileTitle } from "@/components/canvas/canvas";
import { isPinned, pinPage, unpinPage, usePins, type PinnedPage } from "@/components/canvas/pins";
import { NewTabPage, type NewTabPins, type NewTabTool } from "@/components/workbench/NewTabPage";
import { SideChatTab } from "@/components/workbench/SideChatTab";
import { registerTabKind, tabKind, useTabKinds, type TabRenderProps } from "@/components/workbench/registry";
import { ChangesTab } from "@/components/workspace/ChangesTab";
import { FilesTab } from "@/components/workspace/FilesTab";
import { TerminalTab } from "@/components/workspace/TerminalTab";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { browserAvailable as serverBrowserAvailable } from "@/lib/feature-flags";
import { remoteBotHint } from "@/lib/remote-bot";
import { listFolder } from "@/lib/workspace-files-client";
import { useStore } from "@/state/store";

function FilesKind({ tab, target, active }: TabRenderProps) {
  const { setTabPath } = useWorkspace();
  return <FilesTab target={target} tabId={tab.id} path={tab.path} active={active} onPath={(path) => setTabPath(tab.id, path)} />;
}

function ChangesKind({ target, active }: TabRenderProps) {
  const { openTab, noteChanges } = useWorkspace();
  return <ChangesTab target={target} active={active} onChanges={noteChanges} onOpenFile={(path) => openTab("files", { path })} />;
}

function BotBrowserKind({ target }: TabRenderProps) {
  const { state } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      {bot && !remoteBotHint(bot)
        ? <><p className="mb-2 px-2 text-xs text-ink-secondary">separate from your tabs. watching leaves the bot in control.</p><BrowserPanel bot={bot} /></>
        : <p className="p-4 text-xs text-ink-secondary">this bot has no browser on this server.</p>}
    </div>
  );
}

/** Opening a tool from a new tab: the tab becomes the tool. */
export function usePickTool() {
  const { openSideChat, openTab, closeTab, replaceTab } = useWorkspace();
  return (tool: NewTabTool, replacing?: string) => {
    if (tool === "sidechat") return void openSideChat(replacing);
    if (tool === "terminal-bottom") {
      if (replacing) closeTab(replacing);
      return openTab("terminal", { pane: "bottom", fresh: true });
    }
    const kind = tool === "blank" ? "canvas" : tool;
    if (replacing) replaceTab(replacing, kind);
    else openTab(kind, { pane: "right", fresh: kind === "terminal" });
  };
}

/** Whether the real page editor has registered (not the placeholder). */
export function pagesReady(): boolean {
  const page = tabKind("page");
  return Boolean(page && !page.placeholder);
}

/** Whether the video editor has registered. */
export function videosReady(): boolean {
  return Boolean(tabKind("video"));
}

/** Whether the blank tab has registered. */
export function blankReady(): boolean {
  return Boolean(tabKind("canvas"));
}

/** The rows a new tab offers beyond ChatGPT's: changes in a git folder, and
 * the server's browser when this computer has none of its own. */
export function useNewTabExtras() {
  const { git, browserAvailable, target } = useWorkspace();
  const { state } = useStore();
  const botBrowser = !browserAvailable && serverBrowserAvailable(state.config) && state.config?.features?.browser !== false;
  // the blank tab, like pages and videos, belongs to direct conversations
  const direct = !target || !state.groups.some((group) => group.id === target.botId);
  return { blank: blankReady() && direct, changes: git === true, botBrowser };
}

const pinKey = (pin: Pick<PinnedPage, "threadId" | "path">) => `${pin.threadId}:${pin.path}`;

/** Pages pinned to the Tools list, and the chooser that adds this chat's
 * pages to it. open turns a page into a tab (the caller says where). */
export function useNewTabPins(open: (kind: "canvas", options: { ref: string; title: string; from?: string }) => void): NewTabPins | undefined {
  const { target } = useWorkspace();
  const pins = usePins(target?.botId);
  if (!target) return undefined;
  const find = (key: string) => pins.find(pin => pinKey(pin) === key);
  return {
    pinned: pins.map(pin => ({ key: pinKey(pin), title: pin.title })),
    open: (key) => {
      const pin = find(key);
      if (pin) open("canvas", { ref: pin.path, title: pin.title, ...(pin.threadId !== target.threadId ? { from: pin.threadId } : {}) });
    },
    unpin: (key) => { const pin = find(key); if (pin) unpinPage(pin); },
    // this chat's pages, newest first, minus the ones already pinned
    choices: async () => {
      const listing = await listFolder(target, CANVAS_DIR).catch(() => null);
      return (listing?.entries ?? [])
        .filter(entry => entry.kind === "file" && /\.html?$/i.test(entry.name) && !isPinned(pins, { botId: target.botId, threadId: target.threadId, path: entry.path }))
        .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
        .map(entry => ({ key: pinKey({ threadId: target.threadId, path: entry.path }), title: canvasFileTitle(entry.name) }));
    },
    pin: (choice) => {
      const path = choice.key.slice(target.threadId.length + 1);
      pinPage({ botId: target.botId, threadId: target.threadId, path, title: choice.title });
    },
  };
}

function NewTabKind({ tab }: TabRenderProps) {
  useTabKinds();
  const pick = usePickTool();
  const extras = useNewTabExtras();
  const { replaceTab } = useWorkspace();
  const pins = useNewTabPins((kind, options) => replaceTab(tab.id, kind, options));
  return <NewTabPage {...extras} pins={extras.blank ? pins : undefined} onPick={(tool) => pick(tool, tab.id)} />;
}

function SideChatKind({ tab, target }: TabRenderProps) {
  return tab.ref ? <SideChatTab botId={target.botId} threadId={tab.ref} /> : null;
}

function placeOf(index: number, count: number, name: string) {
  return count > 1 ? `${name} ${index + 1}` : name;
}

registerTabKind({ kind: "terminal", icon: SquareTerminal, title: (_tab, { index, count }) => placeOf(index, count, "Terminal"),
  render: ({ tab, target, active }) => <TerminalTab target={target} tabId={tab.id} active={active} /> });
registerTabKind({ kind: "files", icon: Folders, title: (tab) => (tab.path ? tab.path.slice(tab.path.lastIndexOf("/") + 1) : "Open file"),
  render: (props) => <FilesKind {...props} /> });
registerTabKind({ kind: "changes", icon: GitCompare, title: () => "Changes", render: (props) => <ChangesKind {...props} /> });
registerTabKind({ kind: "bot-browser", icon: Globe, title: () => "Bot browser", render: (props) => <BotBrowserKind {...props} /> });
registerTabKind({ kind: "newtab", icon: Plus, title: () => "New tab", render: (props) => <NewTabKind {...props} /> });
registerTabKind({
  kind: "sidechat", icon: MessageCircle, title: (tab, { index, count }) => tab.title ?? placeOf(index, count, "Side chat"),
  render: (props) => <SideChatKind {...props} />,
  confirmClose: { title: "Close side chat?", body: "This side chat will be gone and can't be recovered. Are you sure?", confirmLabel: "Close" },
  // the thread is archived, not deleted: closing must never lose the bot's work
  onClosed: (tab, target, dispatch) => {
    if (tab.ref) dispatch({ type: "updateTask", botId: target.botId, threadId: tab.ref, patch: { archivedAt: Date.now() } });
  },
});

/** Until the pages thread registers the real editor, "page" is a plain
 * placeholder so a saved page tab still has something to show. */
registerTabKind({
  kind: "page", icon: NotebookText, title: (tab) => tab.title ?? "Untitled page", placeholder: true,
  render: () => (
    <div className="min-h-0 flex-1 overflow-y-auto px-12 pt-16">
      <h1 className="text-[34px] font-semibold leading-tight text-ink/35">Untitled page</h1>
    </div>
  ),
});
