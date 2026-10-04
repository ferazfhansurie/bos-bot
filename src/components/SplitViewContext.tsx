import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { addSplitPane, loadSplitPanes, removeSplitPane, saveSplitPanes, swapIntoPrimary } from "@/lib/split-view";
import { useStore } from "@/state/store";

interface SplitViewValue {
  panes: string[];
  openSplit: (id: string) => void;
  closeSplit: (id: string) => void;
}

// Without a provider (isolated component tests) splitting is a no-op.
const SplitViewContext = createContext<SplitViewValue>({ panes: [], openSplit: () => {}, closeSplit: () => {} });

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
  const value = useMemo(() => ({ panes, openSplit, closeSplit }), [panes, openSplit, closeSplit]);
  return <SplitViewContext.Provider value={value}>{children}</SplitViewContext.Provider>;
}
