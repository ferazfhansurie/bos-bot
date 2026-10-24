/** The workbench: the tabbed panel beside a conversation. Every tab kind
 * (browser pages aside, which the browser draws itself) is a registered
 * renderer, so a new kind plugs in without touching the host.
 *
 * Adding a kind, e.g. pages:
 *
 *   // src/components/pages/register.tsx
 *   import { FileText } from "lucide-react";
 *   import { registerTabKind } from "@/components/workbench/registry";
 *   registerTabKind({
 *     kind: "page",
 *     title: (tab) => tab.title ?? "Untitled page",
 *     icon: FileText,
 *     render: ({ tab, target, active, setTab }) => <PageEditor pageId={tab.ref} ... onTitle={(title) => setTab({ title })} />,
 *   });
 *
 * then add one `import "@/components/pages/register";` line to
 * src/components/workbench/kinds.ts. The kind id has to be one of
 * WorkspaceTabKind in src/lib/thread-workspace.ts ("page" already is), which
 * is what lets a saved workspace keep the tab across reloads.
 *
 * What a renderer gets (TabRenderProps): its tab (`ref` and `title` are the
 * kind's own to use: a page id, a thread id), the conversation it sits
 * beside, whether it is on screen, and setTab / replace / close to change
 * itself. Renderers are mounted only while their tab is active unless
 * `keepMounted` is set. Registering a kind that already exists replaces it
 * (the placeholder "page" kind is registered this way until pages lands). */
import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type { TerminalTarget } from "@/lib/terminal";
import type { WorkspaceTab, WorkspaceTabKind } from "@/lib/thread-workspace";
import type { Action } from "@/state/store";

export type TabIcon = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>;

export interface TabRenderProps {
  tab: WorkspaceTab;
  target: TerminalTarget;
  active: boolean;
  /** Rename the tab or remember what it shows (a page id, a thread id). */
  setTab: (patch: { title?: string; ref?: string }) => void;
  /** Turn this tab into another kind in the same place (a new tab picking a tool). */
  replace: (kind: WorkspaceTabKind, options?: { ref?: string; title?: string; path?: string; from?: string }) => void;
  close: () => void;
}

export interface TabKindDefinition {
  kind: WorkspaceTabKind;
  /** index/count: this tab's place among open tabs of the same kind, for "Terminal 2". */
  title: (tab: WorkspaceTab, place: { index: number; count: number }) => string;
  icon: TabIcon;
  render: (props: TabRenderProps) => ReactNode;
  keepMounted?: boolean;
  /** Asked in a dialog before the tab closes (a side chat is archived). */
  confirmClose?: { title: string; body: string; confirmLabel: string };
  /** Runs once the tab has closed. */
  onClosed?: (tab: WorkspaceTab, target: TerminalTarget, dispatch: (action: Action) => void) => void;
  /** A stand-in until the real kind registers; tools that create one stay hidden. */
  placeholder?: boolean;
}

const kinds = new Map<WorkspaceTabKind, TabKindDefinition>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Returns an unregister function (restores nothing; the kind is just gone). */
export function registerTabKind(definition: TabKindDefinition): () => void {
  kinds.set(definition.kind, definition);
  changed();
  return () => {
    if (kinds.get(definition.kind) !== definition) return;
    kinds.delete(definition.kind);
    changed();
  };
}

export function tabKind(kind: WorkspaceTabKind): TabKindDefinition | undefined {
  return kinds.get(kind);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Re-render when kinds register (a lazily loaded module adding one). */
export function useTabKinds(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
