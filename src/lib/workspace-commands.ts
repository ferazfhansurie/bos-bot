/** The thread workspace's commands, in one list: the global key handler,
 * the ⌘K palette and the shortcuts sheet all read it, so a binding is
 * changed in exactly one place. Running a command is a window event the
 * workspace provider listens for; nothing here knows about React. */
import { FileSearch, FolderTree, GitCompare, Globe, History, Maximize2, MessageSquarePlus, PanelBottom, PanelRight, Plus, SquareTerminal, type LucideIcon } from "lucide-react";

export type WorkspaceCommandId =
  | "workspace-layout"
  | "workspace-terminal"
  | "workspace-bottom"
  | "workspace-files"
  | "workspace-file-search"
  | "workspace-reopen"
  | "workspace-changes"
  | "workspace-browser"
  | "workspace-full"
  | "workspace-sidechat"
  | "workspace-new-tab";

export interface WorkspaceCommand {
  id: WorkspaceCommandId;
  label: string;
  keywords: string;
  icon: LucideIcon;
  macKeys?: string[];
  winKeys?: string[];
  /** ⌘ on macOS, Ctrl elsewhere, unless the binding says otherwise. */
  match?: (event: KeyboardEvent, mac: boolean) => boolean;
}

type Chord = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "code">;
/** Physical keys, so a non-latin keyboard layout still triggers them. */
const mod = (event: Chord, mac: boolean, code: string, shift: boolean) =>
  event.code === code && !event.altKey && event.shiftKey === shift &&
  (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

export const WORKSPACE_COMMANDS: readonly WorkspaceCommand[] = [
  { id: "workspace-layout", label: "hide tabs", keywords: "panel split show hide tools side tabs", icon: PanelRight,
    macKeys: ["⌘", "⇧", "B"], winKeys: ["Ctrl", "Shift", "B"], match: (e, mac) => mod(e, mac, "KeyB", true) },
  { id: "workspace-full", label: "full view", keywords: "panel expand full maximise tabs", icon: Maximize2,
    macKeys: ["⌘", "⇧", "F"], winKeys: ["Ctrl", "Shift", "F"], match: (e, mac) => mod(e, mac, "KeyF", true) },
  { id: "workspace-sidechat", label: "new side chat", keywords: "side chat thread conversation aside", icon: MessageSquarePlus,
    macKeys: ["⌥", "⌘", "S"], winKeys: ["Ctrl", "Alt", "S"],
    match: (e, mac) => e.code === "KeyS" && e.altKey && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) },
  { id: "workspace-new-tab", label: "new tab", keywords: "tab browser tools new", icon: Plus },
  { id: "workspace-terminal", label: "terminal", keywords: "shell console command line pty", icon: SquareTerminal,
    macKeys: ["⌃", "`"], winKeys: ["Ctrl", "`"],
    match: (e) => e.code === "Backquote" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey },
  { id: "workspace-bottom", label: "toggle bottom panel", keywords: "panel bottom dock terminal", icon: PanelBottom,
    macKeys: ["⌘", "J"], winKeys: ["Ctrl", "J"], match: (e, mac) => mod(e, mac, "KeyJ", false) },
  { id: "workspace-files", label: "files", keywords: "explorer tree folder browse", icon: FolderTree,
    macKeys: ["⌘", "⇧", "E"], winKeys: ["Ctrl", "Shift", "E"], match: (e, mac) => mod(e, mac, "KeyE", true) },
  { id: "workspace-file-search", label: "go to file", keywords: "open file quick find fuzzy search", icon: FileSearch,
    macKeys: ["⌘", "P"], winKeys: ["Ctrl", "P"], match: (e, mac) => mod(e, mac, "KeyP", false) },
  { id: "workspace-reopen", label: "reopen closed tab", keywords: "undo close restore tab", icon: History,
    macKeys: ["⌘", "⇧", "T"], winKeys: ["Ctrl", "Shift", "T"], match: (e, mac) => mod(e, mac, "KeyT", true) },
  { id: "workspace-changes", label: "changes", keywords: "git diff uncommitted revert review", icon: GitCompare },
  { id: "workspace-browser", label: "browser", keywords: "web page tab internet", icon: Globe },
];

export const WORKSPACE_COMMAND_EVENT = "bos-workspace-command";

export function runWorkspaceCommand(id: WorkspaceCommandId): void {
  window.dispatchEvent(new CustomEvent<WorkspaceCommandId>(WORKSPACE_COMMAND_EVENT, { detail: id }));
}

export function workspaceCommandForEvent(event: KeyboardEvent, mac: boolean): WorkspaceCommand | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat) return undefined;
  return WORKSPACE_COMMANDS.find((command) => command.match?.(event, mac));
}

/** Rows for the shortcuts sheet: only commands that have a binding. */
export const WORKSPACE_SHORTCUTS = WORKSPACE_COMMANDS.filter((command) => command.macKeys && command.winKeys)
  .map((command) => ({ id: command.id, description: command.label, macKeys: command.macKeys!, winKeys: command.winKeys! }));
