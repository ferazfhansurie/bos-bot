import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { WorkspaceProvider } from "@/components/workspace/WorkspaceContext";
import { addSplitPane, loadSplitPanes, parseThreadPane, removeSplitPane, saveSplitPanes, swapIntoPrimary, threadPaneId } from "@/lib/split-view";
import { sameTerminalTarget, type TerminalTarget } from "@/lib/terminal";
import { useStore } from "@/state/store";

interface SplitViewValue {
  panes: string[];
  openSplit: (id: string) => void;
  closeSplit: (id: string) => void;
  /** Make a pane the main conversation; the old main one takes its place. */
  promoteSplit: (id: string) => void;
  /** The terminal pane, if open. Not persisted: a reload must not spawn a shell. */
  terminal: TerminalTarget | null;
  toggleTerminal: (target: TerminalTarget) => void;
  closeTerminal: () => void;
}

// Without a provider (isolated component tests) splitting is a no-op.
const SplitViewContext = createContext<SplitViewValue>({ panes: [], openSplit: () => {}, closeSplit: () => {}, promoteSplit: () => {}, terminal: null, toggleTerminal: () => {}, closeTerminal: () => {} });

export function useSplitView(): SplitViewValue {
  return useContext(SplitViewContext);
}

export function SplitViewProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;
  const [panes, setPanes] = useState<string[]>(() => loadSplitPanes());
  const primaryBot = state.bots.find((bot) => bot.id === state.selectedId);
  const primaryId = primaryBot ? threadPaneId(primaryBot.id, primaryBot.threadId) : state.selectedId;
  const selectedRef = useRef(primaryId);
  useEffect(() => saveSplitPanes(panes), [panes]);
  // Picking a conversation that already has a pane trades places with the
  // old primary rather than showing it twice.
  useEffect(() => {
    const previous = selectedRef.current;
    selectedRef.current = primaryId;
    if (previous !== primaryId) setPanes((current) => swapIntoPrimary(current.map((pane) => {
      const bot = stateRef.current.bots.find((candidate) => candidate.id === pane);
      return bot ? threadPaneId(bot.id, bot.threadId) : pane;
    }), primaryId, previous));
  }, [primaryId]);
  const openSplit = useCallback((id: string) => setPanes((current) => {
    // Pin the conversation dropped, rather than following subsequent changes
    // to that bot's primary thread in another column.
    const snapshot = stateRef.current;
    const pin = (pane: string) => {
      const bot = snapshot.bots.find((candidate) => candidate.id === pane);
      return bot ? threadPaneId(bot.id, bot.threadId) : pane;
    };
    const selected = snapshot.bots.find((bot) => bot.id === snapshot.selectedId);
    const primary = selected ? threadPaneId(selected.id, selected.threadId) : snapshot.selectedId;
    return addSplitPane(current.map(pin), pin(id), primary);
  }), []);
  const closeSplit = useCallback((id: string) => {
    setPanes((current) => removeSplitPane(current, id));
    const thread = parseThreadPane(id);
    if (thread) dispatch({ type: "threadPaneClose", threadId: thread.threadId });
  }, [dispatch]);
  const promoteSplit = useCallback((id: string) => {
    const current = stateRef.current;
    const previousId = current.selectedId;
    const previousBot = current.bots.find((bot) => bot.id === previousId);
    const thread = parseThreadPane(id);
    const botId = thread?.botId ?? id;
    const bot = current.bots.find((candidate) => candidate.id === botId);
    // The old main conversation keeps its column: the same bot's thread it
    // was on, or the bot or room it was.
    const replacement = previousBot && previousBot.id === botId ? threadPaneId(botId, previousBot.threadId) : previousId;
    setPanes((panes) => panes.map((pane) => (pane === id ? replacement : pane)).filter((pane, index, all) => pane && all.indexOf(pane) === index));
    if (thread && bot && thread.threadId !== bot.threadId) {
      dispatch({ type: "threadPaneClose", threadId: thread.threadId });
      dispatch({ type: "switchTask", botId, threadId: thread.threadId });
    } else dispatch({ type: "select", id: botId });
  }, [dispatch]);
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  // The header button toggles its own thread's terminal; from another
  // thread it moves the one terminal pane there.
  const toggleTerminal = useCallback((target: TerminalTarget) => setTerminal((current) => (sameTerminalTarget(current, target) ? null : target)), []);
  const closeTerminal = useCallback(() => setTerminal(null), []);
  const value = useMemo(() => ({ panes, openSplit, closeSplit, promoteSplit, terminal, toggleTerminal, closeTerminal }), [panes, openSplit, closeSplit, promoteSplit, terminal, toggleTerminal, closeTerminal]);
  return <SplitViewContext.Provider value={value}><WorkspaceProvider>{children}</WorkspaceProvider></SplitViewContext.Provider>;
}
