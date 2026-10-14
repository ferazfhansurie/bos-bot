import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Columns2, Maximize2, X } from "lucide-react";

import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { WorkspaceBottomPane, WorkspaceOverlays, WorkspaceRightPane } from "@/components/workspace/WorkspaceDock";
import { t } from "@/lib/i18n";
import { SPLIT_DRAG_TYPE, clampPaneShare, loadPaneShare, parseThreadPane, paneOwnerId, savePaneShare, shareFromPointer, visibleSplitPanes } from "@/lib/split-view";
import { useSplitView } from "@/components/SplitViewContext";
import { startResizeDrag } from "@/lib/resize-drag";
import { cn } from "@/lib/cn";
import { botForThread, useStore, type Bot } from "@/state/store";

/** True while a sidebar bot or room row is being dragged. */
function useSplitDragActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const start = (event: DragEvent) => {
      // Thread rows stop bubbling after writing their drag payload. Inspect
      // after the target handler, while observing dragstart in capture phase.
      queueMicrotask(() => {
        if (event.dataTransfer?.types.includes(SPLIT_DRAG_TYPE)) setActive(true);
      });
    };
    const stop = () => setActive(false);
    window.addEventListener("dragstart", start, true);
    window.addEventListener("blur", stop);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragstart", start, true);
      window.removeEventListener("blur", stop);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  return active;
}

/** One of a bot's other threads beside the main one: loads its page once,
 * then streams through the store like the live thread does. */
function ThreadPaneView({ bot, threadId }: { bot: Bot; threadId: string }) {
  const { state, dispatch } = useStore();
  const pane = state.threadPanes[threadId];
  const live = bot.threadId === threadId;
  useEffect(() => {
    if (!live && !pane) dispatch({ type: "threadPaneOpen", botId: bot.id, threadId });
  }, [live, pane, bot.id, threadId, dispatch]);
  return <ChatView key={threadId} bot={botForThread(bot, threadId, pane)} />;
}

/** The chat column: the primary conversation plus any split panes, and a
 * right-edge drop target while a sidebar row is dragged. */
export function SplitWorkspace({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { panes, openSplit, closeSplit, promoteSplit } = useSplitView();
  const dragging = useSplitDragActive();
  const [over, setOver] = useState(false);
  useEffect(() => { if (!dragging) setOver(false); }, [dragging]);
  const known = useMemo(() => new Set([...state.bots.filter((bot) => !bot.hidden).map((bot) => bot.id), ...state.groups.map((group) => group.id)]), [state.bots, state.groups]);
  const extras = visibleSplitPanes(panes, known, state.selectedId, (botId) => state.bots.find((bot) => bot.id === botId)?.threadId);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [storedShare, setStoredShare] = useState(() => loadPaneShare());
  const [resizing, setResizing] = useState(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  const paneLayout = extras.join("|");
  useEffect(() => () => { cancelDrag.current?.(); }, [paneLayout]);
  const share = clampPaneShare(storedShare, extras.length);
  const columnRef = useRef<HTMLDivElement>(null);
  // Dragging the divider left of a pane resizes every extra pane to the same
  // share; the width is remembered across reloads.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    const workspace = columnRef.current;
    if (event.button !== 0 || !workspace) return;
    event.preventDefault();
    const handle = event.currentTarget;
    cancelDrag.current?.();
    setResizing(true);
    const panesToRight = extras.length - 1 - index;
    const original = storedShare;
    let latest = share;
    cancelDrag.current = startResizeDrag({
      handle, pointerId: event.pointerId, cursor: "col-resize",
      move: (moveEvent) => {
        const rect = workspace.getBoundingClientRect();
        latest = clampPaneShare(shareFromPointer(moveEvent.clientX, rect.left, rect.width, panesToRight, share), extras.length);
        setStoredShare(latest);
      },
      end: (cancelled) => {
        cancelDrag.current = null;
        setResizing(false);
        if (cancelled) setStoredShare(original);
        else savePaneShare(latest);
      },
    });
  };
  const resetWidth = () => {
    const next = clampPaneShare(Number.NaN, extras.length);
    setStoredShare(next);
    savePaneShare(next);
  };

  return (
    <div ref={workspaceRef} className={cn("relative flex h-full min-w-0 flex-1", resizing && "cursor-col-resize select-none")} data-testid="split-workspace">
      <div ref={columnRef} className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className={cn("flex h-full min-w-0 flex-1", resizing && "pointer-events-none")}>{children}</div>
          {extras.map((id, index) => {
            const thread = parseThreadPane(id);
            const group = thread ? undefined : state.groups.find((candidate) => candidate.id === id);
            const bot = group ? undefined : state.bots.find((candidate) => candidate.id === paneOwnerId(id));
            const title = thread ? bot?.tasks?.find((task) => task.threadId === thread.threadId)?.title : undefined;
            const name = group?.name ?? (title ? `${bot?.name ?? ""} · ${title}` : bot?.name) ?? "";
            return (
              <section key={id} aria-label={t("split.pane", { name })} data-split-pane={id} style={{ flex: `0 0 ${share * 100}%` }}
                className={cn("relative flex h-full min-w-0 border-l border-hairline/50 max-md:hidden", resizing && "pointer-events-none")}>
                {/* drag to resize; double-click puts the width back */}
                <div role="separator" aria-orientation="vertical" aria-label={t("split.resize")} data-testid="split-resize-handle"
                  onPointerDown={(event) => startResize(event, index)} onDoubleClick={resetWidth}
                  className="pointer-events-auto touch-none absolute -left-[3px] inset-y-0 z-30 w-[6px] cursor-col-resize transition-colors hover:bg-hairline" />
                {group ? <GroupView key={group.id} group={group} /> : bot && thread ? <ThreadPaneView key={id} bot={bot} threadId={thread.threadId} /> : bot ? <ChatView key={bot.id} bot={bot} /> : null}
                {/* sits in the header's left gutter, level with the avatar */}
                <button type="button" onClick={() => closeSplit(id)} title={t("split.close")} aria-label={t("split.closeNamed", { name })}
                  className="absolute left-1.5 top-[26px] z-20 flex size-5 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"><X size={12} /></button>
                <button type="button" onClick={() => promoteSplit(id)} title={t("split.expand")} aria-label={t("split.expandNamed", { name })}
                  className="absolute left-1.5 top-[48px] z-20 flex size-5 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"><Maximize2 size={11} /></button>
              </section>
            );
          })}
        </div>
        <WorkspaceBottomPane containerRef={columnRef} />
      </div>
      <WorkspaceRightPane containerRef={workspaceRef} />
      <WorkspaceOverlays />
      {dragging && (
        <div
          data-testid="split-drop-zone"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(SPLIT_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            const id = event.dataTransfer.getData(SPLIT_DRAG_TYPE);
            if (!id) return;
            event.preventDefault();
            openSplit(id);
          }}
          className={cn(
            "absolute inset-y-2 right-2 z-30 flex w-[min(33%,320px)] items-center justify-center rounded-xl border-2 border-dashed text-[13px] transition-colors max-md:hidden",
            over ? "border-ink-secondary/60 bg-raised/60 text-ink" : "border-hairline/70 bg-app/70 text-ink-secondary",
          )}
        >
          <span className="pointer-events-none flex items-center gap-2"><Columns2 size={16} />{t("split.drop")}</span>
        </div>
      )}
    </div>
  );
}
