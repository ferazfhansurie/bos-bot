/**
 * Keyboard shortcuts catalog and platform-specific key resolution.
 * Provides structured shortcut groups for navigation, chat, and workspace management.
 */
import { WORKSPACE_SHORTCUTS } from "@/lib/workspace-commands";

/** Single keyboard shortcut entry with descriptions and platform-specific keys. */
export interface ShortcutItem {
  /** Stable identifier for the shortcut. */
  id: string;
  /** Human-readable explanation of what the shortcut does. */
  description: string;
  /** Keys displayed on macOS (e.g. ["⌘", "K"]). */
  macKeys: string[];
  /** Keys displayed on Windows and Linux (e.g. ["Ctrl", "K"]). */
  winKeys: string[];
}

/** Group of related shortcuts displayed under a section heading. */
export interface ShortcutGroup {
  /** Category display name (e.g. "Navigation"). */
  category: string;
  /** List of shortcuts belonging to this group. */
  items: ShortcutItem[];
}

/**
 * Complete catalog of keyboard shortcuts available in BOS Bot,
 * organized logically into categories for quick reference.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Navigation",
    items: [
      {
        id: "command-palette",
        description: "Open command palette (switcher & transcript search)",
        macKeys: ["⌘", "K"],
        winKeys: ["Ctrl", "K"],
      },
      {
        id: "new-bot",
        description: "Create a new bot",
        macKeys: ["⌘", "N"],
        winKeys: ["Ctrl", "N"],
      },
      {
        id: "jump-bot",
        description: "Jump to bot 1–9 in the roster",
        macKeys: ["⌘", "1–9"],
        winKeys: ["Ctrl", "1–9"],
      },
      {
        id: "next-needing-you",
        description: "next thread needing you: approvals and questions, then unread",
        macKeys: ["⌘", "⇧", "U"],
        winKeys: ["Ctrl", "Shift", "U"],
      },
      {
        id: "switch-bot",
        description: "Switch to previous / next bot",
        macKeys: ["⌘", "⇧", "[ / ]"],
        winKeys: ["Ctrl", "Shift", "[ / ]"],
      },
      {
        id: "find-conversation",
        description: "Find in conversation",
        macKeys: ["⌘", "F"],
        winKeys: ["Ctrl", "F"],
      },
    ],
  },
  {
    category: "Chat & Composer",
    items: [
      {
        id: "send-message",
        description: "Send message",
        macKeys: ["Return"],
        winKeys: ["Enter"],
      },
      {
        id: "send-block",
        description: "Send now, interrupting the running turn",
        macKeys: ["⌥", "Return"],
        winKeys: ["Alt", "Enter"],
      },
      {
        id: "new-line",
        description: "Insert new line without sending",
        macKeys: ["⇧", "Return"],
        winKeys: ["Shift", "Enter"],
      },
      {
        id: "edit-last-message",
        description: "Edit last message (when composer is empty)",
        macKeys: ["↑"],
        winKeys: ["↑"],
      },
      {
        id: "close-panel",
        description: "Close active drawer, modal, or find bar",
        macKeys: ["Esc"],
        winKeys: ["Esc"],
      },
      {
        id: "shortcuts-cheat-sheet",
        description: "Show keyboard shortcuts cheat sheet",
        macKeys: ["⌘", "/"],
        winKeys: ["Ctrl", "/"],
      },
    ],
  },
  {
    category: "Management & Groups",
    items: [
      {
        id: "save-bulletin",
        description: "Save group instruction changes",
        macKeys: ["⌘", "Return"],
        winKeys: ["Ctrl", "Enter"],
      },
      {
        id: "reorder-section",
        description: "Reorder sidebar sections (focus a section heading)",
        macKeys: ["⌥", "↑ / ↓"],
        winKeys: ["Alt", "↑ / ↓"],
      },
    ],
  },
  // read from the workspace command registry, so the sheet never drifts from the keys
  { category: "Workspace", items: WORKSPACE_SHORTCUTS },
];

/** Help chords must not interrupt editing, composition, or another dialog. */
export function shouldOpenKeyboardShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const helpKey = event.key === "?" && !event.metaKey && !event.ctrlKey;
  const helpChord = event.key === "/" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (!helpKey && !helpChord) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, dialog, [role=dialog]")
  ));
}

/**
 * Detect whether the current host platform is macOS.
 * Checks Electron's window.ogb bridge first, falling back to navigator.userAgent.
 */
export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.ogb?.platform) {
    return window.ogb.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

/**
 * Resolve the appropriate key representation for a shortcut item based on the host OS.
 */
export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return isMac ? item.macKeys : item.winKeys;
}

/**
 * Filter shortcut groups by query matching item descriptions or keys.
 */
export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  isMac: boolean = isMacPlatform(),
): ShortcutGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...groups];

  return groups
    .map((group) => {
      const filteredItems = group.items.filter((item) => {
        const keys = shortcutKeysForPlatform(item, isMac).join(" ").toLowerCase();
        return (
          item.description.toLowerCase().includes(normalized) ||
          group.category.toLowerCase().includes(normalized) ||
          keys.includes(normalized)
        );
      });
      return { ...group, items: filteredItems };
    })
    .filter((group) => group.items.length > 0);
}
