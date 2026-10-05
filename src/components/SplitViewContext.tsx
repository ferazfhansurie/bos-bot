import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { addSplitPane, loadSplitPanes, removeSplitPane, saveSplitPanes, swapIntoPrimary } from "@/lib/split-view";
import { sameTerminalTarget, type TerminalTarget } from "@/lib/terminal";
import { useStore } from "@/state/store";

interface SplitViewValue {
  panes: string[];
  openSplit: (id: string) => void;
  closeSplit: (id: string) => void;
  /** The terminal pane, if open. Not persisted: a reload must not spawn a shell. */
  terminal: TerminalTarget | null;
  toggleTerminal: (target: TerminalTarget) => void;
  closeTerminal: () => void;
}

// Without a provider (isolated component tests) splitting is a no-op.
const SplitViewContext = createContext<SplitViewValue>({ panes: [], openSplit: () => {}, closeSplit: () => {}, terminal: null, toggleTerminal: () => {}, closeTerminal: () => {} });

export function useSplitView(): SplitViewValue {
  return useContext(SplitViewContext);
}

export function SplitViewProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const [panes, setPanes] = useState<string[]>(() => loadSplitPanes());
  const selectedRef = useRef(state.selectedId);
  useEffect(() => saveSplitPanes(panes), [panes]);
  // Picking a conversation that already has a pane trades places with the
  // old primary rather than showing it twice.
  useEffect(() => {
    const previous = selectedRef.current;
    selectedRef.current = state.selectedId;
    if (previous !== state.selectedId) setPanes((current) => swapIntoPrimary(current, state.selectedId, previous));
  }, [state.selectedId]);
  const openSplit = useCallback((id: string) => setPanes((current) => addSplitPane(current, id, selectedRef.current)), []);
  const closeSplit = useCallback((id: string) => setPanes((current) => removeSplitPane(current, id)), []);
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  // The header button toggles its own thread's terminal; from another
  // thread it moves the one terminal pane there.
  const toggleTerminal = useCallback((target: TerminalTarget) => setTerminal((current) => (sameTerminalTarget(current, target) ? null : target)), []);
  const closeTerminal = useCallback(() => setTerminal(null), []);
  const value = useMemo(() => ({ panes, openSplit, closeSplit, terminal, toggleTerminal, closeTerminal }), [panes, openSplit, closeSplit, terminal, toggleTerminal, closeTerminal]);
  return <SplitViewContext.Provider value={value}>{children}</SplitViewContext.Provider>;
}
