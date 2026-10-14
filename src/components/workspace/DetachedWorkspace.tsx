/** A workspace tab moved into its own window: the renderer is the same, but
 * it draws only that tab. The terminal reattaches to the shell the main
 * window left running; closing this window ends it, as closing the tab would. */
import { useEffect, useState } from "react";
import { FolderTree, GitCompare, SquareTerminal } from "lucide-react";

import { ChangesTab } from "@/components/workspace/ChangesTab";
import { FilesTab } from "@/components/workspace/FilesTab";
import { TerminalTab } from "@/components/workspace/TerminalTab";
import { closeTerminalSession } from "@/components/workspace/terminal-sessions";
import type { TerminalTarget } from "@/lib/terminal";
import { DETACHABLE, TAB_LABEL, type WorkspaceTab } from "@/lib/thread-workspace";

export interface DetachedSpec { target: TerminalTarget; tab: WorkspaceTab }

const text = (value: unknown, max = 400): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** The `bos-detached` query parameter, when it describes a tab this window can show. */
export function detachedSpecFromLocation(search: string): DetachedSpec | null {
  const raw = new URLSearchParams(search).get("bos-detached");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { target?: Partial<TerminalTarget>; tab?: Partial<WorkspaceTab> };
    const { target, tab } = parsed;
    if (!target || !tab || !text(target.botId) || !text(target.threadId) || !text(tab.id) || !tab.kind || !DETACHABLE.has(tab.kind)) return null;
    return {
      target: { botId: target.botId, threadId: target.threadId, name: typeof target.name === "string" ? target.name : "" },
      tab: { id: tab.id, kind: tab.kind, pane: "right", ...(text(tab.path, 4096) ? { path: tab.path } : {}) },
    };
  } catch {
    return null;
  }
}

export function DetachedWorkspace({ spec }: { spec: DetachedSpec }) {
  const { target, tab } = spec;
  const [path, setPath] = useState(tab.path);
  const Icon = tab.kind === "terminal" ? SquareTerminal : tab.kind === "files" ? FolderTree : GitCompare;

  useEffect(() => {
    document.title = `${TAB_LABEL[tab.kind]} · ${target.name || "bos"}`;
    if (tab.kind !== "terminal") return;
    const end = () => closeTerminalSession(tab.id);
    window.addEventListener("beforeunload", end);
    return () => window.removeEventListener("beforeunload", end);
  }, [tab.id, tab.kind, target.name]);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-app text-ink">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline/50 px-3 text-[12.5px] text-ink-secondary [-webkit-app-region:drag]">
        <Icon size={13} className="shrink-0" />
        <span className="text-ink">{TAB_LABEL[tab.kind]}</span>
        {target.name && <span className="min-w-0 truncate">{target.name}</span>}
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {tab.kind === "terminal" ? <TerminalTab target={target} tabId={tab.id} active />
          : tab.kind === "files" ? <FilesTab target={target} tabId={tab.id} path={path} active onPath={setPath} />
          : <ChangesTab target={target} active />}
      </main>
    </div>
  );
}
