/** What a fresh tab shows: the "Tools" list. Picking a tool turns the tab
 * into it. The browser draws this on a blank page; a computer without the
 * browser gets it as its own "newtab" kind. */
import { useState } from "react";
import { Folders, GitCompare, Globe, MessageCirclePlus, MoreHorizontal, SquareDashed, SquareTerminal } from "lucide-react";

import { Menu, anchorOf, type MenuAnchor } from "@/components/workbench/Menu";
import type { TabIcon } from "@/components/workbench/registry";
import { cn } from "@/lib/cn";

/** "blank" is the blank tab: an empty page bos draws whatever you ask into
 * (decks, dashboards, docs; videos hand off to the video editor). It replaced
 * the separate "New page" and "New video" rows in 2.1.9. */
export type NewTabTool = "blank" | "files" | "sidechat" | "terminal" | "terminal-bottom" | "changes" | "bot-browser";

const mac = () => /mac/i.test(globalThis.navigator?.platform ?? "") || globalThis.window?.ogb?.platform === "darwin";

export function Keycap({ keys, className }: { keys: string; className?: string }) {
  return <kbd className={cn("inline-flex h-[22px] shrink-0 items-center rounded-full bg-ink/[.08] px-2 font-sans text-[12px] tracking-wide text-ink/70", className)}>{keys}</kbd>;
}

export function NewTabPage({ onPick, blank = true, changes = false, botBrowser = false, className }: {
  onPick: (tool: NewTabTool) => void;
  /** Whether a blank tab can open (direct conversations, kind registered). */
  blank?: boolean;
  /** bos extras ChatGPT lacks: the git diff and the server browser's live view. */
  changes?: boolean;
  botBrowser?: boolean;
  className?: string;
}) {
  const isMac = mac();
  const [more, setMore] = useState<MenuAnchor | null>(null);
  const rows: { tool: NewTabTool; label: string; icon: TabIcon; keys?: string }[] = [
    ...(blank ? [{ tool: "blank" as const, label: "Blank tab", icon: SquareDashed }] : []),
    { tool: "files", label: "Files", icon: Folders, keys: isMac ? "⌘P" : "Ctrl P" },
    { tool: "sidechat", label: "Side chat", icon: MessageCirclePlus, keys: isMac ? "⌥⌘S" : "Ctrl Alt S" },
    { tool: "terminal", label: "Terminal", icon: SquareTerminal, keys: "⌃`" },
    ...(changes ? [{ tool: "changes" as const, label: "Changes", icon: GitCompare }] : []),
    ...(botBrowser ? [{ tool: "bot-browser" as const, label: "Bot browser", icon: Globe }] : []),
  ];
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto bg-app px-5 pb-6 pt-[42px]", className)} data-testid="new-tab-page">
      <h2 className="mb-4 text-[13px] font-medium text-ink">Tools</h2>
      <div role="list" className="flex flex-col gap-1">
        {rows.map(({ tool, label, icon: Icon, keys }) => (
          <div key={tool} role="listitem" className="group relative">
            <button type="button" onClick={() => onPick(tool)}
              className="flex h-10 w-full items-center gap-2 rounded-lg bg-ink/[.04] pe-2 ps-2.5 text-left text-[14px] text-ink transition-colors duration-150 ease-out hover:bg-ink/[.078] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <Icon size={16} strokeWidth={1.75} className="shrink-0 text-ink/80" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {keys && <Keycap keys={keys} className={tool === "terminal" ? "me-9" : undefined} />}
            </button>
            {tool === "terminal" && (
              <button type="button" aria-label="Terminal options" title="Terminal options"
                onClick={(event) => setMore(anchorOf(event.currentTarget))}
                className="absolute end-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink/70 hover:bg-ink/[.078] hover:text-ink">
                <MoreHorizontal size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {more && (
        <Menu anchor={more} align="end" label="Terminal options" width={232} onClose={() => setMore(null)}
          entries={[{ key: "bottom", label: "Open bottom terminal", shortcut: isMac ? "⌘J" : "Ctrl J", onSelect: () => onPick("terminal-bottom") }]} />
      )}
    </div>
  );
}
