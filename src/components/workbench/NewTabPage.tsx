/** What a fresh tab shows: the "Tools" list. Picking a tool turns the tab
 * into it. The browser draws this on a blank page; a computer without the
 * browser gets it as its own "newtab" kind. */
import { Fragment, useState } from "react";
import { Folders, GitCompare, Globe, LayoutTemplate, MessageCirclePlus, MoreHorizontal, Pencil, PinOff, Plus, SquareDashed, SquareTerminal, Trash2 } from "lucide-react";

import { Menu, anchorOf, type MenuAnchor } from "@/components/workbench/Menu";
import type { TabIcon } from "@/components/workbench/registry";
import { cn } from "@/lib/cn";
import { appIcon } from "@/components/canvas/app-icons";

/** "blank" is the blank tab: an empty page bos draws whatever you ask into
 * (decks, dashboards, docs; videos hand off to the video editor). It replaced
 * the separate "New page" and "New video" rows in 2.1.9. */
export type NewTabTool = "blank" | "files" | "sidechat" | "terminal" | "terminal-bottom" | "changes" | "bot-browser";

const mac = () => /mac/i.test(globalThis.navigator?.platform ?? "") || globalThis.window?.ogb?.platform === "darwin";

export function Keycap({ keys, className }: { keys: string; className?: string }) {
  return <kbd className={cn("inline-flex h-[22px] shrink-0 items-center rounded-full bg-ink/[.08] px-2 font-sans text-[12px] tracking-wide text-ink/70", className)}>{keys}</kbd>;
}

/** A page bos made, as the new tab lists it: its pin, or a choice to pin. */
export interface NewTabPinned { key: string; title: string }

/** Pages pinned into the Tools list, and the chooser that adds more. */
export interface NewTabPins {
  pinned: NewTabPinned[];
  open: (key: string) => void;
  unpin: (key: string) => void;
  /** The pages that can be pinned (not already pinned), newest first. */
  choices: () => Promise<NewTabPinned[]>;
  pin: (choice: NewTabPinned) => void;
}

/** Apps (pages with their own data) the new tab lists under Blank tab. */
export interface NewTabApps {
  apps: { id: string; name: string; icon?: string }[];
  open: (id: string) => void;
  rename?: (id: string, name: string) => Promise<void>;
  /** Deletes the app and its records; the page file stays in Files. */
  remove?: (id: string) => Promise<void>;
}

export function NewTabPage({ onPick, blank = true, changes = false, botBrowser = false, pins, apps, className }: {
  onPick: (tool: NewTabTool) => void;
  /** This conversation's apps, or a room's shared ones. */
  apps?: NewTabApps;
  /** Pinned pages; absent where blank tabs can't open. */
  pins?: NewTabPins;
  /** Whether a blank tab can open (direct conversations, kind registered). */
  blank?: boolean;
  /** bos extras ChatGPT lacks: the git diff and the server browser's live view. */
  changes?: boolean;
  botBrowser?: boolean;
  className?: string;
}) {
  const isMac = mac();
  const [more, setMore] = useState<MenuAnchor | null>(null);
  const [appMenu, setAppMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const saveRename = () => {
    const next = renaming;
    setRenaming(null);
    const was = apps?.apps.find(a => a.id === next?.id)?.name;
    if (next && next.name.trim() && next.name.trim() !== was) void apps?.rename?.(next.id, next.name.trim()).catch(() => undefined);
  };
  const [adding, setAdding] = useState<{ anchor: MenuAnchor; choices: NewTabPinned[] | null } | null>(null);
  const choose = (anchor: MenuAnchor) => {
    if (!pins) return;
    setAdding({ anchor, choices: null });
    pins.choices().then(choices => setAdding(a => a && { ...a, choices }), () => setAdding(a => a && { ...a, choices: [] }));
  };
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
          <Fragment key={tool}>
            <div role="listitem" className="group relative">
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
            {tool === "blank" && apps?.apps.slice(0, 12).map(app => {
              const AppIcon = appIcon(app.icon);
              return (
                <div key={app.id} role="listitem" className="group/app relative" data-testid="new-tab-app">
                  {renaming?.id === app.id ? (
                    <form onSubmit={event => { event.preventDefault(); saveRename(); }}
                      className="flex h-10 w-full items-center gap-2 rounded-lg bg-ink/[.078] pe-2 ps-2.5 text-[14px] text-ink">
                      <AppIcon size={16} strokeWidth={1.75} className="shrink-0 text-ink/80" />
                      <input autoFocus aria-label="App name" maxLength={60} value={renaming.name}
                        onFocus={event => event.currentTarget.select()} onChange={event => setRenaming({ id: app.id, name: event.target.value })}
                        onBlur={saveRename} onKeyDown={event => { if (event.key === "Escape") setRenaming(null); }}
                        className="min-w-0 flex-1 bg-transparent outline-none" />
                    </form>
                  ) : (
                    <button type="button" onClick={() => apps.open(app.id)} title={app.name}
                      className={cn("flex h-10 w-full items-center gap-2 rounded-lg bg-ink/[.04] ps-2.5 text-left text-[14px] text-ink transition-colors duration-150 ease-out hover:bg-ink/[.078] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent", apps.rename || apps.remove ? "pe-10" : "pe-2")}>
                      <AppIcon size={16} strokeWidth={1.75} className="shrink-0 text-ink/80" />
                      <span className="min-w-0 flex-1 truncate">{app.name}</span>
                    </button>
                  )}
                  {(apps.rename || apps.remove) && renaming?.id !== app.id && (
                    <button type="button" aria-label={`${app.name} options`} title="Rename or delete"
                      onClick={event => setAppMenu({ id: app.id, anchor: anchorOf(event.currentTarget) })}
                      className={cn("absolute end-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink/60 transition-opacity hover:bg-ink/[.078] hover:text-ink focus-visible:opacity-100 group-hover/app:opacity-100", appMenu?.id === app.id ? "opacity-100" : "opacity-0")}>
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </div>
              );
            })}
            {tool === "blank" && pins?.pinned.map(page => (
              <div key={page.key} role="listitem" className="group/pin relative" data-testid="new-tab-pinned">
                <button type="button" onClick={() => pins.open(page.key)} title={page.title}
                  className="flex h-10 w-full items-center gap-2 rounded-lg bg-ink/[.04] pe-10 ps-2.5 text-left text-[14px] text-ink transition-colors duration-150 ease-out hover:bg-ink/[.078] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                  <LayoutTemplate size={16} strokeWidth={1.75} className="shrink-0 text-ink/80" />
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                </button>
                <button type="button" aria-label={`Unpin ${page.title}`} title="Unpin" onClick={() => pins.unpin(page.key)}
                  className="absolute end-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink/60 opacity-0 transition-opacity hover:bg-ink/[.078] hover:text-ink focus-visible:opacity-100 group-hover/pin:opacity-100">
                  <PinOff size={15} />
                </button>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      {pins && (
        <button type="button" onClick={(event) => choose(anchorOf(event.currentTarget))} data-testid="new-tab-add-pin"
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ink/60 transition-colors hover:bg-ink/[.06] hover:text-ink">
          <Plus size={15} />Add a tab you made
        </button>
      )}
      {adding && pins && (
        <Menu anchor={adding.anchor} label="Add a tab you made" width={300} onClose={() => setAdding(null)}
          entries={adding.choices === null ? [{ key: "loading", label: "Loading…", disabled: true, onSelect: () => undefined }]
            : adding.choices.length === 0 ? [{ key: "none", label: "No other pages yet. Ask bos to make one.", disabled: true, onSelect: () => undefined }]
            : adding.choices.slice(0, 40).map(choice => ({ key: choice.key, label: choice.title, icon: LayoutTemplate, onSelect: () => pins.pin(choice) }))} />
      )}
      {appMenu && apps && (() => {
        const app = apps.apps.find(a => a.id === appMenu.id);
        if (!app) return null;
        return (
          <Menu anchor={appMenu.anchor} align="end" label={`${app.name} options`} width={220} onClose={() => setAppMenu(null)}
            entries={[
              ...apps.rename ? [{ key: "rename", label: "Rename", icon: Pencil, onSelect: () => setRenaming({ id: app.id, name: app.name }) }] : [],
              ...apps.remove ? [{ key: "delete", label: "Delete app and its data", icon: Trash2, danger: true, onSelect: () => {
                if (window.confirm(`Delete ${app.name} and all its data? The page file stays in Files.`)) void apps.remove?.(app.id).catch(() => undefined);
              } }] : [],
            ]} />
        );
      })()}
      {more && (
        <Menu anchor={more} align="end" label="Terminal options" width={232} onClose={() => setMore(null)}
          entries={[{ key: "bottom", label: "Open bottom terminal", shortcut: isMac ? "⌘J" : "Ctrl J", onSelect: () => onPick("terminal-bottom") }]} />
      )}
    </div>
  );
}
